// Media is paid content, so it is never public: every fetch needs an expiring signature.
// The creator's own studio and the assistant's delivery links both ask /sign for one.

const enc = new TextEncoder();

export async function sign(key, exp, secret) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret || "dev"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", k, enc.encode(key + "|" + exp));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export function timingSafe(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
