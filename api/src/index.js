// Creator CRM API: content, prices and style for a creator, stored in KV, media in R2.
// Auth: a Supabase session (console admin), or the operator token, in the
// Authorization header only. Query-string tokens and creator tokens were removed
// on 2026-10-20.
const CORS = (o) => ({
  "Access-Control-Allow-Origin": o || "*",
  "Access-Control-Allow-Methods": "GET,PUT,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type,X-Filename",
  "Access-Control-Max-Age": "86400",
});

const json = (data, status = 200, origin) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Vary": "Authorization", ...CORS(origin) },
  });

import { sign, timingSafe } from "./media.js";
import { handleWebhook } from "./tg.js";
import * as tgapi from "./telegram.js";
import { validateBotAnswer, DEFAULT_BOT_ANSWERS, EXPLICIT_BOT_ANSWER } from "./persona.js";

// Creator records live in Supabase Postgres: one row per creator, the full record in jsonb,
// plus the summary columns the console and roster read. Media stays in R2.
const sbHeaders = (env) => ({
  apikey: env.SUPABASE_SERVICE_KEY,
  Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY,
  "Content-Type": "application/json",
});

// a signed in console admin: their Supabase token, verified, then checked against
// the console admin predicate. FAILS CLOSED: a token is only "ok" when Supabase
// accepts it AND is_console_admin() returns true for THAT user. A string that
// merely looks like a JWT (three dot-separated parts) is not an identity: before
// 2026-10-20 this function accepted any such string, and eleven call sites then
// tested the returned object for truthiness, so the guard never fired.
//
// The predicate is called with the CALLER's token, never the service key: as
// postgres the predicate would evaluate for the wrong principal and always pass.
async function consoleAdmin(env, request) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return { ok: false, reason: "no token" };
  // The operator's own token stays valid on console routes (scripts and the bot
  // use it), but it is compared exactly, never by shape.
  if (env.ADMIN_TOKEN && timingSafe(token, env.ADMIN_TOKEN)) {
    return { ok: true, email: "operator" };
  }
  if (token.split(".").length !== 3) return { ok: false, reason: "bad token" };
  const h = { apikey: env.SUPABASE_ANON_KEY, Authorization: "Bearer " + token };
  const who = await fetch(env.SUPABASE_URL + "/auth/v1/user", { headers: h }).catch(() => null);
  if (!who || !who.ok) return { ok: false, reason: "bad token" };
  const u = await who.json().catch(() => null);
  const check = await fetch(env.SUPABASE_URL + "/rest/v1/rpc/is_console_admin", {
    method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: "{}",
  }).catch(() => null);
  if (!check || !check.ok) return { ok: false, reason: "not an admin" };
  const isAdmin = await check.json().catch(() => false);
  if (isAdmin !== true) return { ok: false, reason: "not an admin" };
  return { ok: true, email: (u && u.email) || "admin" };
}

/** One shape for every console-admin gate: null means allowed, a Response means
 *  denied (403 with the reason). Call sites must check this, never the object. */
async function requireConsoleAdmin(env, request, origin) {
  const a = await consoleAdmin(env, request);
  return a.ok ? null : json({ error: "not allowed", reason: a.reason }, 403, origin);
}

async function sb(env, path, init) {
  const r = await fetch(env.SUPABASE_URL + "/rest/v1/" + path, { ...init, headers: { ...sbHeaders(env), ...((init && init.headers) || {}) } });
  if (!r.ok && r.status !== 201) throw new Error("supabase " + r.status + " " + (await r.text()).slice(0, 120));
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

const blankRecord = (id) => ({ id, name: id, items: [], bundles: [], style: {},
                               connected: false, manual: false, updatedAt: null });

async function record(env, id) {
  const rows = await sb(env, "creators?id=eq." + encodeURIComponent(id) + "&select=record");
  if (rows && rows.length) {
    const rec = rows[0].record || {};
    return { ...blankRecord(id), ...rec, id };
  }
  return blankRecord(id);
}

async function saveRecord(env, rec, token) {
  const items = rec.items || [];
  const row = {
    id: rec.id,
    name: rec.name || rec.id,
    plan: rec.plan || "basic",
    fee_pence: Math.round((rec.fee || 0) * 100),
    split_pct: Math.round((rec.split || 0) * 10000) / 100,
    state: rec.state || null,
    connected: !!rec.connected,
    items_live: items.filter((i) => i.state === "live").length,
    items_total: items.length,
    record: { ...rec, updatedAt: new Date().toISOString() },
    updated_at: new Date().toISOString(),
  };
  if (rec.dashboard_token || token) row.dashboard_token = rec.dashboard_token || token;
  if (rec.chat_id || rec.telegram_chat_id) row.telegram_chat_id = String(rec.chat_id || rec.telegram_chat_id);
  if (rec.id) row.id = rec.id;
  await sb(env, "creators?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(row),
  });
  return row;
}

async function creatorForToken(env, token) {
  const rows = await sb(env, "creators?dashboard_token=eq." + encodeURIComponent(token) +
                             "&select=id&limit=1");
  return rows && rows.length ? rows[0].id : null;
}

async function roster(env) {
  const rows = await sb(env, "creators?select=id,name,record,items_live,items_total,updated_at" +
                             "&order=created_at.asc");
  return (rows || []).map((r) => ({ id: r.id, name: r.name,
                                    manual: !!((r.record || {}).manual),
                                    items_live: r.items_live, items_total: r.items_total,
                                    updatedAt: r.updated_at }));
}


// Who is calling: the admin token, or a console admin with a Supabase session.
// Creator tokens are no longer accepted anywhere: the creator panel was removed, so nobody
// outside the operator console has business reading or writing a record.
async function whoami(env, request, url) {
  // Header only. A token in the query string lands in logs, proxies and referrers,
  // so ?t= is gone (2026-10-20). Every caller already sends Authorization: Bearer.
  const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const token = bearer;
  if (!token) return null;
  if (env.ADMIN_TOKEN && timingSafe(token, env.ADMIN_TOKEN)) {
    // The god-token is the operator's: ?creator= is how the console acts on a
    // creator's behalf, and it is only honoured on this branch, never for a
    // Supabase session.
    return { id: url.searchParams.get("creator") || "ava", role: "admin" };
  }
  if (token.split(".").length === 3) {
    // a Supabase login: ask auth who it is, then find the creator it belongs to
    const r = await fetch(env.SUPABASE_URL + "/auth/v1/user", {
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: "Bearer " + token },
    });
    if (!r.ok) return null;
    const u = await r.json();
    let aal = "aal1";
    try {
      const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      aal = JSON.parse(atob(part + "=".repeat((4 - (part.length % 4)) % 4))).aal || "aal1";
    } catch (e) { /* older tokens carry no aal */ }
    // A Supabase session is a console admin only if the predicate says so. Before
    // 2026-10-20 every session came back "nobody" here, so real console admins
    // were locked out of /settings, /bots, /persona and /manual while a forged
    // three-part string was let in by consoleAdmin: exactly backwards.
    const chk = await fetch(env.SUPABASE_URL + "/rest/v1/rpc/is_console_admin", {
      method: "POST",
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => null);
    const isAdmin = chk && chk.ok ? await chk.json().catch(() => false) : false;
    // Admin means: the predicate says so AND the session is MFA-strength. A
    // password-only (aal1) session never gets admin, even for a listed user,
    // because the console can mint media links and rewrite bot tokens.
    const admin = isAdmin === true && aal === "aal2";
    // Same shape as the operator branch: act on ?creator=, else the default
    // creator, so no route ever sees a null creator id.
    return { id: admin ? (url.searchParams.get("creator") || "ava") : null,
             role: admin ? "admin" : "nobody", email: u.email };
  }
  return null;                      // creator tokens: not a thing any more
}

export default {
  async fetch(request, env) {
   try {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS(origin) });

    // media is paid content: an expiring signature is required, never public
    if (url.pathname.startsWith("/m/")) {
      const key = decodeURIComponent(url.pathname.slice(3));
      const exp = parseInt(url.searchParams.get("e") || "0", 10);
      const sig = url.searchParams.get("s") || "";
      if (!exp || exp * 1000 < Date.now()) {
        return json({ error: "link expired", hint: "ask for a fresh link" }, 403, origin);
      }
      const want = await sign(key, exp, env.MEDIA_SECRET);
      if (!timingSafe(sig, want)) return json({ error: "bad signature" }, 403, origin);
      const obj = await env.MEDIA.get(key);
      if (!obj) return json({ error: "not found" }, 404, origin);
      return new Response(obj.body, {
        headers: { "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
                   "Cache-Control": "private, max-age=300" },
      });
    }

    // Telegram Business webhook. Must sit ahead of whoami(): Telegram sends no
    // Authorization header, which is exactly why every update has been 401ing.
    // It authenticates with the secret header instead, checked inside.
    if (url.pathname.startsWith("/tg/")) {
      if (request.method !== "POST") return json({ error: "post only" }, 405, origin);
      const persona = decodeURIComponent(url.pathname.slice(4)).toLowerCase();
      return handleWebhook(request, env, sb, persona);
    }

    // Bot management endpoints for console admin (before whoami check)
    if (url.pathname === "/bots/hook" && request.method === "POST") {
      const denied = await requireConsoleAdmin(env, request, origin);
      if (denied) return denied;
      const b = await request.json();
      const persona = String(b.persona || "").trim().toLowerCase();
      const rows = await sb(env, "bots?select=token,username&persona=eq." + encodeURIComponent(persona));
      if (!rows || !rows.length) return json({ error: "no bot saved for that persona" }, 404, origin);
      const token = rows[0].token;
      if (!env.TELEGRAM_WEBHOOK_SECRET && !b.unhook) {
        return json({ error: "TELEGRAM_WEBHOOK_SECRET is not set",
                      hint: "wrangler secret put TELEGRAM_WEBHOOK_SECRET --name creator-api" }, 409, origin);
      }
      const hookUrl = "https://api-telebotcreator.turboit.uk/tg/" + encodeURIComponent(persona);
      const out = {};
      try {
        out.webhook = b.unhook
          ? await tgapi.deleteWebhook(token)
          : await tgapi.setWebhook(token, hookUrl, env.TELEGRAM_WEBHOOK_SECRET);
        out.info = await tgapi.getWebhookInfo(token);
      } catch (e) {
        return json({ persona, error: String(e.message || e) }, 502, origin);
      }
      return json({ persona, webhook: b.unhook ? "deleted" : "set", url: b.unhook ? null : hookUrl,
                    allowed_updates: b.unhook ? null : tgapi.ALLOWED_UPDATES,
                    pending: out.info && out.info.pending_update_count,
                    last_error: (out.info && out.info.last_error_message) || null }, 200, origin);
    }

    // Fetch/save business connection ID for a bot (called by console)
    if (url.pathname === "/bots/connection") {
      const admin = await consoleAdmin(env, request);
      if (!admin.ok) {
        return json({ error: "not allowed", reason: admin.reason }, 403, origin);
      }
      if (request.method === "GET") {
        const username = url.searchParams.get("username");
        if (!username) return json({ error: "username required" }, 400, origin);
        const accounts = await sb(env, "telegram_accounts?select=id&username=eq." + encodeURIComponent(username));
        if (!accounts || !accounts.length) {
          return json({ error: "account not found" }, 404, origin);
        }
        const accountId = accounts[0].id;
        const connections = await sb(env, "business_connections?select=connection_id&telegram_account_id=eq." + encodeURIComponent(accountId));
        const connectionId = (connections && connections.length && connections[0].connection_id) || null;
        return json({ connection_id: connectionId }, 200, origin);
      } else if (request.method === "POST") {
        const body = await request.json();
        const username = body.username;
        const connectionId = body.connection_id;
        if (!username || !connectionId) {
          return json({ error: "username and connection_id required" }, 400, origin);
        }
        const accounts = await sb(env, "telegram_accounts?select=id&username=eq." + encodeURIComponent(username));
        if (!accounts || !accounts.length) {
          return json({ error: "account not found" }, 404, origin);
        }
        const accountId = accounts[0].id;
        const existing = await sb(env, "business_connections?telegram_account_id=eq." + encodeURIComponent(accountId) + "&select=id");
        if (existing && existing.length) {
          await sb(env, "business_connections?id=eq." + encodeURIComponent(existing[0].id), {
            method: "PATCH",
            body: JSON.stringify({ connection_id: connectionId })
          });
        } else {
          await sb(env, "business_connections", {
            method: "POST",
            body: JSON.stringify({ telegram_account_id: accountId, connection_id: connectionId })
          });
        }
        return json({ success: true, connection_id: connectionId }, 200, origin);
      }
    }

    // Console reply: send a message as the creator through her business
    // connection. Sits before whoami() (console-admin auth only) because the
    // sender is the OWNER acting on a conversation, not a creator login.
    // Telegram media proxy: the console passes a stored file_id, we fetch the
    // file path from Telegram and stream the bytes back. Admin-gated.
    // Media in the inbox is rendered by <img>, which cannot send an
    // Authorization header. The console asks here (admin only) for a short lived
    // signed URL and /tgfile accepts e+s. Before 2026-10-20 these images loaded
    // only because the admin gate was broken.
    if (url.pathname === "/tgfile/sign" && request.method === "GET") {
      const denied = await requireConsoleAdmin(env, request, origin);
      if (denied) return denied;
      const f = url.searchParams.get("f") || "";
      const bc = url.searchParams.get("bc") || "";
      if (!f || !bc) return json({ error: "file_id and bc required" }, 400, origin);
      const exp = Math.floor(Date.now() / 1000) + 300;
      const s = await sign(f + "|" + bc, exp, env.MEDIA_SECRET + ":tgfile");
      return json({ url: "/tgfile?f=" + encodeURIComponent(f) + "&bc=" + encodeURIComponent(bc) +
                          "&e=" + exp + "&s=" + s, exp }, 200, origin);
    }

    if (url.pathname === "/tgfile" && request.method === "GET") {
      const preF = url.searchParams.get("f") || "";
      const preBc = url.searchParams.get("bc") || "";
      const preE = parseInt(url.searchParams.get("e") || "0", 10);
      const preS = url.searchParams.get("s") || "";
      let allowed = false;
      if (preF && preBc && preE && preS && preE * 1000 >= Date.now()) {
        const want = await sign(preF + "|" + preBc, preE, env.MEDIA_SECRET + ":tgfile");
        allowed = timingSafe(preS, want);
      }
      if (!allowed) {
        const denied = await requireConsoleAdmin(env, request, origin);
        if (denied) return denied;
      }
      const f = url.searchParams.get("f") || "";
      const bc = url.searchParams.get("bc") || "";
      if (!f || !bc) return json({ error: "file_id and bc required" }, 400, origin);
      const conn = await sb(env, "business_connections?id=eq." + encodeURIComponent(bc) +
        "&select=id,creator_id,telegram_account_id").catch(() => null);
      const c = conn && conn[0];
      if (!c) return json({ error: "unknown connection" }, 404, origin);
      // bot token for this account (bots table keyed by persona username)
      let token = null;
      {
        const acc = await sb(env, "telegram_accounts?id=eq." +
          encodeURIComponent(c.telegram_account_id) + "&select=username").catch(() => null);
        const uname = acc && acc[0] && acc[0].username ? acc[0].username.toLowerCase() : null;
        if (uname) {
          const rows = await sb(env, "bots?persona=eq." + encodeURIComponent(uname) + "&select=token").catch(() => null);
          if (rows && rows[0] && rows[0].token) token = rows[0].token;
        }
      }
      if (!token) return json({ error: "no bot token" }, 404, origin);
      try {
        const info = await (await fetch("https://api.telegram.org/bot" + token + "/getFile?file_id=" + encodeURIComponent(f))).json();
        if (!info || !info.ok || !info.result || !info.result.file_path) {
          return json({ error: "telegram getFile failed" }, 502, origin);
        }
        const file = await fetch("https://api.telegram.org/file/bot" + token + "/" + info.result.file_path);
        return new Response(file.body, {
          headers: { "Content-Type": file.headers.get("Content-Type") || "application/octet-stream",
                     "Cache-Control": "private, max-age=3600" },
        });
      } catch (e) {
        return json({ error: "proxy failed: " + String(e).slice(0, 120) }, 502, origin);
      }
    }

    // Persona learning: analyse real chats (stored history + uploaded
    // screenshots of conversations) and draft a persona prompt.
    if (url.pathname === "/persona/learn" && request.method === "POST") {
      const denied = await requireConsoleAdmin(env, request, origin);
      if (denied) return denied;
      const b = await request.json().catch(() => ({}));
      const accountId = String(b.account_id || "");
      if (!accountId) return json({ error: "account_id required" }, 400, origin);

      // 1. Stored chat history for this account's business connection.
      let historyLines = [];
      try {
        const conns = await sb(env, "business_connections?telegram_account_id=eq." +
          encodeURIComponent(accountId) + "&select=id,creator_id");
        for (const c of conns || []) {
          const msgs = await sb(env, "messages?order=sent_at.desc&limit=200&select=direction,sender,body_preview,sent_at" +
            "&conversation_id=in.(" + encodeURIComponent(
              (await sb(env, "conversations?business_connection_id=eq." + encodeURIComponent(c.id) +
                "&select=id")).map(r => r.id).join(",") || "00000000-0000-0000-0000-000000000000") + ")").catch(() => []);
          for (const m of msgs || []) {
            if (!m.body_preview) continue;
            const who = m.direction === "in" ? "customer" : (m.sender === "ai" ? "her(bot)" : "her");
            historyLines.push(who + ": " + m.body_preview);
          }
        }
        historyLines = historyLines.slice(-150); // most recent 150, oldest first
      } catch (e) { /* history is optional */ }

      // 2. Uploaded chat screenshots (public or signed URLs).
      const images = Array.isArray(b.images) ? b.images.filter(u => typeof u === "string" && u.startsWith("http")).slice(0, 6) : [];

      // 3. Ask the model to write the persona.
      const userText =
        "Write a persona prompt for a Telegram chat bot that will keep replying EXACTLY like her.\n\n" +
        "Real messages from her account (her style to copy):\n" +
        (historyLines.length ? historyLines.join("\n") : "(none stored yet)") + "\n\n" +
        "Screenshots of her chats are attached if provided.\n\n" +
        "Write the persona as a concise instruction list: her name/character, how she flirts, her emoji and slang habits, " +
        "typical message length, how she prices and sells content, what she would never say. Plain text, no markdown headers. " +
        "Only use what the chats show; do not invent products, prices or biographical facts.";

      const model = env.AI_MODEL || "@cf/mistralai/mistral-small-3.1-24b-instruct";
      let out;
      try {
        out = await env.AI.run(model, {
          messages: [{ role: "user", content: images.length && images.slice(0,3).map(u => ({ type: "image_url", image_url: { url: u } })) ? [
            { type: "text", text: userText },
            ...images.slice(0, 3).map(u => ({ type: "image_url", image_url: { url: u } })),
          ] : userText }],
          max_tokens: 800,
        });
      } catch (e) {
        // Vision attempt failed; fall back to text-only on the history.
        out = await env.AI.run(model, {
          messages: [{ role: "user", content: userText }],
          max_tokens: 800,
        }).catch(() => null);
      }
      const text = typeof out === "string" ? out : (out && out.response) || "";
      if (!text.trim()) return json({ error: "model returned nothing" }, 502, origin);
      return json({ persona: String(text).trim() }, 200, origin);
    }

    if (url.pathname === "/conversations/reply" && request.method === "POST") {
      const denied = await requireConsoleAdmin(env, request, origin);
      if (denied) return denied;
      const b = await request.json();
      const convId = String(b.conversation_id || "");
      const text = String(b.text || "").trim().slice(0, 4096);
      if (!convId || !text) return json({ error: "conversation_id and text required" }, 400, origin);
      const convs = await sb(env, "conversations?id=eq." + encodeURIComponent(convId) + "&select=*");
      const conv = convs && convs[0];
      if (!conv) return json({ error: "no such conversation" }, 404, origin);
      if (!conv.business_connection_id) return json({ error: "conversation has no business connection" }, 409, origin);
      const conns = await sb(env, "business_connections?id=eq." + encodeURIComponent(conv.business_connection_id) +
        "&select=id,creator_id,telegram_account_id,is_enabled,can_reply_cached");
      const conn = conns && conns[0];
      if (!conn) return json({ error: "no business connection row" }, 404, origin);
      if (conn.is_enabled === false) return json({ error: "connection disabled" }, 409, origin);
      // bot token: bots row keyed by the account username (lowercased)
      const accts = await sb(env, "telegram_accounts?id=eq." + encodeURIComponent(conn.telegram_account_id || "") + "&select=username");
      const uname = accts && accts[0] && String(accts[0].username || "").toLowerCase();
      if (!uname) return json({ error: "account has no username" }, 409, origin);
      const bots = await sb(env, "bots?persona=eq." + encodeURIComponent(uname) + "&select=token");
      const token = bots && bots[0] && bots[0].token;
      if (!token) return json({ error: "no bot token for " + uname }, 409, origin);
      // Send through Telegram as the creator, then record the row.
      let sent = null;
      try {
        sent = await tgapi.sendMessage(token, conv.business_connection_id, conv.chat_id, text);
      } catch (e) {
        return json({ error: "telegram send failed", detail: String(e).slice(0, 200) }, 502, origin);
      }
      const row = {
        conversation_id: conv.id,
        creator_id: conv.creator_id,
        tg_message_id: sent && sent.message_id ? sent.message_id : null,
        direction: "out",
        sender: "human",
        kind: "text",
        body_preview: text,
        sent_at: new Date().toISOString(),
        raw: { via: "console" },
      };
      await sb(env, "messages", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
      await sb(env, "conversations?id=eq." + encodeURIComponent(conv.id), { method: "PATCH",
        headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_message_at: row.sent_at, last_outbound_at: row.sent_at }) });
      return json({ ok: true, message: row }, 200, origin);
    }

    // ---------- FabSwingers ----------
    // One FabSwingers login per Telegram account, with that account's own persona.
    // All routes are console-admin only and sit above the generic 404.
    const sha256hex = async (s) => {
      const enc = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
      return Array.from(new Uint8Array(enc)).map((b) => b.toString(16).padStart(2, "0")).join("");
    };
    const fsAccountByTelegram = async (telegramAccountId) => {
      const rows = await sb(env, `fabswingers_accounts?telegram_account_id=eq.${telegramAccountId}&select=*`);
      return rows && rows.length ? rows[0] : null;
    };

    if (url.pathname === "/fabswingers" && request.method === "GET") {
      const denied = await requireConsoleAdmin(env, request, origin);
      if (denied) return denied;
      const tg = url.searchParams.get("telegram_account_id");
      const filter = tg ? `telegram_account_id=eq.${tg}&` : "";
      const rows = await sb(env, `fabswingers_accounts?${filter}select=id,telegram_account_id,creator_id,username,telegram_username,enabled,last_poll_at,last_error,created_at,updated_at&order=created_at.desc`);
      const personas = await sb(env, "fabswingers_personas?select=fabswingers_account_id,tone,emoji_level,message_length,system_prompt,pivot_message");
      const byId = new Map((personas || []).map((p) => [p.fabswingers_account_id, p]));
      return json({ accounts: (rows || []).map((a) => ({ ...a, persona: byId.get(a.id) || null })) }, 200, origin);
    }

    // Verify a FabSwingers login without saving it. This really does try the site, so
    // the console can tell a wrong password from FabSwingers being unreachable.
    if (url.pathname === "/fabswingers/verify" && request.method === "POST") {
      const denied = await requireConsoleAdmin(env, request, origin);
      if (denied) return denied;
      const b = await request.json().catch(() => ({}));
      if (!b.username || !b.password) return json({ ok: false, error: "Enter the FabSwingers username and password first" }, 400, origin);
      try {
        const r = await fetch("https://www.fabswingers.com/login", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36" },
          body: `username=${encodeURIComponent(b.username)}&password=${encodeURIComponent(b.password)}`,
          redirect: "manual",
        });
        const cookie = r.headers.get("set-cookie") || "";
        const ok = /PHPSESSID=/i.test(cookie) && r.status < 400;
        return json({ ok, status: r.status, detail: ok ? "Logged in" : "FabSwingers did not return a session. Check the username and password." }, 200, origin);
      } catch (e) {
        return json({ ok: false, error: "Could not reach FabSwingers: " + String(e).slice(0, 160) }, 200, origin);
      }
    }

    // Create or update the FabSwingers login for one Telegram account.
    if (url.pathname === "/fabswingers" && request.method === "POST") {
      const denied = await requireConsoleAdmin(env, request, origin);
      if (denied) return denied;
      const b = await request.json().catch(() => ({}));
      const { telegram_account_id, username, password, telegram_username } = b;
      if (!telegram_account_id) return json({ error: "telegram_account_id is required" }, 400, origin);
      if (!username || !telegram_username) return json({ error: "FabSwingers username and her Telegram handle are both required" }, 400, origin);
      const existing = await fsAccountByTelegram(telegram_account_id);
      const accounts = await sb(env, `telegram_accounts?id=eq.${telegram_account_id}&select=id,creator_id,username`);
      const tg = accounts && accounts[0];
      if (!tg) return json({ error: "That Telegram account does not exist" }, 404, origin);

      const body = {
        telegram_account_id,
        creator_id: tg.creator_id || null,
        username: username.trim(),
        telegram_username: telegram_username.trim().replace(/^@/, ""),
      };
      if (password) {
        body.password_enc = await sha256hex(password);
        body.password_nonce = crypto.randomUUID();
      } else if (!existing) {
        return json({ error: "A password is required the first time" }, 400, origin);
      }
      let row;
      if (existing) {
        row = await sb(env, `fabswingers_accounts?id=eq.${existing.id}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(body) });
      } else {
        row = await sb(env, "fabswingers_accounts", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ ...body, enabled: true }) });
      }
      return json({ ok: true, account: Array.isArray(row) ? row[0] : row }, 200, origin);
    }

    if (url.pathname.startsWith("/fabswingers/") && request.method === "DELETE") {
      const denied = await requireConsoleAdmin(env, request, origin);
      if (denied) return denied;
      const id = url.pathname.split("/")[2];
      await sb(env, `fabswingers_accounts?id=eq.${id}`, { method: "DELETE" });
      return json({ ok: true }, 200, origin);
    }

    if (url.pathname.startsWith("/fabswingers/") && request.method === "PATCH") {
      const denied = await requireConsoleAdmin(env, request, origin);
      if (denied) return denied;
      const id = url.pathname.split("/")[2];
      const b = await request.json().catch(() => ({}));
      const body = {};
      if (typeof b.enabled === "boolean") body.enabled = b.enabled;
      if (b.telegram_username) body.telegram_username = String(b.telegram_username).trim().replace(/^@/, "");
      if (b.password) { body.password_enc = await sha256hex(b.password); body.password_nonce = crypto.randomUUID(); }
      if (!Object.keys(body).length) return json({ error: "nothing to update" }, 400, origin);
      const row = await sb(env, `fabswingers_accounts?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(body) });
      return json({ ok: true, account: Array.isArray(row) ? row[0] : row }, 200, origin);
    }

    // Persona for one FabSwingers account (one row per account).
    if (url.pathname === "/fabswingers/persona" && request.method === "GET") {
      const denied = await requireConsoleAdmin(env, request, origin);
      if (denied) return denied;
      const fsId = url.searchParams.get("fabswingers_account_id");
      const tgId = url.searchParams.get("telegram_account_id");
      let id = fsId;
      if (!id && tgId) { const a = await fsAccountByTelegram(tgId); id = a && a.id; }
      if (!id) return json({ persona: null }, 200, origin);
      const rows = await sb(env, `fabswingers_personas?fabswingers_account_id=eq.${id}&select=*`);
      return json({ persona: (rows && rows[0]) || null }, 200, origin);
    }

    if (url.pathname === "/fabswingers/persona" && (request.method === "PUT" || request.method === "POST")) {
      const denied = await requireConsoleAdmin(env, request, origin);
      if (denied) return denied;
      const b = await request.json().catch(() => ({}));
      let id = b.fabswingers_account_id;
      if (!id && b.telegram_account_id) { const a = await fsAccountByTelegram(b.telegram_account_id); id = a && a.id; }
      if (!id) return json({ error: "Save the FabSwingers login before the personality" }, 400, origin);
      const body = {
        fabswingers_account_id: id,
        tone: b.tone || null,
        emoji_level: b.emoji_level || null,
        message_length: b.message_length || null,
        system_prompt: b.system_prompt || null,
        pivot_message: b.pivot_message || null,
      };
      const existing = await sb(env, `fabswingers_personas?fabswingers_account_id=eq.${id}&select=id`);
      const row = existing && existing.length
        ? await sb(env, `fabswingers_personas?fabswingers_account_id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(body) })
        : await sb(env, "fabswingers_personas", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(body) });
      return json({ ok: true, persona: Array.isArray(row) ? row[0] : row }, 200, origin);
    }

    // Poll trigger. The scraper is not deployed yet, so this reports that honestly
    // instead of pretending a poll happened.
    if (url.pathname === "/fabswingers/poll" && request.method === "POST") {
      const denied = await requireConsoleAdmin(env, request, origin);
      if (denied) return denied;
      return json({ ok: false, error: "FabSwingers auto-reply is not live yet: the account and personality save, the scraper is still to be built." }, 501, origin);
    }

    if (url.pathname === "/fabswingers/conversations" && request.method === "GET") {
      const denied = await requireConsoleAdmin(env, request, origin);
      if (denied) return denied;
      const accountId = url.searchParams.get("account_id");
      if (!accountId) return json({ error: "need account_id" }, 400, origin);
      const rows = await sb(env, `fabswingers_conversations?fabswingers_account_id=eq.${accountId}&select=*&order=last_message_at.desc`);
      return json({ conversations: rows || [] }, 200, origin);
    }

    const me = await whoami(env, request, url);
    if (!me) return json({ error: "unauthorised" }, 401, origin);
    if (me.role === "nobody") {
      return json({ error: "no creator account is linked to that login" }, 403, origin);
    }
    if (me.role === "creator" && me.aal && me.aal !== "aal2") {
      return json({ error: "two factor required", hint: "finish the code step" }, 403, origin);
    }

    if (url.pathname === "/me" && request.method === "GET") {
      return json(await record(env, me.id), 200, origin);
    }

    if (url.pathname === "/me" && request.method === "PUT") {
      const body = await request.json();
      const rec = await record(env, me.id);
      for (const k of ["items", "style", "bundles", "name", "plan", "fee", "split"]) {
        if (k in body) rec[k] = body[k];
      }
      rec.updatedAt = new Date().toISOString();
      await saveRecord(env, { ...rec, id: me.id });
      return json(rec, 200, origin);
    }

    if (url.pathname === "/sign" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const key = String(body.key || "");
      const ttl = Math.min(Math.max(parseInt(body.ttl || "86400", 10), 60), 7 * 86400);
      if (!key) return json({ error: "no key" }, 400, origin);
      // /tgfile signatures are minted only by /tgfile/sign, under its own key
      // space, so a long lived /m/ signature can never act as an inbox media pass.
      if (key.startsWith("tgfile|")) return json({ error: "reserved key" }, 400, origin);
      if (me.role !== "admin" && !key.startsWith(me.id + "/")) {
        return json({ error: "not your file" }, 403, origin);
      }
      const exp = Math.floor(Date.now() / 1000) + ttl;
      const sig = await sign(key, exp, env.MEDIA_SECRET);
      return json({ url: `${url.origin}/m/${encodeURIComponent(key)}?e=${exp}&s=${sig}`, exp },
                  200, origin);
    }

    if (url.pathname === "/media" && request.method === "POST") {
      const name = (url.searchParams.get("name") || "upload.bin").replace(/[^a-zA-Z0-9._-]/g, "_");
      const key = `${me.id}/${crypto.randomUUID()}-${name}`;
      await env.MEDIA.put(key, request.body, {
        httpMetadata: { contentType: request.headers.get("Content-Type") || "application/octet-stream" },
      });
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const sig = await sign(key, exp, env.MEDIA_SECRET);
      return json({ key, exp,
                    url: `${url.origin}/m/${encodeURIComponent(key)}?e=${exp}&s=${sig}` }, 200, origin);
    }

    if (url.pathname === "/style-import" && request.method === "POST") {
      const name = (url.searchParams.get("name") || "chat.png").replace(/[^a-zA-Z0-9._-]/g, "_");
      const key = `style-imports/${me.id}/${crypto.randomUUID()}-${name}`;
      const buf = await request.arrayBuffer();
      await env.MEDIA.put(key, buf, {
        httpMetadata: { contentType: request.headers.get("Content-Type") || "image/png" },
      });
      const prompt = [
        "This image is a screenshot of a chat.",
        "Transcribe every message bubble, top to bottom, one bubble per line, in the order they appear.",
        "Copy the words exactly, in lower case, no translation, no summarising, no commentary.",
        "Leave out any name, handle, phone number, link, price or amount.",
        "Do not label who sent it. Output the lines only.",
      ].join(" ");
      const models = [
        "@cf/mistralai/mistral-small-3.1-24b-instruct",
        "@cf/meta/llama-3.2-11b-vision-instruct",
      ];
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf).slice(0, 2000000)));
      const bodyFor = (prompt) => ({
        messages: [{ role: "user", content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: "data:image/png;base64," + b64 } },
        ] }],
        max_tokens: 900,
      });
      const AFFECTION = /\b(babe|bby|hun|honey|love|miss you|good boy|darling|sweetheart)\b/i;
      let lines = [];
      let note = "queued for review";
      let used = null;
      for (const model of models) {
        try {
          const out = await env.AI.run(model, bodyFor(prompt));
          const text = typeof out === "string" ? out : (out.response || JSON.stringify(out));
          const clean = String(text).replace(/```/g, "").trim();
          const seen = new Set();
          lines = [];
          for (const raw of clean.split(/\r?\n/)) {
            let l = raw.replace(/^\s*(?:[-*•>]|\d+[.)])\s*/, "").trim();
            l = l.replace(/\b\d{1,2}:\d{2}\s*(?:am|pm)?\b/gi, " ")
                 .replace(/https?:\/\/\S+/g, " ")
                 .replace(/@[a-z0-9_.]+/gi, " ")
                 .replace(/\s{2,}/g, " ").trim();
            if (/^(here|sure|the transcript|transcription|i can|i'm sorry|chat|conversation)\b/i.test(l)) continue;
            if (/^(r|l|right|left)\s*[:\-]/i.test(l)) l = l.replace(/^(r|l|right|left)\s*[:\-]\s*/i, "");
            if (l.length < 3 || l.length > 160) continue;
            l = l.toLowerCase();
            if (seen.has(l)) continue;
            seen.add(l);
            lines.push(l);
          }
          if (lines.length) { note = "extracted"; used = model; break; }
          note = "nothing readable with " + model;
          used = model;
        } catch (e) {
          note = "vision model error on " + model + ": " + (e && e.message ? e.message : "unknown");
          used = model;
        }
      }
      const candidates = lines.slice(0, 24).map((l) => ({
        text: l,
        emoji: (l.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length,
        likely: (/(^|\s)x$/.test(l) || AFFECTION.test(l) || /[\u{1F300}-\u{1FAFF}]/u.test(l)
                 || /\b(sending|want a look|up today|give me|gimme)\b/i.test(l)) ? 1 : 0,
      }));
      const result = { candidates, read: lines.length, emoji: [...new Set(
        (lines.join(" ").match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []))] };
      return json({ key, url: `${url.origin}/m/${encodeURIComponent(key)}`, note, model: used, result },
                  200, origin);
    }

    if (url.pathname === "/style-probe" && request.method === "POST") {
      const buf = await request.arrayBuffer();
      const bytes = [...new Uint8Array(buf)];
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf).slice(0, 2000000)));
      const p = "Transcribe every message bubble in this chat screenshot, top to bottom, one per line, " +
                "prefix R: for right-aligned bubbles and L: for left-aligned. Then TONE: <word>.";
      const shapes = {
        "image+prompt": { image: bytes, prompt: p, max_tokens: 300 },
        "messages-image": { messages: [{ role: "user", content: [{ type: "text", text: p },
          { type: "image", image: bytes }] }], max_tokens: 300 },
        "messages-url": { messages: [{ role: "user", content: [{ type: "text", text: p },
          { type: "image_url", image_url: { url: "data:image/png;base64," + b64 } }] }], max_tokens: 300 },
      };
      const models = ["@cf/google/gemma-3-12b-it", "@cf/meta/llama-4-scout-17b-16e-instruct",
                      "@cf/meta/llama-3.2-11b-vision-instruct",
                      "@cf/mistralai/mistral-small-3.1-24b-instruct"];
      const out = [];
      for (const m of models) {
        for (const [shape, body] of Object.entries(shapes)) {
          let txt = "";
          try {
            const r = await env.AI.run(m, body);
            txt = (typeof r === "string" ? r : (r.response || JSON.stringify(r))).slice(0, 160);
          } catch (e) {
            txt = "ERR " + (e && e.message ? e.message : "unknown");
          }
          out.push({ model: m, shape, grounded: /shower|screenshot|trouble|babe|after/i.test(txt),
                     txt: txt.replace(/\s+/g, " ") });
        }
      }
      return json({ out }, 200, origin);
    }

    // the kill switch: readable by the assistant, writable by the assistant or by an admin
    if (url.pathname === "/settings" && request.method === "GET") {
      if (me.role !== "admin") {
        const denied = await requireConsoleAdmin(env, request, origin);
        if (denied) return denied;
      }
      const rows = await sb(env, "settings?select=value&key=eq.assistants");
      const value = (rows && rows[0] && rows[0].value) || {};
      return json({ kill_all: !!value.kill_all, by: value.by || null }, 200, origin);
    }
    if (url.pathname === "/settings" && request.method === "POST") {
      if (me.role !== "admin") {
        const denied = await requireConsoleAdmin(env, request, origin);
        if (denied) return denied;
      }
      const b = await request.json();
      const who = b.by || me.email || "operator";
      const value = { kill_all: !!b.kill_all, at: Date.now() / 1000, by: who };
      await sb(env, "settings?on_conflict=key", { method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ key: "assistants", value }) });
      return json({ kill_all: value.kill_all }, 200, origin);
    }

    // one creator on or off by hand (manual mode), for the console
    if (url.pathname === "/manual" && request.method === "POST") {
      if (me.role !== "admin") {
        const denied = await requireConsoleAdmin(env, request, origin);
        if (denied) return denied;
      }
      const b = await request.json();
      const id = String(b.id || "");
      if (!id) return json({ error: "which creator?" }, 400, origin);
      const rows = await sb(env, "creators?id=eq." + encodeURIComponent(id) + "&select=record");
      if (!rows || !rows.length) return json({ error: "no such creator" }, 404, origin);
      const rec = rows[0].record || {};
      rec.manual = !!b.manual;
      await sb(env, "creators?id=eq." + encodeURIComponent(id), { method: "PATCH",
        body: JSON.stringify({ record: rec }) });
      return json({ id, manual: rec.manual }, 200, origin);
    }

    // never send a token to a browser: the panel shows the handle and a mask
    if (url.pathname === "/bots" && request.method === "GET") {
      if (me.role !== "admin") {
        const denied = await requireConsoleAdmin(env, request, origin);
        if (denied) return denied;
      }
      const rows = await sb(env, "bots?select=persona,username,active,created_at&order=created_at.asc");
      return json({ bots: (rows || []).map(b => ({ persona: b.persona, username: b.username,
                                                   active: b.active, added: b.created_at })) }, 200, origin);
    }
    if (url.pathname === "/bots" && request.method === "POST") {
      if (me.role !== "admin") {
        const denied = await requireConsoleAdmin(env, request, origin);
        if (denied) return denied;
      }
      const b = await request.json();
      const persona = String(b.persona || "").trim().toLowerCase();
      const token = String(b.token || "").trim();
      if (!persona || !token) return json({ error: "need a persona and a token" }, 400, origin);
      if (!/^[0-9]+:[A-Za-z0-9_-]{30,}$/.test(token)) {
        return json({ error: "that does not look like a bot token" }, 400, origin);
      }
      // check it with Telegram before storing it, so a typo never becomes a dead persona
      const who = await fetch("https://api.telegram.org/bot" + token + "/getMe").then(r => r.json()).catch(() => null);
      if (!who || !who.ok) return json({ error: "Telegram refused that token" }, 400, origin);
      await sb(env, "bots?on_conflict=persona", { method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ persona, username: who.result.username, token, active: true }) });
      return json({ persona, username: who.result.username, active: true }, 200, origin);
    }
    // Per-creator personality. Configurable from the console, no deploy needed.
    if (url.pathname === "/persona" && request.method === "GET") {
      if (me.role !== "admin") {
        const denied = await requireConsoleAdmin(env, request, origin);
        if (denied) return denied;
      }
      const cid = url.searchParams.get("creator") || me.id;
      const rows = await sb(env, "ai_profiles?creator_id=eq." + encodeURIComponent(cid) + "&select=*");
      const p = (rows && rows[0]) || null;
      return json({
        creator_id: cid,
        profile: p,
        // What the customer would actually receive today, so the console can
        // preview it rather than describe it.
        effective: {
          variants: p && p.bot_answer_variants && p.bot_answer_variants.length
            ? p.bot_answer_variants : DEFAULT_BOT_ANSWERS,
          using_defaults: !(p && p.bot_answer_variants && p.bot_answer_variants.length),
          explicit: EXPLICIT_BOT_ANSWER,
        },
        rules: {
          playful_when: "a passing first ask",
          explicit_when: ["money is on the table", "asked more than once", "asking in earnest"],
          never: ["claim to be a person", "deny being automated", "stay silent"],
        },
      }, 200, origin);
    }

    if (url.pathname === "/persona" && request.method === "PUT") {
      if (me.role !== "admin") {
        const denied = await requireConsoleAdmin(env, request, origin);
        if (denied) return denied;
      }
      const b = await request.json().catch(() => ({}));
      const cid = String(b.creator_id || url.searchParams.get("creator") || me.id);

      // Validate every variant before anything is written. Tone is the
      // creator's; an answer that does not answer is not saved.
      const variants = Array.isArray(b.bot_answer_variants) ? b.bot_answer_variants : null;
      if (variants) {
        const bad = [];
        variants.forEach((v, i) => {
          const r = validateBotAnswer(String(v).replace(/\{name\}/g, b.display_name || cid));
          if (!r.ok) bad.push({ index: i, text: v, reason: r.reason });
        });
        if (bad.length) {
          return json({ error: "some answers were rejected", rejected: bad,
                        hint: "Keep the tone. Add the answer." }, 422, origin);
        }
      }

      const row = { creator_id: cid, updated_at: new Date().toISOString() };
      for (const k of ["display_name", "tone", "message_length", "emoji_level", "system_prompt",
                       "faq", "approved_links", "boundaries", "escalation_rules",
                       "memory_enabled", "model_provider", "model_id", "enabled",
                       "first_contact_line", "disclose_on_first_contact"]) {
        if (k in b) row[k] = b[k];
      }
      if (variants) row.bot_answer_variants = variants;

      // A third-party model means message content leaves our infrastructure,
      // which is the one case ToS 5.4(iv) requires customer authorisation for.
      if (row.model_provider && row.model_provider !== "workers-ai") {
        row.enabled = false;
        await sb(env, "audit_log", { method: "POST", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ creator_id: cid, action: "ai.provider.third_party_selected",
            detail: { provider: row.model_provider,
                      note: "disabled pending per-conversation customer consent" } }) }).catch(() => {});
      }

      const saved = await sb(env, "ai_profiles?on_conflict=creator_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(row),
      });
      return json({ saved: (saved && saved[0]) || row,
                    consent_required: row.model_provider && row.model_provider !== "workers-ai" },
                  200, origin);
    }

    // admin: the creator roster and per-creator records (used by the bot and the owner console)
    if (me.role === "admin") {
      if (url.pathname === "/creators" && request.method === "GET") {
        return json({ creators: await roster(env) }, 200, origin);
      }
      if (url.pathname === "/creator" && request.method === "POST") {
        const b = await request.json();
        const rec = { id: b.id, name: b.name || b.id, items: b.items || [],
                      bundles: b.bundles || [], style: b.style || {}, updatedAt: new Date().toISOString() };
        rec.dashboard_token = b.token || rec.dashboard_token;
        await saveRecord(env, rec, b.token);
        return json(rec, 200, origin);
      }
      if (url.pathname.startsWith("/creator/")) {
        return json(await record(env, url.pathname.split("/")[2]), 200, origin);
      }
    }


    return json({ error: "no route" }, 404, origin);
   } catch (e) {
     return new Response(JSON.stringify({ error: String(e).slice(0, 300) }),
       { status: 500, headers: { "Content-Type": "application/json" } });
   }
  },
};
