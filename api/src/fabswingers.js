/**
 * FabSwingers: log in, read the inbox, read a thread, send a reply.
 *
 * The site is classic ASP.NET: the login is a form post (field names email and
 * password) and the reply needs a `pat` token minted per thread by
 * /account/pm.aspx. Everything below is written against the live markup, not a
 * guess, so selectors are deliberately narrow and each one has a test row.
 */

const BASE = "https://www.fabswingers.com";
/* The big mailbox lists every conversation, 200 rows against 80 on the default
   page. Same markup, so the parser does not care. */
const INBOX = "/my/messagesnewbig";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";

const strip = (h) => String(h)
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<br\s*\/?>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/\s+/g, " ").trim();

const attr = (tag, name) => {
  const m = tag.match(new RegExp(name + '=["\']([^"\']*)["\']', "i"));
  return m ? m[1].replace(/&amp;/g, "&") : "";
};

const cookiesFrom = (r) => {
  const raw = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [r.headers.get("set-cookie") || ""];
  return raw.filter(Boolean).map((c) => c.split(";")[0]).filter((c) => c.includes("="));
};

/** Log in and return the cookie header for every later call. */
export async function login(username, password) {
  const pre = await fetch(BASE + "/login.aspx", { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "follow" });
  const jar = cookiesFrom(pre);
  const html = await pre.text();
  const forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)].map((m) => m[0]);
  const form = forms.find((f) => /<input[^>]+type=["']?password/i.test(f));
  if (!form) throw new Error("no login form on /login.aspx");

  const fields = [...form.matchAll(/<input\b[^>]*>/gi)].map((m) => m[0]);
  const body = new URLSearchParams();
  let usedEmail = false, usedPassword = false;
  for (const tag of fields) {
    const name = attr(tag, "name");
    if (!name) continue;
    const type = (attr(tag, "type") || "text").toLowerCase();
    if (type === "hidden") { body.set(name, attr(tag, "value")); continue; }
    if (type === "password") { body.set(name, password); usedPassword = true; continue; }
    if (type === "checkbox") { continue; }
    if (type === "submit") { continue; }
    if (type === "text" || type === "email") { body.set(name, username); usedEmail = true; continue; }
  }
  if (!usedEmail) body.set("email", username);
  if (!usedPassword) body.set("password", password);

  const res = await fetch(BASE + "/login.aspx", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA, Accept: "text/html",
      Referer: BASE + "/login.aspx",
      Cookie: jar.join("; "),
    },
    body: body.toString(),
    redirect: "manual",
  });
  const after = cookiesFrom(res);
  const all = [...new Set([...jar, ...after])];
  const authed = all.some((c) => /^ticket=/i.test(c)) && res.status >= 300 && res.status < 400;
  if (!authed) {
    const text = await res.text().catch(() => "");
    throw new Error("login refused: status " + res.status + " " + strip(text).slice(0, 160));
  }
  return { cookie: all.join("; "), status: res.status, location: res.headers.get("location") || "" };
}

/** Parse /my/messagesnew into rows, newest first as the site orders them. */
export function parseInbox(html) {
  const rows = [];
  const blocks = html.split(/<div id="pm_/i).slice(1);
  for (const raw of blocks) {
    const guid = (raw.match(/^([0-9a-f-]{36})/i) || [])[1];
    if (!guid) continue;
    const rowHtml = raw.split(/<input type="hidden" id="s_/i)[0];
    const tr = (rowHtml.match(/<tr class="messageRowx"[^>]*>/i) || [])[0] || "";
    const profileLink = rowHtml.match(/href="\/profile\/([^"\/]+)"/i) || [];
    const nameLink = rowHtml.match(/<a[^>]+href="\/my\/messagesnew\/[0-9a-f-]{36}"[^>]*>([\s\S]*?)<\/a>/i) || [];
    const ageLine = rowHtml.match(/<span style="[^"]*">([\s\S]*?)<\/span>/i) || [];
    const when = rowHtml.match(/<font color="#808080">([\s\S]*?)<\/font>/i) || [];
    const snippet = rowHtml.match(/<p style="margin-top: 8px[^"]*">([\s\S]*?)<\/p>/i) || [];
    // the site marks a thread unread with a hidden s_<guid> carrying 1, and
    // paints the row yellow. Either signal is enough.
    const unread = html.includes('id="s_' + guid + '" value="1"') || /#FFFF33/i.test(tr);
    rows.push({
      guid,
      user: (profileLink[1] || "").toLowerCase(),
      name: strip(nameLink[1] || ""),
      meta: strip(ageLine[1] || "").replace(/\s+/g, " ").trim(),
      when: strip(when[1] || ""),
      snippet: strip(snippet[1] || ""),
      unread,
    });
  }
  return rows;
}

/** Read one thread: sender, meta and the message blocks the site renders. */
export function parseThread(html) {
  const user = (html.match(/href="\/profile\/([^"\/]+)"/i) || [])[1] || "";
  const name = (html.match(/<a style="font-size: 10pt;" href="\/profile\/[^"]+">([\s\S]*?)<\/a>/i) || [])[1] || "";
  const meta = (html.match(/<div style="font-size: 10pt;; padding-bottom: 5px">([\s\S]*?)<\/div>/i) || [])[1] || "";
  const messages = [];
  const re = /<span class="standard-paragraph"[^>]*>([\s\S]*?)<\/span>/gi;
  let m;
  while ((m = re.exec(html))) {
    const text = strip(m[1].replace(/<\/?MessageText>/gi, " "));
    if (text) messages.push({ text });
  }
  const when = (html.match(/<font color="#808080">([\s\S]*?)<\/font>/i) || [])[1] || "";
  return { user: user.toLowerCase(), name: strip(name), meta: strip(meta).replace(/\s+/g, " "), when: strip(when), messages };
}

/** The reply page carries the hidden fields the POST needs, including `pat`. */
export async function replyTokens(cookie, user, guid) {
  const url = BASE + "/account/pm.aspx?username=" + encodeURIComponent(user) + "&pmguid=" + encodeURIComponent(guid);
  const r = await fetch(url, { headers: { "User-Agent": UA, Cookie: cookie, Accept: "text/html" }, redirect: "follow" });
  const html = await r.text();
  const form = (html.match(/<form[^>]*id="pmform"[\s\S]*?<\/form>/i) || [])[0];
  if (!form) {
    // the page says why: a block, a limit, or a thread that is closed to replies
    const why = strip(html).replace(/\s+/g, " ").slice(0, 200);
    throw new Error("reply form not found for " + user + " :: " + why);
  }
  const fields = {};
  for (const m of form.matchAll(/<input[^>]*>/gi)) {
    const name = attr(m[0], "name");
    if (name) fields[name] = attr(m[0], "value");
  }
  const textareaName = (form.match(/<textarea[^>]*name="([^"]+)"/i) || [])[1] || "messagetext";
  return { fields, textareaName };
}

/** Send one message on a thread. Returns the status so the caller can log it. */
export async function sendReply(cookie, user, guid, text) {
  const { fields, textareaName } = await replyTokens(cookie, user, guid);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  body.set("username", user);
  body.set("pmguid", guid);
  body.set(textareaName, text);
  const r = await fetch(BASE + "/account/pm.aspx", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA, Accept: "text/html",
      Cookie: cookie, Referer: BASE + "/account/pm.aspx",
    },
    body: body.toString(),
    redirect: "manual",
  });
  const page = await r.text().catch(() => "");
  return { ok: r.status >= 200 && r.status < 400, status: r.status, location: r.headers.get("location") || "", page };
}

/** Fetch the inbox with an existing cookie. If FabSwingers bounced us to the
    login page the cookie is stale: the caller logs in again. */
export async function inboxPage(cookie) {
  const r = await fetch(BASE + INBOX, {
    headers: { "User-Agent": UA, Cookie: cookie, Accept: "text/html" },
    redirect: "follow",
  });
  const html = await r.text();
  return { status: r.status, url: r.url, html, authed: !/\/login\.aspx/i.test(r.url) };
}

/** "Just this minute" / "23 minutes ago" / "2 hours ago" -> minutes, or null. */
export function ageMinutes(when) {
  const t = String(when || "").toLowerCase();
  if (/just this minute|just now|seconds ago/.test(t)) return 0;
  const m = t.match(/(\d+)\s*minute/); if (m) return Number(m[1]);
  const h = t.match(/(\d+)\s*hour/); if (h) return Number(h[1]) * 60;
  if (/an hour|1 hour/.test(t)) return 60;
  if (/yesterday/.test(t)) return 60 * 24;
  const d = t.match(/(\d+)\s*day/); if (d) return Number(d[1]) * 60 * 24;
  return null;
}

/** Everything the owner can see right now, read only. */
export async function inboxSnapshot(env, account) {
  const { openSecret } = await import("./crypto.js");
  if (!account.password_enc || !String(account.password_enc).includes(":")) {
    throw new Error("No usable password stored. Open Edit and save the FabSwingers password again.");
  }
  const password = await openSecret(env, account.password_enc);
  const session = await login(account.username, password);
  const r = await fetch(BASE + INBOX, { headers: { "User-Agent": UA, Cookie: session.cookie, Accept: "text/html" }, redirect: "follow" });
  const html = await r.text();
  return { rows: parseInbox(html), cookie: session.cookie, status: r.status };
}
