// Creator CRM API: content, prices and style for a creator, stored in KV, media in R2.
// Auth: a Supabase session (console admin), or the operator token, in the
// Authorization header only. Query-string tokens and creator tokens were removed
// on 2026-10-20.
const CORS = (o) => ({
  "Access-Control-Allow-Origin": o || "*",
  "Access-Control-Allow-Methods": "GET,PUT,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type,X-Filename",
  "Access-Control-Max-Age": "86400",
});

const json = (data, status = 200, origin) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Vary": "Authorization", ...CORS(origin) },
  });

import { sign, timingSafe } from "./media.js";
import { sealSecret, openSecret } from "./crypto.js";
import { inboxSnapshot, inboxPage, login as fsLogin, ageMinutes, parseInbox, parseThread, sendReply } from "./fabswingers.js";
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


/* ============================================================
   FabSwingers poller
   Runs on the cron trigger. Only switched-on accounts, only unread threads
   that have not been answered yet, at most two per run. Anything that smells
   wrong (a phone number, money, a meet, or someone who might be under 18) is
   never answered: the thread is recorded with a reason and left for a human.
   ============================================================ */
const FS_STOP = [
  [/\b0\d{9,10}\b|\b\+44\s?\d/, "phone number"],
  [/\b(pay|payment|deposit|bank transfer|paypal|amazon voucher|cash)\b/i, "money talk"],
  [/\b(meet|meeting|come round|your address|where do you live|postcode)\b/i, "meet request"],
  [/\b(under ?18|underage|school|teen|15|16|17)\b/i, "age doubt"],
  [/\b(blackmail|screenshot|i know (where|who)|expose)\b/i, "threat"],
];
function fsStopReason(text){
  const t = String(text || "");
  for (const [re, why] of FS_STOP) if (re.test(t)) return why;
  return null;
}

async function fsDraftFor(env, acct, persona, row, thread){
  const rules = [
    persona.system_prompt || "You are a real woman chatting on FabSwingers. Be cheeky, playful and short.",
    persona.tone ? `Tone: ${persona.tone}.` : "",
    persona.emoji_level ? `Emoji use: ${persona.emoji_level}.` : "",
    persona.message_length ? `Message length: ${persona.message_length}.` : "",
    acct.telegram_username ? `Your Telegram is @${acct.telegram_username}. Flirt a little first, then when the chat is going well drop that handle into a normal message, once, in your own words, the way "obvs if you want to chat more, @${acct.telegram_username}" lands. Never as a message on its own and never repeat it. If he wants to be degraded, only tease him about it here: "you'd have to ask me nicely somewhere private". The real thing waits until he is on Telegram, never on FabSwingers.` : "",
    "Reply with the message text only. No quotes, no labels, no explanation.",
  ].filter(Boolean).join("\n");
  const history = (thread.messages || []).slice(-8).map((m) => m.text).join("\n") || row.snippet;
  const out = await env.AI.run(env.AI_MODEL || "@cf/mistralai/mistral-small-3.1-24b-instruct", {
    messages: [
      { role: "system", content: rules },
      { role: "user", content: `His profile: ${row.name}, ${row.meta}.\nWhat he has written:\n${history}\n\nWrite her next message to him.` },
    ],
    max_tokens: 220,
  });
  return String(typeof out === "string" ? out : (out && out.response) || "").trim().replace(/^["']|["']$/g, "");
}

/* Session reuse. Logging in fresh every tick is the loudest thing a scraper can
   do, so the cookie is sealed and kept in R2 between runs and only replaced
   when FabSwingers stops accepting it. */
const fsSessionKey = (id) => `fs-session/${id}.json`;
async function fsLoadRecord(env, acctId){
  try{
    const obj = await env.MEDIA.get(fsSessionKey(acctId));
    return obj ? await obj.json() : null;
  }catch(e){ return null; }
}
async function fsOpenCookie(env, rec){
  try{ return rec && rec.sealed ? await openSecret(env, rec.sealed) : null; }catch(e){ return null; }
}
async function fsSaveRecord(env, acctId, cookie, nextSendAt){
  try{
    await env.MEDIA.put(fsSessionKey(acctId), JSON.stringify({
      sealed: await sealSecret(env, cookie),
      at: new Date().toISOString(),
      next_send_at: nextSendAt || null,
    }));
  }catch(e){}
}
/* One answer at a time, between twenty seconds and a minute apart. The timer
   wakes once a minute, so in practice that is one message per tick: the long
   wander is gone, the two daily breaks are what make it read as a person. */
function humanGapSeconds(){
  return 20 + Math.random() * 40;
}
const UK_HOUR = () => Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: "Europe/London" }).format(new Date()));

/* Two breaks a day, roughly an hour each, at times that shift with the date
   instead of landing on the same clock minute every day. One is the small
   hours, one is the evening. */
function fsOfflineNow(){
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date()).reduce((a, p) => (a[p.type] = p.value, a), {});
  const nowMin = Number(parts.hour) * 60 + Number(parts.minute);
  const seed = Number(parts.year + parts.month + parts.day);
  const rnd = (n) => { const x = Math.sin(seed * 0.0001 + n) * 10000; return x - Math.floor(x); };
  const windows = [
    [2 * 60 + Math.floor(rnd(1) * 180), 60 + Math.floor(rnd(3) * 25)],   // 02:00 to 05:00
    [17 * 60 + Math.floor(rnd(2) * 180), 60 + Math.floor(rnd(4) * 25)],  // 17:00 to 20:00
  ];
  return windows.some(([start, len]) => nowMin >= start && nowMin < start + len);
}

/* FabSwingers asks free accounts to become a Site Supporter once a limit is
   hit. That has to reach the dashboard as an action, not disappear into a
   failed send. */
/* Only refusal wording counts. "Be a Site Supporter" sits in the site
   navigation of every page, so matching that phrase flagged every successful
   send as an upgrade wall. */
const FS_UPGRADE_RE = /(you (?:need|must|have) to be a site supporter|only site supporters can|site supporters can send|upgrade your account to (?:send|message|reply)|you(?:'ve| have) reached your (?:daily )?(?:message )?limit|out of messages (?:for )?today|daily message limit|free members can only send)/i;
function fsUpgradeAsked(html){ return FS_UPGRADE_RE.test(String(html || "")); }
const FS_RATE_RE = /(too many messages|slow down|rate limit|temporarily blocked|try again later|you are sending messages too quickly)/i;
function fsRateLimited(html){ return FS_RATE_RE.test(String(html || "")); }

/* Transcript log. The site keeps one message per thread view, so the console
   reads its own record of the exchange instead of trying to scrape a history
   page that does not exist. */
async function fsLogMessage(env, acctId, user, name, direction, body, at){
  if(!body) return;
  await sb(env, "fabswingers_messages", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ fabswingers_account_id: acctId, fs_user_id: user, fs_user_name: name || null,
      direction, body: String(body).slice(0, 2000), at: at || new Date().toISOString() }),
  }).catch(() => null);
}

async function fsAnsweredToday(env, acctId){
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const rows = await sb(env, `fabswingers_conversations?fabswingers_account_id=eq.${acctId}&notes=eq.answered&last_message_at=gte.${encodeURIComponent(start.toISOString())}&select=fs_user_id`).catch(() => []);
  return (rows || []).length;
}

async function pollFab(env){
  const accounts = await sb(env, "fabswingers_accounts?enabled=eq.true&select=*").catch(() => null);
  if(!accounts || !accounts.length) return;
  for(const acct of accounts){
    try{
      const personas = await sb(env, `fabswingers_personas?fabswingers_account_id=eq.${acct.id}&select=*`);
      const persona = personas && personas[0];
      if(!persona){
        await sb(env, `fabswingers_accounts?id=eq.${acct.id}`, { method:"PATCH", headers:{Prefer:"return=minimal"},
          body: JSON.stringify({ last_error: "No personality saved yet" }) }).catch(() => null);
        continue;
      }
      // she is online whenever the phone is, day or night. Whether this tick
      // sends is decided by the previous answer's gap, not by the clock, so the
      // spacing is uneven in the same way a person's is.
      // she is off the site twice a day, the way anyone is
      if (fsOfflineNow()) continue;

      const record = await fsLoadRecord(env, acct.id);
      const dueAt = record && record.next_send_at ? new Date(record.next_send_at).getTime() : 0;
      if (Date.now() < dueAt) continue;

      let cookie = await fsOpenCookie(env, record);
      let snap = null;
      if (cookie){
        const p = await inboxPage(cookie);
        if (p.authed) snap = { rows: parseInbox(p.html), cookie, html: p.html };
        else cookie = null;
      }
      if (!snap){
        const password = await openSecret(env, acct.password_enc);
        const s = await fsLogin(acct.username, password);
        cookie = s.cookie;
        await fsSaveRecord(env, acct.id, cookie, null);
        const p = await inboxPage(cookie);
        if (!p.authed) throw new Error("login was not accepted");
        snap = { rows: parseInbox(p.html), cookie, html: p.html };
      }
      const doneRows = await sb(env, `fabswingers_conversations?fabswingers_account_id=eq.${acct.id}&select=fs_user_id,notes,created_at`).catch(() => []);
      const done = new Map((doneRows || []).map((r) => [r.fs_user_id, r]));

      // First sight of an unread thread only starts its clock. The answer goes
      // out on a later tick, at least FS_MIN_WAIT seconds later, so nobody gets
      // a reply inside ten seconds of pressing send. One reply per run.
      const firstSeen = [];
      // older unread threads are left alone: answering something from weeks ago
      // reads as a bot working through a backlog, and it is exactly what gets
      // an account reported
      const maxAge = Number(env.FS_MAX_AGE_MIN || 180);
      const fresh = (x) => { const a = ageMinutes(x.when); return a === null || a <= maxAge; };
      for (const r of snap.rows.filter((x) => x.unread && !done.has(x.user) && fresh(x))){
        firstSeen.push(r);
        await sb(env, "fabswingers_conversations?on_conflict=fabswingers_account_id,fs_user_id", {
          method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({
            fabswingers_account_id: acct.id, fs_user_id: r.user, fs_user_name: r.name,
            message_count: 0, notes: "pending",
          }),
        }).catch(() => null);
      }

      // only real refusal wording in the inbox, not the site's own nav banner
      if (fsUpgradeAsked(snap.html)) {
        await sb(env, `fabswingers_accounts?id=eq.${acct.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ last_poll_at: new Date().toISOString(), last_error: "UPGRADE: FabSwingers is asking for a Site Supporter upgrade before more messages can be sent." }) }).catch(() => null);
        continue;
      }
      const dailyCap = Number(env.FS_DAILY_CAP || 150);
      if (await fsAnsweredToday(env, acct.id) >= dailyCap){
        await sb(env, `fabswingers_accounts?id=eq.${acct.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ last_error: `Daily cap reached (${dailyCap}). Resumes tomorrow.` }) }).catch(() => null);
        continue;
      }
      const minWait = Number(env.FS_MIN_WAIT || 45) * 1000;
      const ready = (doneRows || []).filter((r) => r.notes === "pending" && Date.now() - new Date(r.created_at).getTime() >= minWait);
      // one message per tick, never a burst: the next thread waits for the
      // next minute even when several are queued
      const todo = ready.length
        ? snap.rows.filter((r) => r.unread && ready.some((d) => d.fs_user_id === r.user)).slice(0, 1)
        : [];
      let halted = false, sent = 0;
      for(const row of todo){
        const reason = fsStopReason(row.snippet);
        let status = "sent", text = null;
        if(reason){
          status = "flagged: " + reason;
        } else {
          const inAge = ageMinutes(row.when);
          await fsLogMessage(env, acct.id, row.user, row.name, "in", row.snippet,
            new Date(Date.now() - (inAge || 0) * 60000).toISOString());
          const tr = await fetch("https://www.fabswingers.com/my/messagesnew/" + row.guid, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36", Cookie: snap.cookie, Accept: "text/html" },
            redirect: "follow",
          }).then((r) => r.text());
          const thread = parseThread(tr);
          text = await fsDraftFor(env, acct, persona, row, thread);
          const drafted = fsStopReason(text);
          if(!text){ status = "skipped: empty draft"; }
          else if(drafted){ status = "skipped: own reply mentioned " + drafted; }
          else {
            const res = await sendReply(snap.cookie, row.user, row.guid, text);
          if(res.ok) await fsLogMessage(env, acct.id, row.user, row.name, "out", text);
            if(!res.ok){ status = "send failed: " + res.status; }
            else if(fsRateLimited(res.page)){
              status = "rate limited";
              halted = true;
              await sb(env, `fabswingers_accounts?id=eq.${acct.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" },
                body: JSON.stringify({ last_error: "RATE: FabSwingers pushed back on sending. Poller paused for this account; check the inbox by hand." }) }).catch(() => null);
              await sb(env, "fabswingers_conversations?on_conflict=fabswingers_account_id,fs_user_id", {
                method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
                body: JSON.stringify({ fabswingers_account_id: acct.id, fs_user_id: row.user, fs_user_name: row.name, message_count: 0, notes: status }),
              }).catch(() => null);
              break;
            }
            else if(fsUpgradeAsked(res.page)){
              status = "UPGRADE asked";
              halted = true;
              await sb(env, `fabswingers_accounts?id=eq.${acct.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" },
                body: JSON.stringify({ last_error: "UPGRADE: FabSwingers is asking for a Site Supporter upgrade before more messages can be sent." }) }).catch(() => null);
            }
            else sent++;
          }
        }
        await sb(env, "fabswingers_conversations?on_conflict=fabswingers_account_id,fs_user_id", {
          method:"POST", headers:{Prefer:"resolution=merge-duplicates,return=minimal"},
          body: JSON.stringify({
            fabswingers_account_id: acct.id, fs_user_id: row.user, fs_user_name: row.name,
            message_count: 1, last_message_at: new Date().toISOString(),
            conversation_summary: text ? text.slice(0, 200) : null,
            notes: status === "sent" ? "answered" : status,
          }),
        }).catch(() => null);
      }
      await fsSaveRecord(env, acct.id, cookie, new Date(Date.now() + humanGapSeconds() * 1000).toISOString());
      await sb(env, `fabswingers_accounts?id=eq.${acct.id}`, { method:"PATCH", headers:{Prefer:"return=minimal"},
        body: JSON.stringify({ last_poll_at: new Date().toISOString(), last_error: halted ? undefined : null }) }).catch(() => null);
    }catch(e){
      await sb(env, `fabswingers_accounts?id=eq.${acct.id}`, { method:"PATCH", headers:{Prefer:"return=minimal"},
        body: JSON.stringify({ last_poll_at: new Date().toISOString(), last_error: String((e && e.message) || e).slice(0, 300) }) }).catch(() => null);
    }
  }
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

    // Diagnostic: log in with the sealed password and report what FabSwingers
    // actually serves. This is how the inbox parser gets built against the real
    // pages instead of a guess. Read only, no messages are sent.
    if (url.pathname === "/fabswingers/probe" && request.method === "POST") {
      const denied = await requireConsoleAdmin(env, request, origin);
      if (denied) return denied;
      const b = await request.json().catch(() => ({}));
      if (!b.id) return json({ error: "id is required" }, 400, origin);
      const rows = await sb(env, `fabswingers_accounts?id=eq.${b.id}&select=*`);
      const acct = rows && rows[0];
      if (!acct) return json({ ok: false, error: "unknown account" }, 404, origin);
      // password_enc holds sealed ciphertext (nonce:ct). The old sha256 hashes
      // contain no colon and cannot be logged in with, so they must be re-entered.
      if (!acct.password_enc || !String(acct.password_enc).includes(":")) {
        return json({ ok: false, error: "No usable password is stored for this login. Open Edit, type the FabSwingers password and save." }, 400, origin);
      }
      let password;
      try { password = await openSecret(env, acct.password_enc); }
      catch (e) { return json({ ok: false, error: "The stored password cannot be opened: " + String(e).slice(0, 120) }, 500, origin); }

      const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
      const setCookies = (r) => {
        const raw = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [r.headers.get("set-cookie") || ""];
        return raw.filter(Boolean).map((c) => c.split(";")[0]);
      };
      // FabSwingers is ASP.NET WebForms: the login is a form post carrying
      // __VIEWSTATE and friends, so the form has to be read before it is sent.
      const readForm = (html) => {
        const forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)].map((m) => m[0]);
        const form = forms.find((f) => /<input[^>]+type=["']?password/i.test(f)) || forms[0];
        if (!form) return null;
        const attr = (tag, name) => (tag.match(new RegExp(name + '=["\']([^"\']*)["\']', "i")) || [])[1];
        const fields = [];
        for (const m of form.matchAll(/<input\b[^>]*>/gi)) {
          const tag = m[0];
          const name = attr(tag, "name");
          if (!name) continue;
          const type = (attr(tag, "type") || "text").toLowerCase();
          const value = attr(tag, "value") || "";
          const checked = /\bchecked\b/i.test(tag);
          fields.push({ name, type, value, checked });
        }
        return {
          action: attr(form.match(/<form\b[^>]*>/i)[0], "action") || "",
          method: (attr(form.match(/<form\b[^>]*>/i)[0], "method") || "post").toLowerCase(),
          fields,
        };
      };
      let loginRes, cookies = [], loginText = "", formInfo = null;
      try {
        const g = await fetch("https://www.fabswingers.com/login.aspx", {
          headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml" },
          redirect: "follow",
        });
        const preCookies = setCookies(g);
        const html = await g.text();
        const form = readForm(html);
        if (!form) return json({ ok: false, error: "No login form found at /login.aspx" }, 502, origin);
        const userField = form.fields.find((f) => f.type !== "password" && f.type !== "hidden" && /user|email|login|name/i.test(f.name));
        const passField = form.fields.find((f) => f.type === "password");
        formInfo = {
          action: form.action, method: form.method,
          userField: userField && userField.name, passField: passField && passField.name,
          hidden: form.fields.filter((f) => f.type === "hidden").map((f) => f.name),
        };
        const body = new URLSearchParams();
        for (const f of form.fields) {
          if (f.type === "hidden") { body.set(f.name, f.value); continue; }
          if (f.type === "password") { body.set(f.name, password); continue; }
          if (f === userField) { body.set(f.name, acct.username); continue; }
          if (f.type === "checkbox") { if (f.checked) body.set(f.name, f.value || "on"); continue; }
          if (f.type === "submit") { continue; }
          body.set(f.name, f.value);
        }
        if (!userField) body.set("username", acct.username);
        if (!passField) body.set("password", password);
        cookies = preCookies;
        const action = new URL(form.action || "/login.aspx", "https://www.fabswingers.com").href;
        loginRes = await fetch(action, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": UA, "Accept": "text/html,application/xhtml+xml",
            "Referer": "https://www.fabswingers.com/login.aspx",
            ...(cookies.length ? { "Cookie": cookies.join("; ") } : {}),
          },
          body: body.toString(),
          redirect: "manual",
        });
        cookies = [...new Set([...cookies, ...setCookies(loginRes)])];
        loginText = await loginRes.text().catch(() => "");
      } catch (e) {
        return json({ ok: false, error: "Could not reach FabSwingers: " + String(e).slice(0, 160) }, 502, origin);
      }

      const cookieHeader = cookies.join("; ");
      // raw mode: hand back the page markup so the parser is written against the
      // real thing. Only console admins can call this.
      if (b.raw) {
        const path = typeof b.path === "string" && b.path.startsWith("/") ? b.path : "/my/messages";
        const r = await fetch("https://www.fabswingers.com" + path, {
          headers: { "User-Agent": UA, "Cookie": cookieHeader, "Accept": "text/html,application/xhtml+xml" },
          redirect: "follow",
        });
        const html = await r.text();
        return json({ ok: true, path, status: r.status, url: r.url, bytes: html.length,
          html: html.slice(0, Number(b.limit) || 14000),
          cookies: cookies.map((c) => c.split("=")[0]) }, 200, origin);
      }
      const strip = (h) => h
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/\s+/g, " ").trim();

      const pages = [];
      for (const path of ["/my/", "/messages/", "/webchat/"]) {
        try {
          const r = await fetch("https://www.fabswingers.com" + path, {
            headers: { "User-Agent": UA, "Cookie": cookieHeader, "Accept": "text/html,application/xhtml+xml" },
            redirect: "follow",
          });
          const html = await r.text();
          const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
          const links = [];
          const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
          let m;
          while ((m = re.exec(html)) && links.length < 400) {
            const href = m[1], text = strip(m[2]).slice(0, 60);
            if (/messag|mail|inbox|chat|pm|thread/i.test(href + " " + text)) links.push({ href, text });
          }
          pages.push({
            path, status: r.status, url: r.url, bytes: html.length,
            title: strip(title).slice(0, 120),
            text: strip(html).slice(0, 1400),
            links: links.slice(0, 40),
          });
        } catch (e) {
          pages.push({ path, error: String(e).slice(0, 160) });
        }
      }
      return json({
        ok: true,
        account: { username: acct.username, telegram_username: acct.telegram_username },
        login: { status: loginRes.status, location: loginRes.headers.get("location") || "", cookies: cookies.map((c) => c.split("=")[0]), form: formInfo, sample: strip(loginText).slice(0, 300) },
        pages,
      }, 200, origin);
    }

    /* ---- FabSwingers inbox: read the real site, draft, send ---- */
    const fsAccount = async (env, id) => {
      const rows = await sb(env, `fabswingers_accounts?id=eq.${id}&select=*`);
      return rows && rows[0];
    };

    if (url.pathname === "/fabswingers/inbox" && request.method === "POST") {
      const denied = await requireConsoleAdmin(env, request, origin);
      if (denied) return denied;
      const b = await request.json().catch(() => ({}));
      const acct = await fsAccount(env, b.id);
      if (!acct) return json({ ok: false, error: "unknown account" }, 404, origin);
      try {
        const snap = await inboxSnapshot(env, acct);
        return json({ ok: true, count: snap.rows.length, unread: snap.rows.filter((r) => r.unread).length, rows: snap.rows }, 200, origin);
      } catch (e) {
        return json({ ok: false, error: String((e && e.message) || e) }, 200, origin);
      }
    }

    // read-only view of the site's own pages, admin only, whitelisted paths.
    // Used to confirm a send actually landed and to read the thread markup.
    if (url.pathname === "/fabswingers/page" && request.method === "POST") {
      const denied = await requireConsoleAdmin(env, request, origin);
      if (denied) return denied;
      const b = await request.json().catch(() => ({}));
      const allowed = ["/my/messagesnew", "/my/sent_messages", "/my/messages"];
      const path = String(b.path || "");
      if (!allowed.includes(path) && !path.startsWith("/account/pm.aspx?")) {
        return json({ ok: false, error: "path not allowed" }, 400, origin);
      }
      const acct = await fsAccount(env, b.id);
      if (!acct) return json({ ok: false, error: "unknown account" }, 404, origin);
      try {
        const snap = await inboxSnapshot(env, acct);
        const r = await fetch("https://www.fabswingers.com" + path, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36", Cookie: snap.cookie, Accept: "text/html" },
          redirect: "follow",
        });
        const html = await r.text();
        const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        return json({ ok: true, status: r.status, text: text.slice(0, 6000), html: b.raw ? html.slice(0, 60000) : undefined }, 200, origin);
      } catch (e) {
        return json({ ok: false, error: String((e && e.message) || e) }, 200, origin);
      }
    }

    if (url.pathname === "/fabswingers/thread" && request.method === "POST") {
      const denied = await requireConsoleAdmin(env, request, origin);
      if (denied) return denied;
      const b = await request.json().catch(() => ({}));
      if (!b.guid) return json({ ok: false, error: "guid is required" }, 400, origin);
      const acct = await fsAccount(env, b.id);
      if (!acct) return json({ ok: false, error: "unknown account" }, 404, origin);
      try {
        const snap = await inboxSnapshot(env, acct);
        const row = snap.rows.find((r) => r.guid === b.guid) || { guid: b.guid, user: b.user || "" };
        const r = await fetch("https://www.fabswingers.com/my/messagesnew/" + b.guid, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36", Cookie: snap.cookie, Accept: "text/html" },
          redirect: "follow",
        });
        const html = await r.text();
        // raw is for working out the site's markup, admin only, and it never
        // goes near a message: read only, no sends
        if (b.raw) return json({ ok: true, row, thread: parseThread(html), html: html.slice(0, 60000) }, 200, origin);
        return json({ ok: true, row, thread: parseThread(html) }, 200, origin);
      } catch (e) {
        return json({ ok: false, error: String((e && e.message) || e) }, 200, origin);
      }
    }

    if (url.pathname === "/fabswingers/draft" && request.method === "POST") {
      const denied = await requireConsoleAdmin(env, request, origin);
      if (denied) return denied;
      const b = await request.json().catch(() => ({}));
      if (!b.guid) return json({ ok: false, error: "guid is required" }, 400, origin);
      const acct = await fsAccount(env, b.id);
      if (!acct) return json({ ok: false, error: "unknown account" }, 404, origin);
      try {
        const snap = await inboxSnapshot(env, acct);
        const row = snap.rows.find((r) => r.guid === b.guid);
        if (!row) return json({ ok: false, error: "That thread is not in the inbox any more" }, 404, origin);
        const tr = await fetch("https://www.fabswingers.com/my/messagesnew/" + b.guid, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36", Cookie: snap.cookie, Accept: "text/html" },
          redirect: "follow",
        }).then((r) => r.text());
        const thread = parseThread(tr);
        const personas = await sb(env, `fabswingers_personas?fabswingers_account_id=eq.${acct.id}&select=*`);
        const p = (personas && personas[0]) || {};
        const rules = [
          p.system_prompt || "You are a real woman chatting on FabSwingers. Be cheeky, playful and short.",
          p.tone ? `Tone: ${p.tone}.` : "",
          p.emoji_level ? `Emoji use: ${p.emoji_level}.` : "",
          p.message_length ? `Message length: ${p.message_length}.` : "",
          acct.telegram_username ? `Your Telegram is @${acct.telegram_username}. Flirt a little, then drop it inside a normal message when it fits, once, never as a standalone line. Degrading play only starts once he is on Telegram; on here you only tease him about it.` : "",
          "Reply with the message text only. No quotes, no labels, no explanation.",
        ].filter(Boolean).join("\n");
        const history = (thread.messages || []).slice(-8).map((m) => m.text).join("\n");
        const out = await env.AI.run(env.AI_MODEL || "@cf/mistralai/mistral-small-3.1-24b-instruct", {
          messages: [
            { role: "system", content: rules },
            { role: "user", content: `His profile: ${row.name}, ${row.meta}.\nWhat he has written so far:\n${history || row.snippet}\n\nWrite her next message to him.` },
          ],
          max_tokens: 220,
        });
        const text = String(typeof out === "string" ? out : (out && out.response) || "").trim().replace(/^["']|["']$/g, "");
        return json({ ok: true, row, thread, draft: text }, 200, origin);
      } catch (e) {
        return json({ ok: false, error: String((e && e.message) || e) }, 200, origin);
      }
    }

    if (url.pathname === "/fabswingers/send" && request.method === "POST") {
      const denied = await requireConsoleAdmin(env, request, origin);
      if (denied) return denied;
      const b = await request.json().catch(() => ({}));
      const acct = await fsAccount(env, b.id);
      if (!acct) return json({ ok: false, error: "unknown account" }, 404, origin);
      // A human tapping Send is not an auto-reply: the switch governs the
      // poller, not the operator. Without this you could not test the voice.
      const text = String(b.text || "").trim();
      if (!text) return json({ ok: false, error: "Nothing to send" }, 400, origin);
      if (!b.user || !b.guid) return json({ ok: false, error: "user and guid are required" }, 400, origin);
      try {
        const snap = await inboxSnapshot(env, acct);
        const res = await sendReply(snap.cookie, b.user, b.guid, text);
        if (res.ok) {
          await sb(env, "fabswingers_conversations?on_conflict=fabswingers_account_id,fs_user_id", {
            method: "POST",
            headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify({
              fabswingers_account_id: acct.id,
              fs_user_id: b.user,
              fs_user_name: b.name || null,
              message_count: 1,
              last_message_at: new Date().toISOString(),
            }),
          }).catch(() => null);
        }
        return json({ ok: res.ok, status: res.status }, res.ok ? 200 : 502, origin);
      } catch (e) {
        return json({ ok: false, error: String((e && e.message) || e) }, 200, origin);
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
        // sealed, not hashed: the scraper has to log in with this, and a hash
        // cannot be replayed. The KEK lives in Worker secrets, never Postgres.
        body.password_enc = await sealSecret(env, password);
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
      if (b.password) { body.password_enc = await sealSecret(env, b.password); body.password_nonce = crypto.randomUUID(); }
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

    // Manual poll: the same run the cron does, so a stuck timer can be poked
    // from the console without waiting for the next tick.
    if (url.pathname === "/fabswingers/poll" && request.method === "POST") {
      const denied = await requireConsoleAdmin(env, request, origin);
      if (denied) return denied;
      await pollFab(env);
      return json({ ok: true, ran: new Date().toISOString() }, 200, origin);
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

  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollFab(env));
  },
};
