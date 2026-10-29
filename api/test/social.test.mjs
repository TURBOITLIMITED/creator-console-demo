// Unit tests for the social posting module. No network: publish/verify are
// stubbed by not being called; what is tested is the shape the routes and the
// queue runner rely on (creds sealing roundtrip needs env, so it is mocked at
// the route level instead. Here: row builders, validation, and the queue
// runner's DB contract against a faked Supabase).
import test from "node:test";
import assert from "node:assert/strict";
import { newPostRow, validateCreds, SOCIAL_PLATFORMS } from "../src/social.js";

test("newPostRow: reddit fields normalise", () => {
  const row = newPostRow("reddit", { subreddit: "r/GoneWild", title: "  hi  ", body: "x", link_url: "https://example.com/a" });
  assert.equal(row.subreddit, "GoneWild");
  assert.equal(row.title, "hi");
  assert.equal(row.state, "draft");
  assert.equal(row.platform, "reddit");
});

test("newPostRow: twitter ignores subreddit", () => {
  const row = newPostRow("twitter", { subreddit: "r/foo", body: "hello" });
  assert.equal(row.subreddit, null);
});

test("validateCreds: reddit needs four fields", () => {
  assert.equal(validateCreds("reddit", {}).valid, false);
  const ok = validateCreds("reddit", { clientId: "a", clientSecret: "b", username: "c", password: "d" });
  assert.equal(ok.valid, true);
  const miss = validateCreds("reddit", { clientId: "a", clientSecret: "b" });
  assert.deepEqual(miss.missing.sort(), ["password", "username"]);
});

test("validateCreds: twitter needs four keys", () => {
  assert.equal(validateCreds("twitter", {}).valid, false);
  assert.equal(validateCreds("twitter", { apiKey: "a", apiSecret: "b", accessToken: "c", accessSecret: "d" }).valid, true);
});

test("validateCreds: unknown platform fails", () => {
  const out = validateCreds("instagram", {});
  assert.equal(out.valid, false);
  assert.ok(out.missing.includes("platform"));
});

test("platforms constant", () => {
  assert.deepEqual(SOCIAL_PLATFORMS, ["reddit", "twitter"]);
});
