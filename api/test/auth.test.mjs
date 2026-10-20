// Regression tests for the console-admin gate (C1, 2026-10-20).
// Before the fix any three-part bearer string was accepted as an admin, and the
// call sites tested the returned object for truthiness, so the 403 never fired.
// These tests pin the fail-closed behaviour and the 404-vs-403 contract.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const ENV = {
  SUPABASE_URL: "https://sb.test",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_KEY: "service-key",
  ADMIN_TOKEN: "operator-token-1234567890",
  MEDIA_SECRET: "media-secret-abcdefghij",
  TELEGRAM_WEBHOOK_SECRET: "wh-secret",
};

// Tokens the fake Supabase understands. The middle part must decode to a JSON
// payload because whoami reads `aal` from it and requires aal2 for admin.
const jwt = (aal) => "h." + Buffer.from(JSON.stringify({ aal, sub: "u-" + aal })).toString("base64url") + ".s";
const GOOD = jwt("aal2");      // valid MFA session for a console admin
const AAL1 = jwt("aal1");      // same user, password only
const NONADMIN = "ddd." + Buffer.from(JSON.stringify({ aal: "aal2", sub: "x" })).toString("base64url") + ".fff";
const JUNK = "jjj.kkk.lll";    // three parts, no session at all

function stubSupabase({ admins = [GOOD] } = {}) {
  const seen = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const h = new Headers(init.headers || {});
    const auth = (h.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    seen.push(url);
    if (url.endsWith("/auth/v1/user")) {
      if (auth === GOOD || auth === AAL1 || auth === NONADMIN) {
        return new Response(JSON.stringify({ email: auth === GOOD ? "op@x.test" : "nobody@x.test" }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "bad jwt" }), { status: 401 });
    }
    if (url.includes("/rest/v1/rpc/is_console_admin")) {
      return new Response(JSON.stringify(admins.includes(auth)), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  };
  return seen;
}

async function call(path, { method = "GET", token, body, env = ENV } = {}) {
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  if (body) headers["Content-Type"] = "application/json";
  const req = new Request("https://api.test" + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  return worker.fetch(req, env);
}

test("junk three-part token is rejected on /bots/connection", async () => {
  const seen = stubSupabase();
  const r = await call("/bots/connection?username=ava", { token: JUNK });
  assert.equal(r.status, 403);
  const j = await r.json();
  assert.equal(j.error, "not allowed");
  // it must not have reached the account lookup
  assert.equal(seen.some((u) => u.includes("telegram_accounts")), false);
});

test("junk token is rejected on POST /bots/hook", async () => {
  stubSupabase();
  const r = await call("/bots/hook", { method: "POST", token: JUNK, body: { persona: "ava" } });
  assert.equal(r.status, 403);
});

test("no token is rejected on admin routes", async () => {
  stubSupabase();
  assert.equal((await call("/tgfile?f=1&bc=2")).status, 403);
  assert.equal((await call("/bots/hook", { method: "POST", body: {} })).status, 403);
});

test("a valid session that is not a console admin gets 403", async () => {
  stubSupabase({ admins: [GOOD] });
  const r = await call("/bots/connection?username=ava", { token: NONADMIN });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).reason, "not an admin");
});

test("console admin passes the gate, missing account is 404 (not 403)", async () => {
  stubSupabase({ admins: [GOOD] });
  const r = await call("/bots/connection?username=nobody-here", { token: GOOD });
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, "account not found");
});

test("operator token still works", async () => {
  stubSupabase();
  const r = await call("/bots/connection?username=ava", { token: ENV.ADMIN_TOKEN });
  assert.equal(r.status, 404); // account does not exist in the stub, so auth passed
  const list = await call("/bots", { token: ENV.ADMIN_TOKEN });
  assert.equal(list.status, 200);
});

test("a token in the query string is no longer accepted", async () => {
  stubSupabase();
  const r = await call("/bots/connection?username=ava&t=" + GOOD);
  assert.equal(r.status, 403);
});

test("junk token cannot reach a creator record", async () => {
  stubSupabase();
  const r = await call("/creator/ava", { token: JUNK });
  assert.equal(r.status, 401);
});

test("media fails closed: bad signature 403, missing secret 500", async () => {
  stubSupabase();
  const exp = Math.floor(Date.now() / 1000) + 60;
  const bad = await call(`/m/paid/file.jpg?e=${exp}&s=deadbeef`);
  assert.equal(bad.status, 403);
  const noSecret = await call(`/m/paid/file.jpg?e=${exp}&s=deadbeef`, {
    env: { ...ENV, MEDIA_SECRET: "" },
  });
  assert.equal(noSecret.status, 500);
});

test("console admin session reaches an admin route (role admin, not nobody)", async () => {
  stubSupabase({ admins: [GOOD] });
  const r = await call("/settings", { token: GOOD });
  assert.equal(r.status, 200);
});

test("a password-only (aal1) session of an admin user is still refused", async () => {
  stubSupabase({ admins: [GOOD] });
  const r = await call("/settings", { token: AAL1 });
  assert.equal(r.status, 403);
});

test("/sign cannot mint an inbox-media signature", async () => {
  stubSupabase();
  const r = await call("/sign", { method: "POST", token: ENV.ADMIN_TOKEN,
    body: { key: "tgfile|FILE123|conn-1", ttl: 604800 } });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "reserved key");
});

test("non-admin session still cannot reach an admin route", async () => {
  stubSupabase({ admins: [GOOD] });
  const r = await call("/settings", { token: NONADMIN });
  assert.equal(r.status, 403);
});

test("inbox media: signed URL is issued to an admin and accepted by /tgfile", async () => {
  stubSupabase();
  const signRes = await call("/tgfile/sign?f=FILE123&bc=conn-1", { token: ENV.ADMIN_TOKEN });
  assert.equal(signRes.status, 200);
  const { url } = await signRes.json();
  assert.match(url, /^\/tgfile\?f=FILE123&bc=conn-1&e=\d+&s=[0-9a-f]{32}$/);
  // signed URL passes the gate without a header; the stub has no such connection
  const media = await call(url);
  assert.equal(media.status, 404);
  assert.equal((await media.json()).error, "unknown connection");
});

test("inbox media: tampered signature, missing signature and expiry all 403", async () => {
  stubSupabase();
  const signRes = await call("/tgfile/sign?f=FILE123&bc=conn-1", { token: ENV.ADMIN_TOKEN });
  const { url } = await signRes.json();
  const tampered = url.replace(/s=[0-9a-f]{32}$/, "s=" + "0".repeat(32));
  assert.equal((await call(tampered)).status, 403);
  const bare = url.replace(/&e=\d+&s=[0-9a-f]{32}$/, "");
  assert.equal((await call(bare)).status, 403);
  const exp = Math.floor(Date.now() / 1000) - 10;
  const old = url.replace(/e=\d+/, "e=" + exp);
  assert.equal((await call(old)).status, 403);
});

test("/tgfile/sign itself requires an admin", async () => {
  stubSupabase();
  assert.equal((await call("/tgfile/sign?f=FILE123&bc=conn-1")).status, 403);
  assert.equal((await call("/tgfile/sign?f=FILE123&bc=conn-1", { token: JUNK })).status, 403);
});

test("Telegram webhook still answers 200 with its secret header", async () => {
  stubSupabase();
  const req = new Request("https://api.test/tg/ava", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": ENV.TELEGRAM_WEBHOOK_SECRET },
    body: JSON.stringify({ update_id: 1 }),
  });
  const r = await worker.fetch(req, ENV);
  assert.equal(r.status, 200);
});

test("Telegram webhook refuses a wrong secret", async () => {
  stubSupabase();
  const req = new Request("https://api.test/tg/ava", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "wrong" },
    body: JSON.stringify({ update_id: 1 }),
  });
  assert.equal((await worker.fetch(req, ENV)).status, 401);
});
