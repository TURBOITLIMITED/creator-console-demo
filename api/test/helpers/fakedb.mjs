// A small in-memory PostgREST stand-in for the webhook tests. It enforces the
// things that actually broke in production: an unknown column is a 400 (that
// is how declined_at ate a reply), messages_kind_check, the NOT NULLs on
// payments and the UNIQUE processor_ref. No network, no Supabase.
import { randomUUID, webcrypto } from "node:crypto";

const KINDS_LIVE = ["text","photo","video","document","audio","voice","animation","sticker","media_group","other"];
export const KINDS_0018 = [...KINDS_LIVE, "paid_media", "payment"];

export function makeDb(opts) {
  const o = opts || {};
  const t = {
    business_connections: [], conversations: [], customers: [], messages: [], telegram_accounts: [],
    payments: [], account_keys: [], webhook_events: [], audit_log: [], ai_profiles: [], account_personas: [],
    bots: [], media_items: [], telegram_menu_items: [],
    ...(o.seed || {}),
  };
  // Columns the "live" table does NOT have. Writing or filtering on one 400s.
  const missing = o.missingColumns || {};
  const kinds = o.kinds || KINDS_0018;
  const calls = [];

  const fail = (code, msg) => { throw new Error("supabase " + code + " " + msg); };
  const colOf = k => k.split("->>")[0];
  const checkCols = (table, keys) => {
    for (const k of keys) if ((missing[table] || []).includes(colOf(k))) fail(400, `column ${table}.${colOf(k)} does not exist`);
  };
  const get = (row, k) => {
    if (k.includes("->>")) { const [a, b] = k.split("->>"); const v = row[a] && row[a][b]; return v == null ? null : String(v); }
    return row[k];
  };
  const match = (row, k, expr) => {
    const v = get(row, k);
    if (expr === "is.null") return v == null;
    if (expr === "not.is.null") return v != null;
    if (expr.startsWith("eq.")) return v != null && String(v) === decodeURIComponent(expr.slice(3));
    if (expr.startsWith("neq.")) return String(v) !== decodeURIComponent(expr.slice(4));
    if (expr.startsWith("gte.")) return v != null && String(v) >= decodeURIComponent(expr.slice(4));
    if (expr.startsWith("in.(")) {
      const list = decodeURIComponent(expr.slice(4, -1)).split(",");
      return v != null && list.includes(String(v));
    }
    return true;
  };

  function parse(path) {
    const [table, qs] = path.split("?");
    const params = new URLSearchParams(qs || "");
    const filters = [];
    let order = null, limit = null, onConflict = null;
    for (const [k, v] of params) {
      if (k === "select") continue;
      if (k === "order") { order = v; continue; }
      if (k === "limit") { limit = Number(v); continue; }
      if (k === "on_conflict") { onConflict = v.split(","); continue; }
      filters.push([k, v]);
    }
    return { table, filters, order, limit, onConflict };
  }

  async function sb(env, path, init) {
    const q = parse(path);
    const method = (init && init.method) || "GET";
    const prefer = (init && init.headers && init.headers.Prefer) || "";
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path, body });
    if (!t[q.table]) t[q.table] = [];
    const rows = t[q.table];
    checkCols(q.table, q.filters.map(f => f[0]));
    const sel = () => {
      let r = rows.filter(row => q.filters.every(([k, v]) => match(row, k, v)));
      if (q.order) {
        const [col, dir] = q.order.split(",")[0].split(".");
        r = [...r].sort((a, b) => (String(a[col] ?? "") < String(b[col] ?? "") ? -1 : 1) * (dir === "desc" ? -1 : 1));
      }
      return q.limit ? r.slice(0, q.limit) : r;
    };
    if (method === "GET") return sel();
    if (method === "PATCH") {
      checkCols(q.table, Object.keys(body || {}));
      for (const row of sel()) Object.assign(row, body);
      return null;
    }
    if (method === "POST") {
      const list = Array.isArray(body) ? body : [body];
      const out = [];
      for (const b of list) {
        checkCols(q.table, Object.keys(b));
        if (q.table === "messages" && b.kind && !kinds.includes(b.kind)) fail(400, "violates check constraint messages_kind_check");
        if (q.table === "payments") {
          for (const c of ["amount_pence", "fee_pence", "processor_ref"]) if (b[c] == null) fail(400, "null value in column " + c);
          if (rows.some(r => r.processor_ref === b.processor_ref)) fail(409, "duplicate key processor_ref");
        }
        let existing = null;
        if (q.onConflict) existing = rows.find(r => q.onConflict.every(c => r[c] != null && String(r[c]) === String(b[c])));
        if (existing) {
          if (/ignore-duplicates/.test(prefer)) continue;
          Object.assign(existing, b);
          out.push(existing);
        } else {
          const row = { id: b.id || randomUUID(), ...b };
          if (q.table === "conversations" && row.memory === undefined && !(missing.conversations || []).includes("memory")) row.memory = {};
          rows.push(row);
          out.push(row);
        }
      }
      return /return=representation/.test(prefer) ? out : null;
    }
    return null;
  }
  return { sb, t, calls };
}

export function makeEnv(extra) {
  const queued = [];
  const aiCalls = [];
  const kek = Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const env = {
    DATA_KEK: kek,
    TELEGRAM_WEBHOOK_SECRET: "s3cret",
    SUPABASE_URL: "https://fake.supabase.local",
    SUPABASE_SERVICE_KEY: "x",
    REPLY_QUEUE: { send: async (body, o) => { queued.push({ body, opts: o }); } },
    AI: { run: async (model, input) => { aiCalls.push(input); return { response: "mmm tell me more about you 😘" }; } },
    ...(extra || {}),
  };
  return { env, queued, aiCalls };
}

/* Telegram API stub: every call succeeds with a message id. */
export function stubTelegram() {
  const real = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1000 + sent.length } }), { status: 200 });
  };
  return { sent, restore: () => { globalThis.fetch = real; } };
}

export function webhookRequest(update) {
  return new Request("https://worker.local/bots/hook/michelle0161bot", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "s3cret", "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
}
