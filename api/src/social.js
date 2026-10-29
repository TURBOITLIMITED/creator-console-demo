// Social posting engine: Reddit and Twitter accounts, sealed credentials and a
// post queue the Worker's cron publishes when due.
//
// Credentials are sealed with the app KEK (crypto.js), never plaintext at
// rest: the Worker must replay them, exactly like FabSwingers passwords.
//
// Reddit uses OAuth "app-only" for reading public data and "script" app
// (password grant) for posting as the account. Twitter uses API v2 with OAuth
// 1.0a request signing for posting (the only path that still works without a
// paid tier) and app-only Bearer for lookups.

import { sealSecret, openSecret } from "./crypto.js";

// ---------------------------------------------------------------- helpers

export const SOCIAL_PLATFORMS = ["reddit", "twitter"];

export function newPostRow(platform, fields) {
  return {
    platform,
    subreddit: platform === "reddit" && fields.subreddit ? String(fields.subreddit).replace(/^r\//i, "").trim() : null,
    title: fields.title ? String(fields.title).trim().slice(0, 300) : null,
    body: fields.body != null ? String(fields.body).trim().slice(0, 4000) : null,
    media_key: fields.media_key || null,
    link_url: fields.link_url || null,
    state: "draft",
  };
}

export function newAccountRow(platform, username, creds) {
  return {
    platform,
    username: String(username).replace(/^@/, "").trim(),
    creds_enc: null, // set by the caller after sealing
    enabled: true,
    _creds: creds,   // transient; stripped before insert
  };
}

export async function sealCreds(env, creds) {
  return sealSecret(env, JSON.stringify(creds));
}

export async function openCreds(env, sealed) {
  return JSON.parse(await openSecret(env, sealed));
}

export function validateCreds(platform, creds) {
  const c = creds || {};
  const missing = [];
  if (platform === "reddit") {
    if (!c.clientId) missing.push("clientId");
    if (!c.clientSecret) missing.push("clientSecret");
    if (!c.username) missing.push("username");
    if (!c.password) missing.push("password");
  } else if (platform === "twitter") {
    if (!c.apiKey) missing.push("apiKey");
    if (!c.apiSecret) missing.push("apiSecret");
    if (!c.accessToken) missing.push("accessToken");
    if (!c.accessSecret) missing.push("accessSecret");
  } else {
    missing.push("platform");
  }
  return { valid: missing.length === 0, missing };
}

// ---------------------------------------------------------------- reddit

const REDDIT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const REDDIT_API = "https://oauth.reddit.com";

async function redditToken(env, creds) {
  const basic = btoa(creds.clientId + ":" + creds.clientSecret);
  const form = new URLSearchParams({
    grant_type: "password",
    username: creds.username,
    password: creds.password,
  });
  const r = await fetch(REDDIT_TOKEN_URL, {
    method: "POST",
    headers: { Authorization: "Basic " + basic, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error("reddit login " + r.status + " " + JSON.stringify(d).slice(0, 160));
  return d.access_token;
}

// A stable User-Agent: Reddit suspends bots that send none or a browser one.
const redditUA = (env) => env.SOCIAL_REDDIT_UA || "linux:turboit.creator-console:v1.0 (by /u/creator_console)";

export async function redditVerify(env, creds) {
  const token = await redditToken(env, creds);
  const r = await fetch(REDDIT_API + "/api/v1/me", {
    headers: { Authorization: "bearer " + token, "User-Agent": redditUA(env) },
  });
  if (!r.ok) throw new Error("reddit /me " + r.status);
  const me = await r.json().catch(() => ({}));
  return { ok: true, username: me.name || creds.username, karma: (me.total_karma || 0) };
}

/** Publish one queued reddit post. Returns { url } on success. */
export async function redditPublish(env, creds, post) {
  const token = await redditToken(env, creds);
  const form = new URLSearchParams({ api_type: "json" });
  if (post.link_url) {
    // link post
    form.set("url", post.link_url);
    form.set("title", post.title || "");
    form.set("sr", post.subreddit);
    form.set("kind", "link");
  } else if (post.media_key) {
    // media post: the file lives in R2; reddit needs a public URL, so media
    // posts are made as link posts to a signed /m/ URL with a long expiry.
    const { sign } = await import("./media.js");
    const exp = Math.floor(Date.now() / 1000) + 7 * 86400;
    const sig = await sign(post.media_key, exp, env.MEDIA_SECRET);
    form.set("url", `https://api-telebotcreator.turboit.uk/m/${encodeURIComponent(post.media_key)}?e=${exp}&s=${sig}`);
    form.set("title", post.title || "");
    form.set("sr", post.subreddit);
    form.set("kind", "link");
  } else {
    // self post
    form.set("text", post.body || "");
    form.set("title", post.title || "");
    form.set("sr", post.subreddit);
    form.set("kind", "self");
  }
  const r = await fetch(REDDIT_API + "/api/submit", {
    method: "POST",
    headers: { Authorization: "bearer " + token, "User-Agent": redditUA(env), "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const d = await r.json().catch(() => ({}));
  const j = (d && d.json) || {};
  if (j.errors && j.errors.length) throw new Error("reddit submit: " + JSON.stringify(j.errors).slice(0, 200));
  const url = (j.data && j.data.url) || null;
  if (!url) throw new Error("reddit submit returned no url: " + JSON.stringify(d).slice(0, 200));
  return { url };
}

// ---------------------------------------------------------------- twitter

const TWITTER_API = "https://api.twitter.com/2";
const TWITTER_UPLOAD = "https://upload.twitter.com/1.1/media/upload.json";

// OAuth 1.0a request signing, the only path that posts without a paid tier.
async function oauth1Header(method, url, params, token, secret, apiKey, apiSecret) {
  const enc = encodeURIComponent;
  const oauth = {
    oauth_consumer_key: apiKey,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: token,
    oauth_version: "1.0",
  };
  const all = { ...oauth, ...(params || {}) };
  const base = Object.keys(all).sort().map((k) => enc(k) + "=" + enc(all[k])).join("&");
  const baseStr = [method.toUpperCase(), enc(url), enc(base)].join("&");
  const key = enc(apiSecret) + "&" + enc(secret);
  const sigRaw = await crypto.subtle.importKey("raw", new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", sigRaw, new TextEncoder().encode(baseStr));
  const sig = btoa(String.fromCharCode(...new Uint8Array(mac)));
  const header = "OAuth " + Object.keys(oauth).map((k) => enc(k) + '="' + enc(oauth[k]) + '"').join(", ")
    + ', oauth_signature="' + enc(sig) + '"';
  return header;
}

export async function twitterVerify(env, creds) {
  const auth = await oauth1Header("GET", TWITTER_API + "/users/me", null,
    creds.accessToken, creds.accessSecret, creds.apiKey, creds.apiSecret);
  const r = await fetch(TWITTER_API + "/users/me", { headers: { Authorization: auth } });
  if (!r.ok) throw new Error("twitter /users/me " + r.status + " " + (await r.text()).slice(0, 160));
  const d = await r.json();
  return { ok: true, username: d.data && d.data.username, name: d.data && d.data.name };
}

/** Publish one queued tweet. Returns { url } on success. */
export async function twitterPublish(env, creds, post) {
  let mediaId = null;
  if (post.media_key) {
    const obj = await env.MEDIA.get(post.media_key);
    if (obj) {
      const buf = new Uint8Array(await obj.arrayBuffer());
      const b64 = btoa(String.fromCharCode(...buf));
      const auth = await oauth1Header("POST", TWITTER_UPLOAD, { media_category: "tweet_image" },
        creds.accessToken, creds.accessSecret, creds.apiKey, creds.apiSecret);
      const form = new URLSearchParams({ media_data: b64, media_category: "tweet_image" });
      const r = await fetch(TWITTER_UPLOAD, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.media_id_string) throw new Error("twitter upload " + r.status + " " + JSON.stringify(d).slice(0, 160));
      mediaId = d.media_id_string;
    }
  }
  const payload = { text: String(post.body || post.title || "").slice(0, 280) };
  if (mediaId) payload.media = { media_ids: [mediaId] };
  const auth = await oauth1Header("POST", TWITTER_API + "/tweets", payload,
    creds.accessToken, creds.accessSecret, creds.apiKey, creds.apiSecret);
  const r = await fetch(TWITTER_API + "/tweets", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("twitter tweet " + r.status + " " + JSON.stringify(d).slice(0, 200));
  const id = d.data && d.data.id;
  const username = creds.username || "i";
  return { url: id ? `https://x.com/${username}/status/${id}` : null };
}

// ---------------------------------------------------------------- queue runner

/** Publish every scheduled post whose time has come. Called from cron. */
export async function socialPostTick(env, sb) {
  const now = new Date().toISOString();
  const due = await sb(env, `social_posts?state=eq.scheduled&scheduled_at=lte.${now}&select=*&limit=5`).catch(() => []);
  if (!due || !due.length) return { posted: 0 };
  let posted = 0;
  for (const post of due) {
    try {
      const accts = await sb(env, `social_accounts?id=eq.${post.account_id}&select=*`);
      const acct = accts && accts[0];
      if (!acct || !acct.enabled) continue;
      const creds = await openCreds(env, acct.creds_enc);
      const out = post.platform === "reddit" ? await redditPublish(env, creds, post) : await twitterPublish(env, creds, post);
      await sb(env, `social_posts?id=eq.${post.id}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ state: "posted", posted_at: new Date().toISOString(), post_url: out.url, error_message: null }),
      });
      await sb(env, `social_accounts?id=eq.${acct.id}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ posts_total: (acct.posts_total || 0) + 1, last_post_at: new Date().toISOString(), last_error: null }),
      });
      posted++;
    } catch (e) {
      const why = String((e && e.message) || e).slice(0, 300);
      const failed = (post.tries || 0) + 1;
      await sb(env, `social_posts?id=eq.${post.id}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ state: "failed", error_message: why, tries: failed }),
      }).catch(() => null);
      await sb(env, `social_accounts?id=eq.${post.account_id}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ last_error: why }),
      }).catch(() => null);
    }
  }
  return { posted };
}
