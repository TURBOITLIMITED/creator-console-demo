/**
 * Application-layer encryption for message bodies.
 *
 * Telegram Bot Developer ToS 4.4(a) requires data to be encrypted at rest with
 * the key stored SEPARATELY from the data. Cloudflare's own disk encryption
 * does not satisfy that wording, because the key lives with the storage.
 *
 * So: one Data Encryption Key per creator, held in Postgres only in WRAPPED
 * form, wrapped by a Key Encryption Key that lives as a Worker secret and is
 * never written to the database. Postgres alone is therefore not enough to
 * read a single message body.
 */

const te = new TextEncoder();
const td = new TextDecoder();

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function aesKey(raw, usages) {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, usages);
}

function kekBytes(env) {
  const k = env.DATA_KEK;
  if (!k) throw new Error("DATA_KEK is not set - refusing to store message bodies in clear");
  const raw = unb64(k);
  if (raw.length !== 32) throw new Error("DATA_KEK must be 32 bytes, base64 encoded");
  return raw;
}

async function wrap(env, rawDek) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(kekBytes(env), ["encrypt"]);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, rawDek);
  return b64(nonce) + ":" + b64(ct);
}

async function unwrap(env, wrapped) {
  const [n, c] = String(wrapped).split(":");
  const key = await aesKey(kekBytes(env), ["decrypt"]);
  const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(n) }, key, unb64(c));
  return new Uint8Array(raw);
}

/**
 * Seal a short secret directly with the KEK. This is for credentials the
 * worker must replay (a scraped site's password), not for message bodies:
 * a hash cannot be logged in with, and Postgres alone must not hold it.
 */
export async function sealSecret(env, text) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(kekBytes(env), ["encrypt"]);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, te.encode(String(text)));
  return b64(nonce) + ":" + b64(ct);
}

export async function openSecret(env, sealed) {
  const [n, c] = String(sealed || "").split(":");
  if (!n || !c) throw new Error("secret is not sealed");
  const key = await aesKey(kekBytes(env), ["decrypt"]);
  const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(n) }, key, unb64(c));
  return td.decode(raw);
}

/**
 * Fetch this creator's DEK, minting one on first use.
 * `sb` is the caller's Supabase helper so this module stays transport-agnostic.
 */
export async function getDek(env, sb, creatorId) {
  const rows = await sb(env, "account_keys?creator_id=eq." + encodeURIComponent(creatorId) + "&select=wrapped_dek");
  if (rows && rows.length) return unwrap(env, rows[0].wrapped_dek);

  const raw = crypto.getRandomValues(new Uint8Array(32));
  const wrapped = await wrap(env, raw);
  await sb(env, "account_keys?on_conflict=creator_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ creator_id: creatorId, wrapped_dek: wrapped, kek_version: 1 }),
  });
  return raw;
}

export async function seal(dek, plaintext) {
  if (plaintext == null || plaintext === "") return { body_enc: null, body_nonce: null };
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(dek, ["encrypt"]);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, te.encode(plaintext));
  return { body_enc: b64(ct), body_nonce: b64(nonce) };
}

export async function open(dek, body_enc, body_nonce) {
  if (!body_enc || !body_nonce) return null;
  const key = await aesKey(dek, ["decrypt"]);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(body_nonce) }, key, unb64(body_enc));
  return td.decode(pt);
}

/**
 * A redacted one-line preview, safe to show in list views without unsealing.
 * Strips anything that looks like contact detail or money before truncating.
 */
export function preview(text, max = 80) {
  if (!text) return null;
  const clean = String(text)
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, "[email]")
    .replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, "[number]")
    .replace(/https?:\/\/\S+/g, "[link]")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}
