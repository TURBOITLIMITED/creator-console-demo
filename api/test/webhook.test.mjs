// End-to-end through the webhook with an in-memory PostgREST that enforces the
// live schema's failure modes. No network: Telegram is stubbed, the model is a
// fake env.AI.
import test from "node:test";
import assert from "node:assert/strict";
import { handleWebhook, onConnection, onMessage, onPaidMediaPurchase, sendStarsItem } from "../src/tg.js";
import { makeDb, makeEnv, stubTelegram, webhookRequest, KINDS_0018 } from "./helpers/fakedb.mjs";

const MICHAELA = 8886532645, TURBO_IT = 8380225719, MISS = 1712186662;
const ACC = "1b285c3a-0000-4000-8000-000000000001";
const ago = mins => new Date(Date.now() - mins * 60000).toISOString();

function seedBase(extra) {
  return {
    telegram_accounts: [{ id: ACC, creator_id: "7fbec2db", tg_user_id: 8903031106, username: "Michelle0161bot",
                          owner_tg_user_id: MICHAELA }],
    business_connections: [{ id: "q8Up", creator_id: "7fbec2db", telegram_account_id: ACC, tg_user_id: MICHAELA,
                             is_enabled: true, rights: {} }],
    ai_profiles: [{ creator_id: "7fbec2db", display_name: "Michaela", emoji_level: "medium" }],
    ...(extra || {}),
  };
}

const inbound = (updateId, bc, chatId, text, from) => ({
  update_id: updateId,
  business_message: {
    business_connection_id: bc, message_id: updateId, date: Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: "private", first_name: "Andy" },
    from: from || { id: chatId, first_name: "Andy" }, text,
  },
});

test("Fix 2: 'no thanks' with an unknown column on the PATCH still queues a reply", async () => {
  const convId = "9232805b-0000-4000-8000-000000000000";
  // The live table before 0018: no declined_at. The PATCH 400s.
  const { sb, t, calls } = makeDb({
    missingColumns: { conversations: ["declined_at"] },
    seed: seedBase({
      conversations: [{ id: convId, business_connection_id: "q8Up", chat_id: 5379366520, creator_id: "7fbec2db",
                        owner_tg_user_id: MICHAELA, purchase_intent_at: ago(60), memory: {}, last_message_at: ago(5) }],
      messages: [{ id: "m0", conversation_id: convId, direction: "in", sender: "customer", body_preview: "hi", sent_at: ago(5), raw: {} }],
    }),
  });
  const { env, queued } = makeEnv();
  const tgs = stubTelegram();
  try {
    const res = await handleWebhook(webhookRequest(inbound(9001, "q8Up", 5379366520, "no thanks babe")), env, sb, "michelle0161bot");
    assert.equal(res.status, 200);
  } finally { tgs.restore(); }
  assert.ok(calls.some(c => c.method === "PATCH" && c.body && c.body.declined_at), "the decline was attempted");
  assert.equal(queued.length, 1, "a reply was still queued");
  assert.equal(queued[0].body.conversation_id, convId);
  assert.equal(t.webhook_events[0].error, null, "no webhook error recorded");
});

test("Fix 2: with the column present the decline is stored", async () => {
  const convId = "c0000000-0000-4000-8000-000000000001";
  const { sb, t } = makeDb({ seed: seedBase({
    conversations: [{ id: convId, business_connection_id: "q8Up", chat_id: 42, creator_id: "7fbec2db",
                      owner_tg_user_id: MICHAELA, purchase_intent_at: ago(60), memory: {}, last_message_at: ago(5) }],
    messages: [{ id: "m0", conversation_id: convId, direction: "in", sender: "customer", body_preview: "hi", sent_at: ago(5), raw: {} }],
  }) });
  const { env, queued } = makeEnv();
  await handleWebhook(webhookRequest(inbound(9002, "q8Up", 42, "no thanks")), env, sb, "michelle0161bot");
  assert.ok(t.conversations[0].declined_at, "declined_at written");
  assert.equal(queued.length, 1);
});

test("Fix 4: a stranger connecting the bot is never claimed or answered", async () => {
  const { sb, t } = makeDb({ seed: seedBase() });
  const { env, queued } = makeEnv();
  const botAccount = t.telegram_accounts[0];
  const r = await onConnection(env, sb, { id: "iyGw", is_enabled: true, date: 1, rights: { can_reply: true },
    user: { id: TURBO_IT, first_name: "Turbo IT Team" } }, botAccount);
  assert.equal(r.claimed, false);
  const bc = t.business_connections.find(c => c.id === "iyGw");
  assert.equal(bc.creator_id, null, "creator_id stays null");
  // Miss messages the Turbo IT account; the bot must not answer in Michaela's voice.
  const out = await onMessage(env, sb, inbound(9003, "iyGw", MISS, "hey you", { id: MISS, first_name: "Miss" }).business_message, false);
  assert.equal(out.skipped, "unclaimed connection");
  assert.equal(queued.length, 0);
  assert.equal(t.conversations.length, 0, "no conversation stored under her account");
});

test("Fix 4: the named owner connecting is claimed", async () => {
  const { sb, t } = makeDb({ seed: seedBase() });
  const { env } = makeEnv();
  const r = await onConnection(env, sb, { id: "newConn", is_enabled: true, date: 1, rights: { can_reply: true },
    user: { id: MICHAELA, first_name: "Michaela" } }, t.telegram_accounts[0]);
  assert.equal(r.claimed, true);
  assert.equal(t.business_connections.find(c => c.id === "newConn").creator_id, "7fbec2db");
});

test("Fix 4: an account with no owner set claims nobody (fails closed)", async () => {
  const { sb, t } = makeDb({ seed: seedBase() });
  delete t.telegram_accounts[0].owner_tg_user_id;
  const { env } = makeEnv();
  const r = await onConnection(env, sb, { id: "x1", is_enabled: true, date: 1, rights: {},
    user: { id: MICHAELA } }, t.telegram_accounts[0]);
  assert.equal(r.claimed, false);
});

test("Fix 5: a reconnect keeps one conversation, and the history carries over", async () => {
  const { sb, t } = makeDb({ seed: seedBase({
    business_connections: [
      { id: "npYj", creator_id: "7fbec2db", telegram_account_id: ACC, tg_user_id: MICHAELA, is_enabled: true, rights: {} },
      { id: "q8Up", creator_id: "7fbec2db", telegram_account_id: ACC, tg_user_id: MICHAELA, is_enabled: true, rights: {} },
    ],
  }) });
  const { env, queued, aiCalls } = makeEnv();
  await onMessage(env, sb, inbound(9010, "npYj", 777, "hello gorgeous, I'm Andy").business_message, false);
  t.business_connections[0].is_enabled = false;                       // her account reconnects
  await onMessage(env, sb, inbound(9011, "q8Up", 777, "still waiting babe").business_message, false);
  assert.equal(t.conversations.length, 1, "one conversation across the reconnect");
  assert.equal(t.conversations[0].business_connection_id, "q8Up", "re-pointed at the live connection");
  assert.equal(t.conversations[0].owner_tg_user_id, MICHAELA);
  const lastAi = aiCalls[aiCalls.length - 1];
  assert.ok(lastAi.messages.some(m => /hello gorgeous/.test(m.content)), "second reply sees the first message");
  assert.ok(queued.length >= 1);
});

test("Fix 5: a different persona's account with the same chat stays separate", async () => {
  const ACC2 = "73f34fea-0000-4000-8000-000000000002";
  const { sb, t } = makeDb({ seed: seedBase({
    telegram_accounts: [
      { id: ACC, creator_id: "7fbec2db", tg_user_id: 1, username: "Michelle0161bot", owner_tg_user_id: MICHAELA },
      { id: ACC2, creator_id: "7fbec2db", tg_user_id: 2, username: "LittleMissMia_bot", owner_tg_user_id: MISS },
    ],
    business_connections: [
      { id: "q8Up", creator_id: "7fbec2db", telegram_account_id: ACC, tg_user_id: MICHAELA, is_enabled: true, rights: {} },
      { id: "t3BF", creator_id: "7fbec2db", telegram_account_id: ACC2, tg_user_id: MISS, is_enabled: true, rights: {} },
    ],
  }) });
  const { env } = makeEnv();
  await onMessage(env, sb, inbound(9020, "q8Up", TURBO_IT, "hi michaela", { id: TURBO_IT }).business_message, false);
  await onMessage(env, sb, inbound(9021, "t3BF", TURBO_IT, "hi miss", { id: TURBO_IT }).business_message, false);
  assert.equal(t.conversations.length, 2);
  assert.deepEqual(t.conversations.map(c => c.business_connection_id).sort(), ["q8Up", "t3BF"]);
});

test("Fix 3: a wall and two purchases record one wall row, two payment rows and two payments", async () => {
  const convId = "c0000000-0000-4000-8000-0000000000a1";
  const itemId = "e7e7ed06-0000-4000-8000-000000000001";
  const { sb, t } = makeDb({ kinds: KINDS_0018, seed: seedBase({
    bots: [{ persona: "michelle0161bot", token: "TOKEN", username: "Michelle0161bot" }],
    conversations: [{ id: convId, business_connection_id: "q8Up", chat_id: 8426347085, creator_id: "7fbec2db",
                      owner_tg_user_id: MICHAELA, memory: {} }],
    media_items: [{ id: itemId, title: "Shaking Ass in Doggy", kind: "video", price_gbp: 9.5, price_stars: 969,
                    media_key: "k/v.mp4", metadata: { tg_file_id: "FILE" }, visible: true }],
  }) });
  const { env } = makeEnv({ STAR_GBP_RATE: "0.0097" });
  const tgs = stubTelegram();
  let wall;
  try {
    const conn = t.business_connections[0];
    wall = await sendStarsItem(env, sb, conn, t.conversations[0], 8426347085, { ...t.media_items[0], source: "media" });
    const ppm = { from: { id: 8426347085 }, paid_media_payload: "v1|" + convId + "|" + itemId };
    await onPaidMediaPurchase(env, sb, ppm, 555001);
    await onPaidMediaPurchase(env, sb, ppm, 555002);               // same man, same price, second buy
  } finally { tgs.restore(); }
  assert.ok(wall && wall.tg_message_id);
  const walls = t.messages.filter(m => m.raw && m.raw.via === "stars-paid-media");
  assert.equal(walls.length, 1);
  assert.ok(walls[0].body_enc, "the wall row is sealed");
  assert.equal(t.messages.filter(m => m.kind === "payment").length, 2);
  assert.equal(t.payments.length, 2, "same buyer, same stars: two rows, no ref collision");
  assert.deepEqual(t.payments.map(p => p.processor_ref), ["stars:555001", "stars:555002"]);
  assert.equal(t.payments[0].amount_pence, Math.round(969 * 0.0097 * 100), "actual net, not list price");
  assert.equal(t.payments[0].fee_pence, 0);
  const mem = t.conversations[0].memory;
  assert.equal(mem.open_quote.status, "paid");
  assert.deepEqual(mem.bought, [itemId, itemId]);
  assert.equal(mem.last_media.item_id, itemId);
});

test("Fix 3: before 0018 the wall insert fails loudly, not silently, and nothing throws", async () => {
  const convId = "c0000000-0000-4000-8000-0000000000a2";
  const { sb, t } = makeDb({ kinds: ["text","photo","video","document","audio","voice","animation","sticker","media_group","other"],
    seed: seedBase({
      bots: [{ persona: "michelle0161bot", token: "TOKEN" }],
      conversations: [{ id: convId, business_connection_id: "q8Up", chat_id: 1, creator_id: "7fbec2db", memory: {} }],
    }) });
  const { env } = makeEnv();
  const logs = [];
  const realLog = console.log;
  console.log = s => { logs.push(String(s)); };
  const tgs = stubTelegram();
  try {
    await sendStarsItem(env, sb, t.business_connections[0], t.conversations[0], 1,
      { id: "i1", kind: "image", price_gbp: 5, media_key: "k", metadata: { tg_file_id: "F" }, source: "media" });
  } finally { tgs.restore(); console.log = realLog; }
  assert.ok(logs.some(l => /tg\.stars\.record_failed/.test(l)), "record_failed is logged");
});
