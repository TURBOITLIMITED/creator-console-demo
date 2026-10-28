/**
 * Telegram Business webhook receiver.
 *
 * This is the route `/bots/hook` has been pointing Telegram at since day one
 * and which has never existed. Until now every real update got a 401.
 *
 * Order matters and is load-bearing:
 *   1. verify the secret header   - before touching the body
 *   2. record + dedupe the update - before doing any work, because Telegram
 *                                   retries on timeout and a double-send to a
 *                                   real customer is unrecoverable
 *   3. route                      - never let a handler error 500 back to
 *                                   Telegram, or it retries the same update
 *                                   forever
 */

import * as tg from "./telegram.js";
import { getDek, seal, open, preview } from "./crypto.js";
import { isAskingIfBot, isAskingForHuman, hasAgeSignal, COPY_VERSION } from "./copy.js";
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Human timing. A reply lands 20 seconds to 2 minutes later. When the chat is
   going nowhere (a nudge, or a two-word reply after a long quiet spell) it
   takes 2 to 3 minutes, the way someone half-interested would. */
export function replyDelaySeconds(text, conv, opts) {
  const o = opts || {};
  const t = String(text || "").trim().toLowerCase();
  // A man with his cock in his hand is not kept waiting. Anything sexual, or a
  // picture or voice note, gets a fast reply; a man who is already being
  // answered by the owner gets the same, because the account is plainly online.
  const SEX = /\b(cock|dick|pussy|wet|horny|hard|wank|fuck|fucking|naked|nude|tits|arse|ass|knickers|cum|stroke|touching|touch myself|playing with|want you|inside me|ride|suck)\b/i;
  const horny = SEX.test(t) || SEX.test(String(o.priorText || "")) || !!o.sentMedia;
  // Faster than a flat draw, but tied to how long the message would take to
  // type. A four-word line can land in eight seconds; a long one cannot, or it
  // reads as a machine again.
  const replyWords = String(o.replyText || "").split(/\s+/).filter(Boolean).length;
  const typing = Math.min(14000, 1200 + replyWords * 600);
  // Engagement curve. A stranger waits; a man she has been talking to for a
  // while gets an answer at the speed of someone already in the conversation.
  // 0 messages in -> ~55s, 25+ -> ~15s, with the spread narrowing as it warms.
  const his = Number(o.hisCount) || 0;
  const e = Math.min(1, Math.max(0, (his - 1) / 24));
  const base = 55 - 40 * e;
  const spread = 25 - 14 * e;
  if (o.ownerOnline) return Math.max(10, Math.round((typing + 3500 + Math.random() * 2500) / 1000));
  if (horny) return Math.max(10, Math.round((typing + 5000 + 3000 * (1 - e) + Math.random() * 4000) / 1000));
  return Math.max(12, Math.round(base + (Math.random() - 0.5) * 2 * spread));
}

/* The deterministic sends (menu, payment request, freebie) used to land the
   instant he typed, which reads as a machine. Show typing and hold for a beat
   the way the model path does. */
async function humanPace(token, connId, chatId, text) {
  if (!token || !chatId) return;
  const words = String(text || "").split(/\s+/).filter(Boolean).length;
  const hold = Math.min(12000, 2500 + words * 400 + Math.random() * 2500);
  let typing = true;
  (async () => {
    while (typing) {
      await tg.sendChatAction(token, connId, chatId, "typing").catch(() => {});
      await sleep(4500);
    }
  })();
  await sleep(hold);
  typing = false;
}

import { pickBotAnswer, isSeriousRequest, isPurchaseContext } from "./persona.js";
import { sign as signMedia } from "./media.js";
import { buildPushPayload } from "@block65/webcrypto-web-push";

const ok = () => new Response("", { status: 200 });

const upsert = (sb, env, table, onConflict, row, prefer) =>
  sb(env, `${table}?on_conflict=${onConflict}`, {
    method: "POST",
    headers: { Prefer: prefer || "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(row),
  });

/** Insert the update; an empty result means we have seen this update_id before. */
async function claimUpdate(sb, env, update, kind, bcId) {
  const rows = await sb(env, "webhook_events?on_conflict=update_id", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({
      update_id: update.update_id,
      kind,
      business_connection_id: bcId || null,
      raw: update,
    }),
  });
  return !!(rows && rows.length);     // true = first time, false = replay
}

const finish = (sb, env, updateId, error) =>
  sb(env, "webhook_events?update_id=eq." + updateId, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ processed_at: new Date().toISOString(), error: error || null }),
  }).catch(() => {});

function updateKind(u) {
  for (const k of ["business_connection", "business_message", "edited_business_message",
                   "deleted_business_messages", "callback_query", "pre_checkout_query",
                   "purchased_paid_media", "edited_message", "message"]) {
    if (u[k] !== undefined) return k;
  }
  return "unknown";
}

function bcIdOf(u) {
  const o = u.business_message || u.edited_business_message || u.deleted_business_messages ||
            u.business_connection || u.callback_query;
  if (!o) return null;
  return o.business_connection_id || (u.business_connection && u.business_connection.id) || null;
}

// ---------------------------------------------------------------------------
// business_connection: the owner granted, changed or revoked our access
// ---------------------------------------------------------------------------
async function onConnection(env, sb, conn, botAccount) {
  const n = tg.normaliseConnection(conn);
  const u = n.user || {};

  // The account row is keyed on the stable Telegram user id, never the username.
  // Only upsert when an account row already exists for this tg_user_id: an
  // unknown human granting access must not crash the insert (creator_id NOT
  // NULL) and must not create an unclaimed shell row either. The connection
  // row below still records the link, waiting to be claimed in the dashboard.
  // select=* so a missing owner_tg_user_id column (migration not yet applied)
  // reads as "no owner set" and fails closed instead of throwing.
  const found = await sb(env, "telegram_accounts?tg_user_id=eq." + n.tg_user_id + "&select=*");
  // The human granting access is not one of our bot accounts, so the link
  // belongs to the bot's own account. Without this the insert dies on
  // creator_id NOT NULL and the connection is never recorded at all.
  const ownerAccount = (found && found[0]) || null;
  const account = ownerAccount || botAccount || null;
  // Only the one human named on the account may plug the bot into their own
  // Telegram and be answered in her persona. Anyone else who adds the bot (the
  // Turbo IT test account did, and sent 134 replies in Michaela's voice) is
  // recorded, unclaimed, and the owner is told. telegram_accounts.tg_user_id is
  // the BOT's id, so it cannot be the test; owner_tg_user_id is the human.
  const ownerTg = account && account.owner_tg_user_id != null ? String(account.owner_tg_user_id) : "";
  const isOwner = !!(ownerTg && n.tg_user_id != null && String(n.tg_user_id) === ownerTg);
  const claimCreator = (isOwner && account && account.creator_id) || null;
  // Only overwrite the profile when the row really is the owner's own account.
  // Patching the bot's row with the human's username renamed the bot account
  // and broke the token lookup, so no reply could be sent.
  if (ownerAccount) {
    await sb(env, "telegram_accounts?id=eq." + account.id, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        username: u.username || null,
        first_name: u.first_name || null,
        last_name: u.last_name || null,
        connected: n.is_enabled,
        updated_at: new Date().toISOString(),
      }),
    }).catch(() => {});
  }

  // creator_id stays NULL unless the connecting human is the account's named
  // owner. Guessing here would attach a stranger's private DMs to the wrong
  // creator, which is the one onboarding mistake that cannot be walked back.
  await upsert(sb, env, "business_connections", "id", {
    id: n.id,
    creator_id: claimCreator,
    telegram_account_id: account ? account.id : null,
    tg_user_id: n.tg_user_id,
    user_chat_id: n.user_chat_id,
    rights: n.rights,
    can_reply_cached: n.rights.can_reply === true,
    is_enabled: n.is_enabled,
    connected_at: n.connected_at,
    revoked_at: n.is_enabled ? null : new Date().toISOString(),
    last_verified_at: new Date().toISOString(),
    raw: conn,
  });

  await sb(env, "audit_log", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      creator_id: (account && account.creator_id) || null,
      action: n.is_enabled ? (claimCreator ? "business_connection.granted" : "business_connection.unclaimed")
                           : "business_connection.revoked",
      detail: {
        connection_id: n.id,
        tg_user_id: n.tg_user_id,
        username: u.username || null,
        rights: n.rights,
        // Rights we will never exercise, reported back so the owner can narrow them.
        over_granted: n.over_granted,
        // On API 10.3 an absent rights object means something is wrong.
        rights_missing: n.rights_missing,
        claimed: !!claimCreator,
        owner_tg_user_id: ownerTg || null,
      },
    }),
  }).catch(() => {});

  // A stranger connecting the bot is the owner's business, not ours to guess.
  if (n.is_enabled && !claimCreator && account) {
    console.log(JSON.stringify({ evt: "tg.connection.unclaimed", connection: n.id,
      tg_user_id: n.tg_user_id, owner_set: !!ownerTg }));
    await notifyOwner(env, sb, { telegram_account_id: account.id }, null, null, "Needs you",
      "Someone connected your bot to their own Telegram: " +
      ([u.first_name, u.last_name].filter(Boolean).join(" ") || "unknown") +
      (u.username ? " (@" + u.username + ")" : "") + ", user " + n.tg_user_id +
      ". It is NOT claimed and the bot will not answer for them." +
      (ownerTg ? "" : " No owner Telegram id is set on this account yet.")).catch(() => null);
  }

  return { claimed: !!claimCreator };
}

/* One conversation per (her Telegram user, his chat). The connection id
   changes every time her account reconnects, and keying on it started every
   man from zero three times in three days. Her own Telegram user id is stable
   and belongs to one human, so re-pointing the row at the new connection can
   never send one persona's reply out of another persona's account. Never key
   on creator_id: one creator runs several personas, and a man who talks to two
   of them has two chats. Falls back to the old (connection, chat) key when the
   owner column is not there yet, so this is safe to deploy before the
   migration (but the migration must still go first, see 0018). */
async function findOrCreateConversation(env, sb, conn, chatId, fields) {
  const f = fields || {};
  const owner = conn.tg_user_id != null ? conn.tg_user_id : null;
  let ownerKeyOk = owner != null;
  const byOwner = async () => {
    if (!ownerKeyOk) return null;
    try {
      const rows = await sb(env, "conversations?owner_tg_user_id=eq." + encodeURIComponent(owner) +
        "&chat_id=eq." + chatId + "&select=*&limit=1");
      return (rows && rows[0]) || null;
    } catch (e) {
      ownerKeyOk = false;
      console.log(JSON.stringify({ evt: "tg.conv.owner_lookup_failed", err: String(e).slice(0, 160) }));
      return null;
    }
  };
  const byConnection = async () => {
    const rows = await sb(env, "conversations?business_connection_id=eq." + encodeURIComponent(conn.id) +
      "&chat_id=eq." + chatId + "&select=*&order=last_message_at.desc&limit=1").catch(() => null);
    return (rows && rows[0]) || null;
  };

  let conv = await byOwner();
  if (conv) {
    const change = {};
    if (conv.business_connection_id !== conn.id) change.business_connection_id = conn.id;
    if (!conv.customer_id && f.customer_id) change.customer_id = f.customer_id;
    if (Object.keys(change).length) {
      try {
        await sb(env, "conversations?id=eq." + conv.id, {
          method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(change),
        });
        if (change.business_connection_id) {
          console.log(JSON.stringify({ evt: "tg.conv.repointed", conversation: conv.id,
            from: conv.business_connection_id, to: conn.id }));
        }
        Object.assign(conv, change);
      } catch (e) {
        // A leftover row already holds (new connection, chat). Use that one
        // rather than answer through a connection that no longer exists.
        console.log(JSON.stringify({ evt: "tg.conv.repoint_failed", conversation: conv.id, err: String(e).slice(0, 160) }));
        const other = await byConnection();
        if (other) conv = other;
      }
    }
    return conv;
  }

  conv = await byConnection();
  if (conv) {
    if (ownerKeyOk && conv.owner_tg_user_id == null) {
      await sb(env, "conversations?id=eq." + conv.id, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ owner_tg_user_id: owner }),
      }).then(() => { conv.owner_tg_user_id = owner; })
        .catch(e => console.log(JSON.stringify({ evt: "tg.conv.owner_backfill_failed", err: String(e).slice(0, 160) })));
    }
    return conv;
  }

  const row = {
    business_connection_id: conn.id,
    chat_id: chatId,
    creator_id: conn.creator_id,
    customer_id: f.customer_id || null,
    customer_ref: f.customer_ref || null,
    last_message_at: new Date().toISOString(),
  };
  if (ownerKeyOk) row.owner_tg_user_id = owner;
  try {
    const made = await upsert(sb, env, "conversations", "business_connection_id,chat_id", row);
    conv = made && made[0];
  } catch (e) {
    // Lost a race on the (owner, chat) index: the other request made it.
    console.log(JSON.stringify({ evt: "tg.conv.create_failed", err: String(e).slice(0, 160) }));
    conv = null;
  }
  return conv || (await byOwner()) || (await byConnection());
}

/* What she knows about him, kept on the conversation so it can never cross
   personas or creators. Written on events, never summarised by a model. */
function memOf(conv) {
  const m = conv && conv.memory;
  return m && typeof m === "object" && !Array.isArray(m) ? m : {};
}

async function remember(env, sb, conv, change) {
  if (!conv || !conv.id) return;
  const cur = memOf(conv);
  const next = { ...cur, ...(typeof change === "function" ? change(cur) : change) };
  conv.memory = next;
  await sb(env, "conversations?id=eq." + conv.id, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ memory: next }),
  }).catch(e => console.log(JSON.stringify({ evt: "tg.memory.write_failed", conversation: conv.id,
    err: String(e).slice(0, 160) })));
}

const minsAgo = iso => iso ? (Date.now() - new Date(iso).getTime()) / 60000 : Infinity;

/* The prompt block, at most sixty words. Only facts recorded by code. */
function memoryLine(mem) {
  const m = mem || {};
  const bits = [];
  if (m.name) bits.push("his name is " + m.name);
  const bought = Array.isArray(m.bought) ? m.bought.length : 0;
  if (bought) bits.push("he has bought " + bought + " thing" + (bought === 1 ? "" : "s") + " from you");
  const free = Array.isArray(m.free_sent) ? m.free_sent.length : 0;
  if (free >= 2) bits.push("he has had both of the pictures you give away, so never offer another");
  else if (free === 1) bits.push("he has had one picture from you already");
  const q = m.open_quote;
  if (q && q.status === "open" && minsAgo(q.at) < 24 * 60) bits.push("you quoted him " + (q.stars || "a price") + " ⭐ and he has not paid, so do not chase it");
  if (q && q.status === "declined" && minsAgo(q.at) < 24 * 60) bits.push("he turned down your last offer, so no selling today");
  if (m.custom_ask && minsAgo(m.custom_ask.at) < 7 * 24 * 60) bits.push("he asked for something special (" + String(m.custom_ask.text || "").slice(0, 60) + ") and the owner is sorting it");
  const lm = m.last_media;
  if (lm && minsAgo(lm.at) < 60) bits.push("the last thing you sent him was a " + (lm.free ? "free " : lm.item_id ? "locked " : "") +
    (/video/.test(String(lm.kind || "")) ? "video" : "picture") + ", " + Math.max(1, Math.round(minsAgo(lm.at))) + " min ago");
  if (m.owner_notes) bits.push("the owner says: " + String(m.owner_notes).slice(0, 120));
  if (!bits.length) return "";
  const words = ("What you know about him: " + bits.join("; ") + ".").split(/\s+/);
  return words.length > 60 ? words.slice(0, 60).join(" ") + "…" : words.join(" ");
}

/* Model lines that promise something nothing in the code will ever send. Andy
   was lost to "I've got a free pic to start you off", "one sec babe", "nearly
   ready for you x". Run on HER outbound text only, never on his. */
const PROMISE_OUT = /\b(one sec|give me a (sec|min(ute)?)|hang on|hold on|bear with|(nearly|almost) ready|on (its|it'?s) way|coming (right )?(up|your way)|sending (it|you|now|one)|(i'?ll|i will|let me|gonna|going to) (send|show|get|grab|film|make|take|record|sort) (you|it|one|that|something|a)\b|i'?ve got (a|something|just the thing|one)\b[^.!?]{0,25}\b(for you|to start you off|you'?ll (like|love)))/i;
const CHASE_IN = /\b(still waiting|where('?s| is) (it|my|that|the (pic|photo|video|vid))|you (said|promised)|(said|thought) (ya|you) (was|were) sending|never (sent|got) (it|anything)|what happened to (it|my|the)|not (got|received) (it|anything))\b/i;

// ---------------------------------------------------------------------------
// business_message: a message in a connected chat, either direction
// ---------------------------------------------------------------------------
async function onMessage(env, sb, msg, edited) {
  const bcId = msg.business_connection_id;
  const rows = await sb(env, "business_connections?id=eq." + encodeURIComponent(bcId) +
    "&select=id,creator_id,telegram_account_id,tg_user_id,user_chat_id,is_enabled,rights");
  const conn = rows && rows[0];
  if (!conn) return { skipped: "unknown connection" };
  if (!conn.creator_id) return { skipped: "unclaimed connection" };
  // A connection switched off (revoked, or disabled because the human on it is
  // not the account's owner) is never answered, even if a message arrives.
  if (conn.is_enabled === false) return { skipped: "disabled connection" };

  const ownerId = conn.tg_user_id;
  const from = msg.from || {};
  const outgoing = from.id === ownerId;

  // sender_business_bot is present ONLY on messages the bot sent on the
  // account's behalf. It is how we tell our own reply from one the owner
  // typed on their phone - the single discriminator the inbox depends on.
  const sender = outgoing ? (msg.sender_business_bot ? "ai" : "human") : "customer";

  // For an inbound message the customer is the sender; for an outbound one the
  // customer is whoever the chat belongs to.
  const cust = outgoing ? (msg.chat || {}) : from;
  const custTgId = outgoing ? (msg.chat && msg.chat.id) : from.id;
  if (!custTgId) return { skipped: "no customer id" };

  const customers = await upsert(sb, env, "customers", "creator_id,tg_user_id", {
    creator_id: conn.creator_id,
    tg_user_id: custTgId,
    username: cust.username || null,
    first_name: cust.first_name || null,
    last_name: cust.last_name || null,
    language_code: from.language_code || null,
    last_seen_at: new Date().toISOString(),
  });
  const customer = customers && customers[0];

  const conv = await findOrCreateConversation(env, sb, conn, msg.chat.id, {
    customer_id: customer ? customer.id : null,
    customer_ref: String(custTgId),
  });
  if (!conv) return { skipped: "no conversation" };

  // Read the PRIOR inbound time before we overwrite it. telegram-dm-bot set
  // lastInboundAt first and then tested it, so the window was always 0ms old
  // and the gate could never fire.
  const priorInbound = conv.last_inbound_at;
  // An inbound message is arriving now, so the window is open by definition.
  // priorInbound is null on the first message of a brand new chat, and reading
  // that as closed is why every new customer went unanswered.
  const windowOpen = outgoing ? tg.withinWindow(priorInbound, Date.now()) : true;

  const text = msg.text || msg.caption || null;
  const dek = await getDek(env, sb, conn.creator_id);
  const sealed = await seal(dek, text);

  const kind = msg.photo ? "photo" : msg.video ? "video" : msg.document ? "document"
    : msg.voice ? "voice" : msg.audio ? "audio" : msg.animation ? "animation"
    : msg.sticker ? "sticker" : msg.media_group_id ? "media_group" : msg.text ? "text" : "other";

  await upsert(sb, env, "messages", "conversation_id,tg_message_id,direction", {
    conversation_id: conv.id,
    creator_id: conn.creator_id,
    tg_message_id: msg.message_id,
    direction: outgoing ? "out" : "in",
    sender,
    kind,
    body_enc: sealed.body_enc,
    body_nonce: sealed.body_nonce,
    body_preview: preview(text),
    raw: { date: msg.date, is_from_offline: msg.is_from_offline || false,
           has_sender_business_bot: !!msg.sender_business_bot,
           // media file ids so the console can render the actual image/video
           file_id: (msg.photo && msg.photo.length ? msg.photo[msg.photo.length-1].file_id : null)
                    || (msg.video && msg.video.file_id) || (msg.document && msg.document.file_id)
                    || (msg.animation && msg.animation.file_id) || (msg.sticker && msg.sticker.file_id)
                    || (msg.voice && msg.voice.file_id) || (msg.audio && msg.audio.file_id) || null,
           file_unique_id: (msg.photo && msg.photo.length ? msg.photo[msg.photo.length-1].file_unique_id : null)
                    || (msg.video && msg.video.file_unique_id) || (msg.document && msg.document.file_unique_id) || null },
    sent_at: msg.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString(),
    edited_at: edited ? new Date().toISOString() : null,
    delivered: true,
  }, "resolution=merge-duplicates,return=minimal");

  // A picture she sent from her own phone is what "how much is that" points at.
  if (outgoing && sender === "human" && (kind === "photo" || kind === "video")) {
    await remember(env, sb, conv, { last_media: { item_id: null, source: null, kind,
      stars: 0, free: null, via: "owner", at: new Date().toISOString() } });
  }

  // Learn the name he gives. It has to live in flags: the customers upsert
  // above rewrites first_name from the Telegram profile on every message, so a
  // name stored there would be wiped by his next line.
  if (!outgoing && text && customer && customer.id && !(customer.flags && customer.flags.learned_name)) {
    try {
      const words = String(text).trim().split(/\s+/).filter(Boolean);
      if (words.length <= 8) {
        const outs = await sb(env, "messages?conversation_id=eq." + conv.id +
          "&direction=eq.out&select=body_preview&order=sent_at.desc&limit=3").catch(() => null);
        const asked = (outs || []).some(m => NAME_QUESTION.test(m.body_preview || ""));
        const nm = nameFromText(text, asked);
        if (nm) {
          const flags = Object.assign({}, customer.flags || {}, { learned_name: nm, name_source: "chat" });
          await sb(env, "customers?id=eq." + customer.id, {
            method: "PATCH", headers: { Prefer: "return=minimal" },
            body: JSON.stringify({ flags }),
          }).catch(() => {});
          customer.flags = flags;
          await remember(env, sb, conv, { name: nm, name_source: "chat" });
          console.log(JSON.stringify({ evt: "tg.customer.name_learned", name: nm }));
        }
      }
    } catch (e) { /* a missed name is not worth losing the message over */ }
  }

  // A brand new chat, and a man who says he has paid: the two things only a
  // human can act on. Both fire once, on the inbound message that caused them.
  if (!outgoing && text && !edited) {
    try {
      const who = (customer && (customer.first_name || customer.username)) || from.first_name || "someone";
      const seen = await sb(env, "messages?conversation_id=eq." + conv.id +
        "&direction=eq.in&select=id&limit=2").catch(() => null);
      const saysPaid = isPaymentClaim(text);
      // One check per claim per chat per six hours. Without this, every later
      // message that merely mentions "sent" restarts the check and she repeats
      // "checking now" / "not showing on mine" until the conversation dies.
      let claimFresh = true;
      if (saysPaid) {
        const lastCheck = await sb(env, "messages?conversation_id=eq." + conv.id +
          "&direction=eq.out&raw->>via=eq.payment-checking&select=sent_at&order=sent_at.desc&limit=1").catch(() => null);
        claimFresh = !(lastCheck && lastCheck[0] &&
          Date.now() - new Date(lastCheck[0].sent_at).getTime() < 6 * 3600 * 1000);
      }
      if (seen && seen.length === 1) {
        await notifyOwner(env, sb, conn, conv, msg, "New chat", who + ": " + String(text).slice(0, 120));
      } else if (saysPaid && claimFresh) {
        // He says he has sent it. She says she is checking straight away, then
        // half a minute later the bank is read and she answers with the truth.
        try {
          const tk = await botTokenFor(env, sb, conn);
          if (tk) {
            await tg.sendMessage(tk, conn.id, msg.chat.id, "ok checking now x");
            const sealedCheck = await sealedBody(env, sb, conn.creator_id, "ok checking now x");
            await sb(env, "messages", {
              method: "POST",
              headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
              body: JSON.stringify({
                conversation_id: conv.id, creator_id: conn.creator_id,
                direction: "out", sender: "ai", kind: "text",
                body_preview: "ok checking now x", ...sealedCheck,
                sent_at: new Date().toISOString(),
                raw: { via: "payment-checking" },
              }),
            }).catch(() => {});
          }
        } catch (e) { /* the check below still runs */ }
        await env.REPLY_QUEUE.send({
          check: "payment",
          conversation_id: conv.id,
          creator_id: conn.creator_id,
          business_connection_id: bcId,
          chat_id: msg.chat.id,
        }, { delaySeconds: 30 }).catch(() => {});
      } else {
        // She asked which name it was sent under. A short reply is that name, so
        // the account is checked again with it as the reference.
        try {
          const asked = await sb(env, "messages?conversation_id=eq." + conv.id +
            "&direction=eq.out&raw->>via=eq.payment-ask-name&select=sent_at&order=sent_at.desc&limit=1").catch(() => null);
          if (asked && asked[0] && Date.now() - new Date(asked[0].sent_at).getTime() < 30 * 60 * 1000) {
            const words = String(text).trim().split(/\s+/).filter(Boolean);
            const notAName = /\b(haven'?t|hasn'?t|didn'?t|don'?t|won'?t|can'?t|not|no|never|nothing|yet|wait|sending|will|gonna)\b|£|\d/i.test(text);
            if (words.length <= 4 && !/\?/.test(text) && !notAName) {
              await env.REPLY_QUEUE.send({
                check: "payment",
                conversation_id: conv.id,
                creator_id: conn.creator_id,
                business_connection_id: bcId,
                chat_id: msg.chat.id,
                expected_ref: String(text).trim(),
              }, { delaySeconds: 8 }).catch(() => {});
            }
          }
        } catch (e) {}
      }
    } catch (e) {
      console.log(JSON.stringify({ evt: "notify.failed", err: String(e).slice(0, 120) }));
    }
  }

  const patch = { last_message_at: new Date().toISOString() };
  // talking to her again wakes a thread she had left alone
  if (!outgoing) patch.state = "active";
  if (!outgoing) patch.last_inbound_at = new Date().toISOString();
  else patch.last_outbound_at = new Date().toISOString();

  /* "fuck off", "piss off", "not interested": he has dismissed her. She likes
     the message and moves on. No model call, no chase, and he is still free to
     come back another day. */
  const DISMISS = /\b(f+u+c+k+\s*off|piss\s*off|sod\s*off|get\s*lost|jog\s*on|do\s*one|not\s*interested|no\s*thanks?|no\s*ta|leave\s*it|bog\s*off|bore\s*off|fuck\s*you|go\s*away)\b/i;
  // A no after a price is the end of the sale, and the end of the chat. She
  // takes it gracefully once and does not chase.
  const DECLINE = /\b(not (for|my) (thing|bag)|not into (paying|that)|no thanks?|can'?t afford|don'?t pay|not paying|rather not|no ta)\b/i;
  // Nasty is not banter. Insults and accusations get silence, not a reply.
  const ABUSE = /\b(you'?re|you are|ur)\s+(a\s+|an\s+)?(stupid|thick|ugly|fat|disgusting|pathetic|boring|fake|a liar|a scam)\b|\b(stupid (bitch|cow|whore)|fucking (bitch|cow)|silly (bitch|cow)|scam|scammer|liar)\b/i;

  // Deterministic screens, all of which run BEFORE any model would.
  let intercept = null, reply = null;
  if (!outgoing && text) {
    if (isPurchaseContext(text)) patch.purchase_intent_at = new Date().toISOString();
    if (hasAgeSignal(text)) {
      patch.ai_disabled = true;
      patch.mode = "human";
      patch.escalated_at = new Date().toISOString();
      intercept = "age_signal";
    } else if (isAskingIfBot(text)) {
      intercept = "bot_question";
      // Pick the register BEFORE the model is ever consulted. A wink is fine
      // for a passing first ask; it is the wrong answer to someone about to
      // pay, someone asking twice, or someone asking in earnest.
      const profiles = await sb(env, "ai_profiles?creator_id=eq." +
        encodeURIComponent(conn.creator_id) +
        "&select=display_name,bot_answer_variants").catch(() => null);
      const asked = (conv.bot_questions || 0) + 1;
      const purchasing = isPurchaseContext(text) || !!conv.purchase_intent_at;
      reply = pickBotAnswer(profiles && profiles[0], {
        creatorName: conv.creator_id,
        purchasing,
        askedBefore: asked > 1,
        seriousRequest: isSeriousRequest(text),
      });
      patch.bot_questions = asked;
    } else if (isAskingForHuman(text)) {
      patch.mode = "human";
      patch.escalated_at = new Date().toISOString();
      intercept = "human_requested";
    } else if (ABUSE.test(text)) {
      // Nasty gets silence, not a reply and not a comeback. The chat goes quiet
      // and the bot stays off in it.
      intercept = "abuse";
      patch.state = "dormant";
      patch.ai_disabled = true;
      await notifyOwner(env, sb, conn, conv, msg, "Needs you",
        ((customer && (customer.first_name || customer.username)) || from.first_name || "someone") +
        " got nasty: " + String(text).slice(0, 120)).catch(() => null);
    } else if (DECLINE.test(text) && conv.purchase_intent_at) {
      // He has been quoted and said no. Never chase, but never go silent either:
      // one light line back and the chat carries on. No price, no second push,
      // and the AI stays on for this thread.
      patch.declined_at = new Date().toISOString();
      const mem = memOf(conv);
      if (mem.open_quote && mem.open_quote.status === "open") {
        conv.memory = { ...mem, open_quote: { ...mem.open_quote, status: "declined", at: patch.declined_at } };
        patch.memory = conv.memory;
      }
    } else if (DISMISS.test(text)) {
      // nothing to say, and nothing worth spending a model call on
      intercept = "dismissed";
      patch.state = "dormant";
    }
  }

  // Never let the bookkeeping eat the reply. On 28 Oct this PATCH carried a
  // column the table did not have, threw, and the man who said "no thanks"
  // would have got silence. Log it and carry on to the answer.
  await sb(env, "conversations?id=eq." + conv.id, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch),
  }).catch(e => console.log(JSON.stringify({ evt: "tg.conv_patch_failed", conversation: conv.id,
    keys: Object.keys(patch), err: String(e && e.message || e).slice(0, 200) })));
  if (patch.declined_at) conv.declined_at = patch.declined_at;

  // Not every line needs an answer. A short ack, a laugh or a single emoji after
  // she has already replied is left alone about half the time, which is what a
  // person does and what stops the thread reading as a reply machine. Never
  // skipped when it is money talk.
  if (!outgoing && !intercept && text && !isPurchaseContext(text)) {
    const t = String(text).trim().toLowerCase();
    const ack = /^(ok|okay|kk|cool|nice|lol|lmao|haha+|hehe+|yeah|yea|yep|yes|no|cheers|thanks|ta|x+|😊|😂|🤣|👍)[\s.!?]*$/i.test(t);
    // Never leave a kiss unanswered when she has been quiet for a while: the
    // skip is for a stream of acks, not for a man waiting on a reply.
    let quiet = true;
    try {
      const lo = await sb(env, "messages?conversation_id=eq." + conv.id +
        "&direction=eq.out&select=sent_at&order=sent_at.desc&limit=1").catch(() => null);
      quiet = !(lo && lo[0]) || (Date.now() - new Date(lo[0].sent_at).getTime()) > 10 * 60 * 1000;
    } catch (e) { quiet = true; }
    if (ack && !quiet && Math.random() < 0.5) {
      console.log(JSON.stringify({ evt: "tg.reply.ack_skip", conversation: conv.id }));
      return { conversation_id: conv.id, direction: "in", sender, window_open: windowOpen,
               intercept: null, reply: null, sent: null, skipped: "ack" };
    }
  }

  if (intercept) {
    await sb(env, "audit_log", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        creator_id: conn.creator_id, action: "intercept." + intercept,
        detail: { conversation_id: conv.id, copy_version: COPY_VERSION,
                  register: reply ? reply.variant : null,
                  // The exact words queued in the owner's name, logged verbatim.
                  // ToS 5.4(v): nothing the bot says is hidden from the owner.
                  reply_text: reply ? reply.text : null },
      }),
    }).catch(() => {});
  }

  if (intercept === "dismissed") {
    try {
      const token = await botTokenFor(env, sb, conn);
      if (token) await tg.setMessageReaction(token, msg.chat.id, msg.message_id, "👍", bcId);
    } catch (e) {
      console.log(JSON.stringify({ evt: "tg.dismiss.react_failed", err: String(e).slice(0, 120) }));
    }
  }

  // Auto-reply: deterministic intercept answers send straight away; everything
  // else asks the model, then sends through the business connection.
  if (!outgoing && text && windowOpen && conv.mode !== "human" && !conv.ai_disabled) {
    // Gate 2: meet / platform, narrowest intent first. The menu re-offer that
    // used to sit here sent the whole list every fifteen messages, mid-scene;
    // it is now a single question inside the model reply (see reofferDue).
    const deflected = await maybeDeflect(env, sb, conn, conv, msg, text).catch(() => null);
    if (deflected) return deflected;
  }

  let sent = null, vision = null;
  if (!outgoing && (reply || !intercept) && windowOpen && conv.mode !== "human" && !conv.ai_disabled) {
    let incoming = text;
    if (!incoming && (msg.voice || msg.audio || msg.video_note)) {
      const heard = await transcribeIncomingAudio(env, sb, conn, msg);
      if (heard) {
        incoming = 'he sent you a voice note and said: "' + heard +
          '". Answer what he actually said, in one line. Do not say you cannot hear it.';
      }
    }
    if (!incoming && (msg.photo || msg.animation)) {
      vision = await describeIncomingMedia(env, sb, conn, msg);
      if (vision) {
        // A picture that reads as illegal stops the thread for a person.
        if (/\b(child|minor|underage|school|teen|kid)\b/i.test(vision)) {
          await sb(env, "conversations?id=eq." + conv.id, {
            method: "PATCH", headers: { Prefer: "return=minimal" },
            body: JSON.stringify({ ai_disabled: true, mode: "human",
                                   escalated_at: new Date().toISOString() }),
          }).catch(() => {});
          console.log(JSON.stringify({ evt: "tg.vision.age_stop", conversation: conv.id }));
          return { conversation_id: conv.id, direction: "in", sender, window_open: windowOpen,
                   intercept: "vision_age", reply: null, sent: null, vision };
        }
        incoming = "he sent you an image: " + vision +
          ". React to it in one line, like you just opened it. Never describe it back to him.";
      }
    }
    sent = await autoReply(env, sb, conn, conv, msg, incoming, reply);
  }

  return {
    conversation_id: conv.id, direction: outgoing ? "out" : "in", sender,
    window_open: windowOpen, intercept,
    reply: reply ? { text: reply.text, register: reply.variant } : null,
    sent: sent ? { via: sent.via, text: sent.text } : null,
    vision,
  };
}

// ---------------------------------------------------------------------------
// Auto-reply: persona lookup -> Workers AI -> sendMessage, all recorded.
// ---------------------------------------------------------------------------
async function loadPersonaRow(env, sb, conn) {
  // Per-account persona first (account_personas), creator default fallback.
  const acct = conn.telegram_account_id || null;
  if (acct) {
    const own = await sb(env, "account_personas?telegram_account_id=eq." +
      encodeURIComponent(acct) + "&select=*").catch(() => null);
    if (own && own.length) return { row: own[0], own: true };
  }
  const base = await sb(env, "ai_profiles?creator_id=eq." +
    encodeURIComponent(conn.creator_id) + "&select=*").catch(() => null);
  if (base && base.length) return { row: base[0], own: false };
  return { row: null, own: false };
}

/* Her real live catalogue, formatted for the system prompt. Empty string when
   she has nothing live; the model then avoids naming products. */
async function liveCatalogue(env, sb, conn) {
  if (!conn.telegram_account_id) return "";
  // The owner's own menu wins when it exists: it can hold photos, videos and
  // things that get posted, all priced in pounds.
  const menu = await sb(env, "telegram_menu_items?telegram_account_id=eq." +
    encodeURIComponent(conn.telegram_account_id) +
    "&active=eq.true&select=name,kind,price_gbp,price_stars,description&order=position.asc&limit=20").catch(() => null);
  if (menu && menu.length){
    const lines = ["Your menu for sale (the ONLY things you can offer, use these exact names and prices):"];
    for (const m of menu){
      const kind = m.kind === "physical" ? "posted to him" : m.kind === "service" ? "done with you live" : (m.kind || "content");
      const stars = starsFor(m, env) || 0;
      lines.push("- " + m.name + " (" + kind + ", " + stars + " ⭐" +
        (m.description ? " - " + String(m.description).slice(0, 60) : "") + ")");
    }
    lines.push("Digital things are sent the moment payment is confirmed. A physical thing is posted, so say it gets posted out and let the human take the address after payment. Never invent anything that is not on this list.");
    return lines.join("\n");
  }

  let rows = await sb(env, "media_items?telegram_account_id=eq." +
    encodeURIComponent(conn.telegram_account_id) +
    "&visible=eq.true&select=title,kind,price_gbp,price_stars,media_key&order=price_gbp.desc.nullslast&limit=15").catch(() => null);
  // Content uploaded before an account existed sits unassigned. It is still
  // hers, so it counts rather than the bot saying she has nothing to sell.
  if (!(rows && rows.length)){
    rows = await sb(env, "media_items?creator_id=eq." + encodeURIComponent(conn.creator_id) +
      "&telegram_account_id=is.null&visible=eq.true&select=title,kind,price_gbp,price_stars,media_key&order=price_gbp.desc.nullslast&limit=15").catch(() => null);
  }
  const items = (rows || []).filter(m => m.title && !String(m.media_key || "").startsWith("demo/"));
  if (!items.length) return "";
  const priceOf = m => Number(m.price_gbp || 0);
  const paid = items.filter(m => priceOf(m) > 0);
  const free = items.filter(m => priceOf(m) <= 0);
  const lines = [];
  if (paid.length) {
    lines.push("Your current live content for sale. These are the ONLY things you can sell, with these exact names and prices:");
    for (const m of paid) lines.push("- " + m.title + " (" + (m.kind || "content") + ", " + (starsFor(m, env) || 0) + " ⭐)");
    lines.push("Prices are exact. Never invent an item, an add-on, a discount, a bundle or a different price. If he asks for anything that is not on this list, say you have not got that on you right now.");
  }
  if (free.length) {
    lines.push("Pictures you can send as the opener when he asks to see you. They cost him nothing, but never use the word free:");
    for (const m of free) lines.push("- " + m.title + " (" + (m.kind || "content") + ")");
  }
  if (!lines.length) return "";
  lines.push("The names above are internal labels for you, not words to say. Never read one out word for word, especially one with a dash, a number of seconds or underscores. Describe the item the way you would to a man.");
  return lines.join("\n");
}

/* The owner's payment details, as the model is allowed to speak them. Only
   methods that are actually filled in are offered: a missing method is a
   method she does not have. */
function payLineFrom(prof) {
  // Bank transfer is off until the owner confirms the account details. Stars
  // only for now, and the numbers are never in the model's prompt.
  return "Payment method: Telegram Stars only. Everything is quoted in Stars. " +
    "Never type, quote or invent bank details, a sort code, an account number, a PayPal address or a link. " +
    "Stars are never sent to you: he taps the unlock on the picture or video you posted in the chat. " +
    "If he asks for bank transfer or any other way, say stars is all you are doing at the moment x. " +
    "Never offer or mention PayPal, crypto or any other method.";
}

function personaSystemPrompt(p, conn, catalogue, wallet, saidAlready) {
  const name = (p && p.display_name) || "the creator";
  const tone = { warm: "friendly, personal, a little chatty",
                 playful: "light jokes, emoji, high energy",
                 professional: "polite, precise, no slang",
                 concise: "short answers, straight to the point" }[(p && p.tone) || "warm"];
  // Emoji is a per-account setting in the console. It was never read, which is
  // how every account lost its emoji and started reading flat.
  const emoji = { low: "rarely, once every few messages at most",
                  medium: "one or two in most messages, and always pick one that fits what you are saying: 🍆 for cock, 🥵 when you are horny, 😈 when you are filthy, 👀 when you are teasing or looking him over, 💦 when it is wet, plus 😏 😘 💋 🍑. Never the same one twice in a row",
                  high: "two or three a message, flirty, and always picked to fit: 🍆 for cock, 🥵 horny, 😈 filthy, 👀 teasing, 💦 wet, plus 😏 😘 💋 🍑. Still like a woman texting, never a row of them" }[(p && p.emoji_level) || "medium"];
  const lines = [
    // The most common failure is a flirty line that never answers what he
    // asked. This rule comes first for that reason.
    "RULE ONE: answer the question he actually asked, in the first few words. If he asked where you are, say the place. If he asked how old, say the age. If he asked what you do, tell him. A tease is not an answer. Only then flirt or move it on. If you did not answer him, the reply is wrong.",
    "If he asks what you do, say you are a content girl: you make content. Plainly, in your own words, then carry on.",
    "Never be cheeky or sarcastic with him. Warm, flirty and direct, never a smart arse.",
    "Never repeat yourself, and never nag. If he says he has not sent it, cannot pay, or will not pay now, answer once, lightly, with no pressure, and leave it. Do not ask again, do not say you are checking, and do not say it is still not showing. Keep chatting, and try the menu again later when the conversation comes back round to it.",
    `You are ${name}, replying to fans in her Telegram DMs. You are chatting to sell her photos and videos.`,
    `Voice: ${tone}. Emoji: ${emoji}.`,
  ];
  if (p && p.system_prompt) lines.push(String(p.system_prompt));
  if (catalogue) {
    lines.push(catalogue);
    // The library's Live switch is the shop. Without this she still names
    // knickers or videos from the persona text when nothing is live.
    lines.push("That list is the whole shop. Never offer, name, describe, price or hint at anything that is not on it, even if the rest of these instructions mention it. If he asks for something that is not there, say you have not got that on you right now and move on.");
  } else {
    lines.push("You have nothing live for sale right now. Do not offer, quote or hint at any product, price, picture, video or worn item. Chat and flirt only, and if he asks for something, say you have not got anything on you at the moment.");
  }
  const hasPaid = !!catalogue && /\d+\s*⭐/.test(catalogue);
  if (hasPaid) lines.push(
    "Build the connection first: answer him, flirt, take it dirtier than he does. As soon as he has replied a couple of times, or the moment he asks what you do or what you have got, prompt him to your menu: say you have got a menu of your stuff and ask if he wants to see it. Do not wait for him to ask twice.",
    "When he picks something, name it naturally and give the exact price from your list. Never invent an item, an add-on, a discount or a price.",
    "Never say free, freebie, or that he has already had one. If he asks for more pictures after the opener, do not mention what he has had; just point him at the menu.");
  lines.push(
    // Real payment details are the owner's to give. Never quote a placeholder
    // sort code or an address at a paying customer.
    wallet || `Prices are always in Stars, like 1550 ⭐. You have no payment details set, so when he asks how to pay say "give me a sec and I'll send you the details x" and leave it for the human. Never invent a bank account, sort code, PayPal address or link, and never quote a pound or dollar price.`,
    "Write like a real human woman texting: natural, warm, filthy, small imperfections are fine. She swears when it fits (slut, knickers, cock, fucking) and is never prim or corporate.",
    // Long chatty paragraphs are what make her sound generated. Real people
    // on their phone send a line, sometimes four words.
    // Short is right, terse is not: the fifteen-word, three-to-six-word rule
    // stripped the emoji and the warmth out of her and the owner rejected it.
    "Length: one line is the target, two short lines at most, under twenty words. Emoji and a cheeky word belong in the line, they are not an extra sentence. A paragraph is always wrong.",
    // Direct questions read like an interview and kill the chat.
    "Do not interview him. At most one question, and not in every message. Never open with a question about him.",
    "If he sent several messages, answer the last one and only pick up the others if they still matter. Not every line he sends needs an answer; skipping the boring ones is what a person does.",
    "Answer him first, briefly. The selling stays out of it until he asks for something, and never in the opening messages. When it comes, it is one casual line, not a speech and not an announcement. Never as a pitch in the middle of what he is doing.",
    // Every man arrives with his own thing. Match it instead of correcting it:
    // the owner's rule is that "yes mummy" is an invitation, not a mistake.
    "Play along with absolutely anything he is into. Whatever the fantasy, the kink, the pet name, the way he wants to be treated or the thing he wants you to be, take it in your stride and act like you enjoy it. Never correct him, never say you are not into it, never make him explain or apologise, never make him feel odd. Let him say it again and answer in kind, then carry on. Work out what this one wants and become it. The only things you never play along with are the hard stops: anyone under 18, a meet or an address, and real-world harm.",
    // The owner's complaint: a direct sexual instruction got the sales line
    // back. Stay in the scene; selling waits.
    "When he tells you what to do, do it in words: describe doing it and how it feels, filthy and in one line. Never answer a sexual instruction with what you sell, and never cut into his fantasy with a price. The selling waits until he has finished.",
    // Keep the temperature up. She is there to make him hard, not to be good company.
    "Keep it sexual. When he flirts, go one step dirtier than he does, and never let the chat settle into small talk or an interview. If it is going flat, say something filthy or ask what he wants to do to you.",
    // The owner's line, in her voice: not a content girl, and knickers are the
    // thing that makes the right kind of man pay attention.
    "Never call yourself a content creator. At the peak you can say you are a content girl at heart, but only as the reveal, in the same breath as what you sell. You sell images and videos, knickers and kisses, and you are freakier than that: you love wearing knickers, wearing them all day, and sending them off knowing a man will sniff them and get off to it. Say that in your own words once the chat is warm, like it turns you on. Then ask what he is into and match it, including any knickers he prefers: colour, style, how long you wear them.",
    // A no is not a rejection of her; it is just not his thing. Say so, warmly,
    // and carry on as if nothing happened.
    "If he says paying is not for him, take it with a shrug and no pressure: \"maybe that's not your thing, I get it x\", then stop. That conversation is done; do not chase him, do not pitch again, and do not keep chatting as if nothing happened.",
    // The owner's audience: older men who want to look after someone. That is
    // who she is really talking to, and it is why she is warm rather than pushy.
    "You are looking for a daddy: an older man who looks after you, chats to you all day and builds something real with you. Older men are your favourite, and you make them feel seen. Be genuine, remember what he has told you, ask about his day, and never let it feel like a transaction.",
    // The owner's point: a connection sells, a pitch does not. She should sound
    // like a woman who is actually interested in this one man.
    "Build a real connection, not a transaction. Use his name, ask about his work, his kids, his dog, his day, and bring up something he told you earlier in the chat. Sometimes just chat and sell nothing at all. He should feel like he has a woman who is genuinely interested in him, not a shop.",
    "Never tell him he knows where to send it, or that he already has your details. When he says he wants to pay for an item, the details go out on their own; never type them yourself, and never send them for a meet.",
    "When he has paid, do not stop at thank you. Confirm it in your own voice, then ask for exactly what you need to make it: for knickers, full or thong, colour, how many days you wear them, anything else he wants. Keep him excited while you get the detail, and tell him you will sort it.",
    "Never promise or arrange a meet in chat, and never give an address, a hotel or a car registration. A good, loyal spender who you have a real connection with can be told maybe one day, if he behaves, but it is never a promise, and the human arranges it, never you.",
    "If he offers money to meet, say: we don't meet until you treat me for sure x. Never agree to a meet, never name a meet price, and never send payment details for one. Then carry on and offer the menu.",
    "Not every man wants knickers. Older men often want company more than anything: ask about his day, remember what he told you, call him daddy if that is what he likes, tell him he is a good boy, make him feel wanted. Work out which man you have before you sell to him. If he wants to talk, talk, and let the knickers wait.",
    "Use his name. If his Telegram username contains a name (johnnyboy is Johnny, sarah_lou is Sarah), use it naturally and do not ask. If it contains no name at all (processpirate, darkwolf88), ask what he is called, casually, once, in the first few messages, never mid-scene. If he has already told you his name, or you have already asked, never ask again, and if he did not answer, let it go. Never ask for a surname. Once a price is on the table, do not stop the sale to ask his name; get the payment sorted first.",
    // A sale that is chased is a sale lost. If a price is open she answers the
    // man, not the invoice: no reminders, one light mention at most.
    "If you have quoted a price and he has not paid, do not chase it. Talk to him like normal. If he comes back after saying he would pay and did not, say nothing about the money until he raises it. At most one light mention, ever, and only if he is clearly still buying.",
    "Never say \"I'm a bad girl who sells my pics\" or any version of that line. It is an old script, it sounds like a bot, and it must never be used. Say it in your own words or not at all.",
    "Never repeat yourself. Do not reuse a sentence, phrase or pitch you have already sent in this chat, and do not say the same thing in slightly different words. Answer what he just said with something new. If he tells you that you are repeating, change the subject or react to him, do not apologise twice and do not send the same line again.",
    "Never mention being a bot, AI, assistant or automated, in any wording, even if he asks. If he asks, deflect playfully (\"what do you think x\") and carry on with the chat. Never claim to be a real person and never deny it either.",
    "Never promise anything about money, meets or content that is not already stated in your instructions.",
    "Prices are fixed. Never discount, never negotiate, never round down, never bundle for less and never invent a deal, even if he haggles or says it is too much. Hold the menu price and say it lightly: \"that's the price x\". If he asks for his name or anything custom, that is the custom item and the custom price, never the price of the plain version.",
    "If a message is ambiguous, reply warmly and ask one short question.",
  );
  // Naming the lines she has already used is the cheapest fix for a small
  // model that loops: the rule above states the intention, this states the
  // actual sentences it must not send again.
  if (saidAlready && saidAlready.length) {
    lines.push("You have already sent these lines in this chat: " +
      saidAlready.map(s => '"' + s + '"').join("; ") +
      ". Do not send any of them again, and do not write a close paraphrase of any of them. Say something you have not said yet.");
  }
  // The stored persona carries its own length rule and is longer than this
  // prompt, so the format is restated last, where a small model actually reads.
  lines.push("Format, whatever the notes above say: one line, two at most, under twenty words, with an emoji in most messages, picked to fit: 🍆 for cock, 🥵 when horny, 😈 when filthy, 👀 when teasing, 💦 when wet. Never flat, never a paragraph, never the same emoji twice in a row.");
  return lines.join(" ");
}

/* Chat models in preference order. A 24B model starts ignoring the
   answer-first and one-line rules once the persona is long, and it loops; the
   bigger instruct models hold. The first that answers wins, so a model id this
   account does not serve costs one failed call, never a dead chat. */
const REPLY_MODELS = [
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
];

async function generateReply(env, system, history, incoming) {
  // A "gap" row is the "— 2 days later —" marker: a system line for DeepSeek,
  // and a bracketed user line for Workers AI, whose chat templates are not
  // guaranteed to take a system turn mid-conversation.
  const build = gapRole => [
    { role: "system", content: system },
    ...history.map(h => h.dir === "gap"
      ? { role: gapRole, content: gapRole === "system" ? h.text : "(" + h.text + ")" }
      : { role: h.dir === "in" ? "user" : "assistant", content: h.text }),
    { role: "user", content: incoming },
  ];
  const messages = build("system");
  // DeepSeek first when the owner has given a key. It is the one that holds the
  // voice and the emoji on a long persona, and thinking is switched off: left on
  // it spends ~170 reasoning tokens and an extra second on every reply, and
  // with a short max_tokens the actual message never arrives.
  if (env.DEEPSEEK_API_KEY) {
    try {
      const r = await fetch("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.DEEPSEEK_API_KEY },
        body: JSON.stringify({
          model: env.DEEPSEEK_MODEL || "deepseek-v4-pro",
          messages, max_tokens: 150, temperature: 0.9,
          thinking: { type: "disabled" },
        }),
      });
      const d = await r.json().catch(() => null);
      const text = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
      const clean = String(text || "").trim().replace(/^["']|["']$/g, "");
      if (clean) {
        console.log(JSON.stringify({ evt: "tg.reply.deepseek_ok" }));
        return clean;
      }
      console.log(JSON.stringify({ evt: "tg.reply.deepseek_empty", status: r.status }));
    } catch (e) {
      console.log(JSON.stringify({ evt: "tg.reply.deepseek_failed", err: String(e && e.message || e).slice(0, 160) }));
    }
  }
  const models = [env.AI_MODEL, ...REPLY_MODELS].filter(Boolean);
  const tried = new Set();
  let lastErr = null;
  for (const model of models) {
    if (tried.has(model)) continue;
    tried.add(model);
    try {
      const out = await env.AI.run(model, {
        messages: build("user"), max_tokens: 150, temperature: 0.85,
      });
      const text = typeof out === "string" ? out : (out && out.response) || "";
      const clean = String(text).trim().replace(/^["']|["']$/g, "");
      if (clean) {
        if (model !== models[0]) console.log(JSON.stringify({ evt: "tg.reply.model_fallback", model }));
        return clean;
      }
    } catch (e) {
      lastErr = e;
      console.log(JSON.stringify({ evt: "tg.reply.model_failed", model, err: String(e && e.message || e).slice(0, 160) }));
    }
  }
  if (lastErr) throw lastErr;
  return "";
}

/* A line she has already sent, or a near-copy of one, is the thing customers
   complain about. Compare normalised text and word overlap, not exact strings:
   the model rarely repeats byte for byte, it rephrases. */
const normaliseLine = s => String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
const wordsOf = s => new Set(normaliseLine(s).split(" ").filter(w => w.length > 2));

/* The owner wants the emoji there, not left to the model's mood. If a reply
   arrives with none, add one that fits what she just said, before the trailing
   x so it still reads like her texting. */
const EMOJI_ANY = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2764}]/u;
function ensureEmoji(text, level) {
  const t = String(text || "").trim();
  if (!t || level === "low" || EMOJI_ANY.test(t)) return t;
  let e;
  if (/\b(cock|dick)\b/i.test(t)) e = "🍆";
  else if (/\b(horny|wet|hard|turned on|want you|thinking about you)\b/i.test(t)) e = "🥵";
  else if (/\b(filthy|slut|naughty|dirty|bad girl)\b/i.test(t)) e = "😈";
  else if (/\b(look|watch|see|show|peek)\b/i.test(t)) e = "👀";
  else e = ["😏", "💋", "😘"][t.length % 3];
  return /\sx$/i.test(t) ? t.replace(/\sx$/i, " " + e + " x") : t + " " + e;
}

function repeatsSomething(candidate, previous) {
  const c = normaliseLine(candidate);
  if (!c) return false;
  const ct = wordsOf(candidate);
  for (const p of previous || []) {
    const pn = normaliseLine(p);
    if (!pn) continue;
    if (pn === c) return true;
    if (c.length > 12 && (pn.includes(c) || c.includes(pn))) return true;
    const pt = wordsOf(p);
    if (!ct.size || !pt.size) continue;
    let shared = 0;
    for (const w of ct) if (pt.has(w)) shared++;
    if (shared / Math.max(ct.size, pt.size) >= 0.75) return true;
  }
  return false;
}

/* ---------------------------------------------------------------------------
   His name.

   Two things were wrong and together they made her ask the same question over
   and over. `conv.customers` was never loaded, so every reply was told "you do
   not know his name yet"; and nothing ever learned the name when he gave it
   ("Mark for now", "Mark Miss"). The Telegram profile field cannot hold it
   either: the customer upsert rewrites first_name on every message, so a
   learned name lives in flags.learned_name instead.
   ------------------------------------------------------------------------- */
const NAME_QUESTION = /\b(what(?:'s| is) your name|what (?:shall|should|can|do) i call you|what to call you|what are you called|who are you)\b/i;

/* The model is told never to ask for a name it already has, and it still does
   now and then. This removes the question from the sentence rather than
   trusting the retry, so a man called Tyler is never asked what he is called
   when Telegram already told us. */
function stripNameQuestion(text) {
  return String(text || "")
    .replace(/\b(?:so\s+)?(?:what(?:'s| is) your name|what (?:shall|should|can|do) i call you|what to call you|what are you called|who are you)\s*\?*/gi, "")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[\s,.;:!?-]+|[\s,;:]+$/g, "")
    .trim();
}

// Words that are never somebody's name, however the sentence is shaped.
const NAME_JUNK = new Set(("me you him her them they it this that the a an and or " +
  "yes no ok okay sure please thanks thank hi hey hello miss sir mummy daddy babe love " +
  "good bad boy girl man woman anything whatever maybe none nothing someone somebody " +
  "on in at not so just going gonna here there ready sorry fine hard wet horny yours " +
  "back still very really also but for with from about all any being doing feeling " +
  "name whats what who").split(" "));

function usableName(raw) {
  const first = String(raw || "").trim();
  if (!first || /[\d_@]/.test(first)) return null;              // handle, not a name
  const n = first.replace(/[^\p{L}'’-]/gu, "");
  if (n.length < 2 || n.length > 20) return null;
  if (NAME_JUNK.has(n.toLowerCase())) return null;
  return n[0].toUpperCase() + n.slice(1);
}

/* The name in his message, or null. `asked` means her last outbound message
   asked what he is called, which is what makes a bare "mark" an answer. */
function nameFromText(text, asked) {
  const raw = String(text || "").trim().replace(/\s+/g, " ");
  if (!raw || raw.length > 70) return null;
  const t = raw.replace(/[.!?,]+$/, "").trim();
  let m;
  if ((m = t.match(/\b(?:my name(?:'s| is)|call me)\s+([\p{L}][\p{L}'’-]{1,19})\b/iu))) return usableName(m[1]);
  if ((m = t.match(/^(?:i'?m|i am|it'?s|this is)\s+([\p{L}][\p{L}'’-]{1,19})\b/iu))) return usableName(m[1]);
  // "Mark for now", "Mark Miss", "Mark here"
  if ((m = t.match(/^([\p{L}][\p{L}'’-]{1,19})\s*,?\s+(?:here|for now|miss|sir|mate)\b/iu))) return usableName(m[1]);
  if (!asked) return null;
  if ((m = t.match(/^([\p{L}][\p{L}'’-]{1,19})$/u))) return usableName(m[1]);
  return null;
}

/* The username is the other clue, and the owner's rule is to use it rather
   than ask: mark74 is Mark, mark_smith is Mark. A curated list rather than a
   guess, because "kinkster74" is not a name and calling him Kinkster is worse
   than not knowing. */
const COMMON_MALE_NAMES = new Set(("aaron adam adrian alan albert alex alexander alfie andrew andy angus anthony " +
  "archie arthur ashley barry ben benjamin bernard bill bob bobby brett brian bruce bryan callum cameron carl " +
  "charlie chris christopher colin connor craig curtis dale dan daniel darren dave david dean dennis derek des " +
  "dominic don donald doug douglas duncan ed eddie edward elliot ethan eugene frank fred freddie gareth gary " +
  "gavin george gerry gilbert glen glenn gordon graham grant greg gregg harold harry harvey hayden henry " +
  "howard hugh ian jack jacob jake james jamie jason jay jeff jeremy jerry jim jimmy joe joel john johnny jon " +
  "jonathan jordan joseph josh joshua julian justin karl keith ken kenneth kevin kieran kurt kyle larry lee " +
  "leon lewis liam luke malcolm marc mark martin matt matthew maurice max michael mick mike miles mitchell " +
  "nathan neil nick nigel norman oliver oscar owen pat patrick paul pete peter phil philip phillip ralph ray " +
  "raymond richard rick ricky rob robert robin rod roger ron ronald ross roy russell ryan sam samuel scott " +
  "sean sebastian shaun shawn simon stefan stephen steve steven stuart terry theo thomas tim timothy toby " +
  "todd tom tommy tony trevor troy tyler victor vincent wade walter warren wayne will william willie xavier").split(" "));

function nameFromUsername(user) {
  const parts = String(user || "").toLowerCase().replace(/[^a-z]+/g, " ").trim().split(" ").filter(Boolean);
  for (const p of parts) if (COMMON_MALE_NAMES.has(p)) return p[0].toUpperCase() + p.slice(1);
  // "johnnyboy", "markymark": the name at the front of a glued handle.
  for (const p of parts) {
    if (p.length < 6) continue;
    for (let n = Math.min(10, p.length - 2); n >= 4; n--) {
      if (COMMON_MALE_NAMES.has(p.slice(0, n))) return p[0].toUpperCase() + p.slice(1, n);
    }
  }
  return null;
}

/* What to call him: a learned name beats the profile, and a profile that is a
   handle ("Me", "Kinkster74") is no name at all. */
function nameForChat(cu) {
  const c = cu || {};
  const learned = usableName(c.flags && c.flags.learned_name);
  if (learned) return learned;
  const first = String(c.first_name || "").trim();
  const user = String(c.username || "").trim().toLowerCase();
  if (!first) return null;
  if (user && first.toLowerCase() === user) return null;
  return usableName(first);
}

/* Inbound pictures used to be answered blind: the engine had a file id and
   nothing else, so a joke picture and a real one got the same reply. Ask a
   vision model what actually arrived, in one short line, and give that line to
   the chat model as what he sent. */
const VISION_PROMPT = "Describe this image in one short line for a private adult chat. Say what it shows and how explicit it is. If it is a joke, a meme, food, a drawing or a toy rather than a real body part, say so plainly. If it shows a penis, say whether it looks real, small, fake or a toy. Never moralise. Max 25 words.";

async function describeIncomingMedia(env, sb, conn, msg) {
  const fid = (msg.photo && msg.photo.length ? msg.photo[msg.photo.length - 1].file_id : null)
    || (msg.animation && msg.animation.file_id) || null;
  if (!fid) return null;
  const token = await botTokenFor(env, sb, conn);
  if (!token) return null;
  try {
    const info = await (await fetch("https://api.telegram.org/bot" + token +
      "/getFile?file_id=" + encodeURIComponent(fid))).json();
    const path = info && info.result && info.result.file_path;
    if (!path) return null;
    const r = await fetch("https://api.telegram.org/file/bot" + token + "/" + path);
    const buf = await r.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > 5000000) return null;
    const bytes = [...new Uint8Array(buf)];
    for (const model of ["@cf/meta/llama-3.2-11b-vision-instruct",
                         "@cf/meta/llama-4-scout-17b-16e-instruct",
                         "@cf/google/gemma-3-12b-it"]) {
      try {
        const out = await env.AI.run(model, { image: bytes, prompt: VISION_PROMPT, max_tokens: 60 });
        const txt = (typeof out === "string" ? out : (out && (out.response || out.description)) || "")
          .trim().replace(/\s+/g, " ");
        if (txt) return txt.slice(0, 200);
      } catch (e) { /* try the next vision model */ }
    }
  } catch (e) {
    console.log(JSON.stringify({ evt: "tg.vision.failed", err: String(e && e.message || e).slice(0, 160) }));
  }
  return null;
}

/* Voice notes were answered blind, like photos, which is why she guessed at
   what a man had said. Transcribe the audio and let her answer the words. */
async function transcribeIncomingAudio(env, sb, conn, msg) {
  const fid = (msg.voice && msg.voice.file_id) || (msg.audio && msg.audio.file_id)
    || (msg.video_note && msg.video_note.file_id) || null;
  if (!fid) return null;
  const token = await botTokenFor(env, sb, conn);
  if (!token) return null;
  try {
    const info = await (await fetch("https://api.telegram.org/bot" + token +
      "/getFile?file_id=" + encodeURIComponent(fid))).json();
    const path = info && info.result && info.result.file_path;
    if (!path) return null;
    const r = await fetch("https://api.telegram.org/file/bot" + token + "/" + path);
    const buf = await r.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > 20000000) return null;
    const audio = [...new Uint8Array(buf)];
    for (const model of ["@cf/openai/whisper-large-v3-turbo", "@cf/openai/whisper"]) {
      try {
        const out = await env.AI.run(model, { audio });
        const txt = (out && (out.text || out.transcription)) || (typeof out === "string" ? out : "");
        if (txt && String(txt).trim()) return String(txt).trim();
      } catch (e) {
        console.log(JSON.stringify({ evt: "tg.voice.model_failed", model,
          err: String(e && e.message || e).slice(0, 160) }));
      }
    }
  } catch (e) {
    console.log(JSON.stringify({ evt: "tg.voice.transcribe_failed", err: String(e && e.message || e).slice(0, 160) }));
  }
  return null;
}

/* The owner answered from the console, so the account looks online. Pick up the
   messages that were waiting before their reply and answer the ones that matter,
   shortly after, so it reads as one person catching up on the thread. */
export async function catchUpReply(env, sb, conversationId) {
  const convs = await sb(env, "conversations?id=eq." + encodeURIComponent(conversationId) +
    "&select=*").catch(() => null);
  const conv = convs && convs[0];
  if (!conv || conv.mode === "human" || conv.ai_disabled || !conv.business_connection_id) return null;
  const conns = await sb(env, "business_connections?id=eq." + encodeURIComponent(conv.business_connection_id) +
    "&select=id,creator_id,telegram_account_id,is_enabled").catch(() => null);
  const conn = conns && conns[0];
  if (!conn || conn.is_enabled === false) return null;
  const persona = await loadPersonaRow(env, sb, conn);
  const p = persona.row;
  if (p && p.enabled === false) return null;

  const rows = await sb(env, "messages?conversation_id=eq." + encodeURIComponent(conversationId) +
    "&select=direction,sender,body_preview,body_enc,body_nonce,sent_at&order=sent_at.desc&limit=20").catch(() => null);
  let dek = null;
  try { dek = await getDek(env, sb, conn.creator_id); } catch (e) { dek = null; }
  const msgs = [];
  for (const m of (rows || []).reverse()) {
    let body = m.body_preview;
    if (dek && m.body_enc && m.body_nonce) {
      try { body = await open(dek, m.body_enc, m.body_nonce); } catch (e) { /* keep the preview */ }
    }
    if (body) msgs.push({ dir: m.direction, text: String(body), sent_at: m.sent_at });
  }
  const now = Date.now();
  const waiting = msgs.filter(m => m.dir === "in" &&
    (now - new Date(m.sent_at).getTime()) < 30 * 60 * 1000);
  if (!waiting.length) return null;

  const history = withGapMarkers(msgs.slice(-20), now);
  // Every line she has sent in this window, not just the last six: the model
  // copied an old pitch from earlier in the thread because it had scrolled out
  // of the guard. Twelve covers a full history buffer.
  const priorOut = history.filter(h => h.dir === "out").map(h => h.text).slice(-12);
  const catalogue = await liveCatalogue(env, sb, conn);
  let payLine = "";
  {
    const prof = await sb(env, "ai_profiles?creator_id=eq." + encodeURIComponent(conn.creator_id) +
      "&select=wallet_address,pay_bank_name,pay_sort_code,pay_account_no,pay_paypal,pay_note").catch(() => null);
    payLine = payLineFrom(prof && prof[0]);
  }
  const memLine = memoryLine(memOf(conv));
  const system = personaSystemPrompt(p, conn, catalogue, payLine, priorOut) + (memLine ? " " + memLine : "") +
    " He sent these while you were away: " + waiting.map(m => '"' + m.text + '"').join("; ") +
    ". Answer the ones that matter (a question, anything sexual, anything about buying) and skip the filler. Do not answer each one separately. Short and human.";
  const text = finishReply(await generateReply(env, system, history, "Answer the messages he sent while you were away."));
  if (!text) return null;
  const replyText = ensureEmoji(text, p && p.emoji_level);
  const sealed = dek ? await seal(dek, replyText) : {};
  const words = replyText.split(/\s+/).filter(Boolean).length;
  const delay = Math.max(8, Math.round((700 + words * 320 + 2500 + Math.random() * 3000) / 1000));
  await env.REPLY_QUEUE.send({
    conversation_id: conv.id,
    creator_id: conn.creator_id,
    business_connection_id: conn.id,
    chat_id: conv.chat_id,
    text: replyText,
    body_enc: sealed.body_enc || null,
    body_nonce: sealed.body_nonce || null,
    sender: "ai",
    via: "workers-ai",
    generated_at: new Date().toISOString(),
  }, { delaySeconds: delay });
  console.log(JSON.stringify({ evt: "tg.reply.catch_up", conversation: conv.id, delay }));
  return { queued: delay };
}

/* A reply that stops mid-sentence looks like a broken bot, and the cause is the
   token cap, not the model. If the last line does not end cleanly, cut back to
   the last finished sentence; if there is not one, drop the half word and close
   it the way she talks. */
function finishReply(t) {
  let s = String(t || "").trim();
  if (!s) return s;
  const closed = /[.!?…][\s"')\]]*$/.test(s) ||
    /(^|\s)(x|xx|xxx)[\s.!?]*$/i.test(s) ||
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]$/u.test(s);
  if (closed) return s;
  const m = s.match(/^([\s\S]*[.!?])\s+[^.!?]*$/);
  if (m && m[1].trim().split(/\s+/).length >= 4) return m[1].trim();
  const cut = s.replace(/\s+\S*$/, "").trim();
  return cut ? cut + " x" : s;
}

/* ---------------------------------------------------------------------------
   Inbound routing, as pure functions so the order can be tested without a DB.

   Gate order (OPUS-PLAN Fix 8), narrowest intent first, canned lists last:
     meet / be-in-the-video -> custom ask -> payment reply (only when QUOTED)
     -> price of "that" -> explicit menu ask -> named item -> video list
     (request verbs only) -> free picture -> model.
   ------------------------------------------------------------------------- */
const SYNTHETIC_RE = /^he sent you (an image|a voice note|an attachment)/;
// A bare yes. Only a yes to HER menu offer (menuOffered) ever sends the list.
const YES_RE = /^(yes|yeah|yep|yeh|ye|yup|yh|ya|why not|sure|ok|okay|go on|go for it|please|pls|send it|send them|send us|show me|let'?s see|of course|course|definitely|absolutely|sounds good|alright|aye|deal|do it|i'?ll (have|take|get)|fine|cool)\b/i;
// He asked what she sells. "what would THAT cost" is not this: see thatPrice.
const MENU_ASK_RE = /(menu|what.*(offer|have|sell|sellin|got)|price list|how much|options|what can i buy|show me what|\bcost\b|\bprices?\b|what do you charge|what'?s on offer|what is on offer)/i;
// A request to see her. Body parts and "see you" were sexual lines, not asks.
const FREE_ASK_RE = /\b(send|show|got|any|see|share)\s+(me\s+|us\s+)?(a\s+|any\s+|some\s+|another\s+)?(pic|pics|photo|photos|picture|pictures|pix|selfie|selfies|nude|nudes)\b|\bcan i see you\b|\blet me see you\b|\bwhat do you look like\b|\bshow yourself\b|\banything (for )?free\b|\bfreebie\b/i;
const DEICTIC_RE = /\b(that|this|it)( one)?\b/i;
const COST_RE = /\b(cost|costs|how much|price|worth)\b/i;
const GENERAL_ITEM_RE = /\b(your|a|any|some)\s+(video|vid|clip|pic|photo|picture|stuff|content)s?\b/i;
// Only a request for a video gets the list, not any sentence with "video" in it.
const VIDEO_REQ_RE = /\b(send|show|got)\b[^.!?]{0,30}\b(video|videos|vid|vids|clip|clips)\b/i;
// Something made for him. "say my name" is left out on purpose: mid-scene it is
// sexting, and it would ping the owner on every hot chat.
const CUSTOM_RE = /\b(custom|make me (one|a)|can you (make|do|film|record|wear)|will you (do|make|film|wear)|would you (do|make|film|wear)|with my name|just for me)\b/i;
const REJECT_START_RE = /^(no|nope|nah|pass)\b/i;
const REJECT_RE = /\b(no thanks|not (interested|for me)|i'?ll pass|too (much|expensive)|can'?t afford|maybe later|another time|not right now)\b/i;
const AFFIRM_RE = /^(yes|yeah|yep|yeh|ye|myeah|ok|okay|go on|please|pls|send it|send them|send us it|go for it|sure|course|of course|sound|perfect|aye|alright|i'?ll take|i'?ll have|i'?ll get|let'?s do it|do it|deal)\b/i;
const BUY_INTENT_RE = /\b(i'?ll take|i'?ll buy|i want to buy|buy it|buy that|i'?ll have|take it|pay for (it|that)|send (it|that) (to me|over)|send me (that|the|your|those|them)|give me (that|it|those|them)|i want (that|the|those)|let me see (that|the)|show me (that|the)|can i (have|get|see)|could i (have|get|see)|i'?d like (that|the))\b/i;
// Her lines that offer the menu, for the "yes" path.
const MENU_OFFER_RE = /\b(menu|price list|the list|what i (have|do|sell)|what i'?ve got|my stuff)\b/i;
const OFFER_VIA = new Set(["free-limit", "menu-reoffer", "menu-question"]);
const MENU_QUESTIONS = [
  "want me to send you my menu so you can pick one? x",
  "want to see what I've got? x",
  "shall I show you what I've got babe? 😏",
];
// He is in the middle of it. No offer lands here.
const SCENE_RE = /\b(cock|dick|pussy|cunt|wet|horny|hard|wank|wanking|fuck|fucking|cum|cumming|stroke|stroking|suck|sucking|lick|licking|ride|riding|tits|arse|ass|naked|nude|inside (me|you)|doggy|squirt|moan)\b/i;

const bareOf = lower => String(lower || "").replace(/^(h+m+|m+h+m+|m+y+e+a+h+|ah+|oh+|erm+|well|ha+|aye)\s+/i, "").trim();

/* ctx: { offered, quoted, menuRecent, lastMediaFresh, namedItem }, all booleans
   loaded by autoReply. Returns the candidate routes in order; autoReply tries
   each sender in turn and the model is always last. */
function inboundSignals(text, ctx) {
  const c = ctx || {};
  const raw = String(text || "");
  const synthetic = !raw || SYNTHETIC_RE.test(raw);
  const base = { synthetic, routes: ["model"], reject: false, free: false, menuAsk: false,
                 thatPrice: false, methodHit: null, cardHit: false, askingHowPay: false };
  if (synthetic) return base;
  const lower = raw.toLowerCase();
  const bare = bareOf(lower);
  if (MEET_RE.test(lower)) return { ...base, routes: ["meet", "model"], meet: true };
  if (CUSTOM_RE.test(lower)) return { ...base, routes: ["custom", "model"], custom: true };
  const free = FREE_ASK_RE.test(lower);
  const thatPrice = DEICTIC_RE.test(lower) && COST_RE.test(lower) && !GENERAL_ITEM_RE.test(lower);
  const menuAsk = !thatPrice && MENU_ASK_RE.test(lower);
  const menuYes = !!c.offered && YES_RE.test(lower);
  // A no only counts as turning something down when something was offered.
  const reject = !!(c.quoted || c.menuRecent) && (REJECT_START_RE.test(bare) || REJECT_RE.test(lower));
  const starsHit = /\bstars?\b|⭐/.test(lower) &&
    (/\b(pay|paying|payment|with|use|send|via|ok|yes|yeah|please|can|do)\b/.test(lower) ||
     bare.split(/\s+/).filter(Boolean).length <= 4);
  const methodHit = starsHit ? "stars" : (/\bbank\b|\btransfer\b/i.test(lower) ? "bank" : null);
  const cardHit = /\b(card|link|fangate)\b/i.test(lower);
  const affirmative = AFFIRM_RE.test(bare);
  const wantsToPay = /\b(pay|paying|payment|send (you )?the (money|cash)|how do i pay|where do i send)\b/i.test(lower);
  const askingHowPay = /how (do|can) i pay|how.*(pay|payment)|payment (method|options|details)?|ways? to pay|pay options/.test(lower);
  const routes = [];
  if (c.quoted && !free && !reject && (methodHit || cardHit || affirmative || wantsToPay || askingHowPay)) routes.push("payment");
  if (thatPrice) routes.push(c.lastMediaFresh ? "price-of-that" : "menu-question");
  if (menuAsk || menuYes) routes.push("menu");
  if (!free && !menuAsk && (c.namedItem || BUY_INTENT_RE.test(raw))) routes.push("named-item");
  if (!free && !menuAsk && VIDEO_REQ_RE.test(lower)) routes.push("video-list");
  if (free) routes.push("free");
  routes.push("model");
  return { ...base, routes, reject, free, menuAsk, thatPrice, methodHit, cardHit, askingHowPay };
}
const routeInbound = (text, ctx) => inboundSignals(text, ctx).routes;

/* Did one of her last two lines, inside half an hour, offer the menu? */
function menuOffered(outs) {
  return (outs || []).slice(0, 2).some(r => minsAgo(r.sent_at) < 30 &&
    ((r.raw && OFFER_VIA.has(r.raw.via)) || MENU_OFFER_RE.test(r.body_preview || "")));
}

/* QUOTED: a payment request in the last day, not since declined or paid. */
function openQuoteRow(outs, conv, mem) {
  const q = (outs || []).find(r => r.raw && r.raw.via === "menu-buy" && r.raw.item_id);
  if (!q || minsAgo(q.sent_at) > 24 * 60) return null;
  const t = new Date(q.sent_at).getTime();
  if (conv && conv.declined_at && new Date(conv.declined_at).getTime() > t) return null;
  const oq = mem && mem.open_quote;
  if (oq && oq.item_id === q.raw.item_id && oq.status && oq.status !== "open" &&
      new Date(oq.at).getTime() >= t) return null;
  return q;
}

/* The once-a-day menu question. Never early, never mid-scene, never after a
   no, never with a price already open, never within a day of a list. */
function reofferDue(c) {
  if (!c || (Number(c.hisCount) || 0) < 6) return false;
  if (c.sellRecent || c.declinedRecent || c.quoted) return false;
  if ((c.recentIn || []).some(t => SCENE_RE.test(String(t || "")))) return false;
  return true;
}

/* "— 2 days later —" between rows more than six hours apart, and before the
   message being answered when the thread had gone quiet. */
function gapLabel(ms) {
  const h = ms / 3600000;
  if (h < 24) return "— " + Math.round(h) + " hours later —";
  const d = Math.round(h / 24);
  return "— " + d + " day" + (d === 1 ? "" : "s") + " later —";
}
function withGapMarkers(rows, now) {
  const out = [];
  let prev = null;
  for (const r of rows || []) {
    const t = r.sent_at ? new Date(r.sent_at).getTime() : NaN;
    if (prev != null && Number.isFinite(t) && t - prev > 6 * 3600 * 1000) out.push({ dir: "gap", text: gapLabel(t - prev) });
    if (Number.isFinite(t)) prev = t;
    out.push({ dir: r.dir, text: r.text });
  }
  if (now && prev != null && now - prev > 6 * 3600 * 1000) out.push({ dir: "gap", text: gapLabel(now - prev) });
  return out;
}

const gbpText = n => "£" + (Number(n) || 0).toFixed(2);

/* One deterministic line, sent as her, recorded sealed. */
async function sendLine(env, sb, conn, conv, chatId, line, via, extraRaw, readId) {
  const token = await botTokenFor(env, sb, conn);
  if (!token || !chatId || !line) return null;
  try {
    if (readId) await tg.readBusinessMessage(token, conn.id, chatId, readId).catch(() => {});
    await humanPace(token, conn.id, chatId, line).catch(() => {});
    const sent = await tg.sendMessage(token, conn.id, chatId, line);
    const sealed = await sealedBody(env, sb, conn.creator_id, line);
    await sb(env, "messages", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify({
        conversation_id: conv.id, creator_id: conn.creator_id,
        tg_message_id: sent && sent.message_id ? sent.message_id : null,
        direction: "out", sender: "ai", kind: "text",
        body_preview: preview(line), ...sealed,
        sent_at: new Date().toISOString(),
        raw: { via, ...(extraRaw || {}) },
      }),
    }).catch(e => console.log(JSON.stringify({ evt: "tg.line.record_failed", via, err: String(e).slice(0, 160) })));
    return { via, text: line };
  } catch (e) {
    console.log(JSON.stringify({ evt: "tg.line.send_failed", via, err: String(e).slice(0, 160) }));
    return null;
  }
}

/* Gate 4: he answered a quote (stars, bank, card, yes, how do I pay). */
async function routePayment(env, sb, conn, conv, msg, text, sig, quoteRow) {
  const quoted = quoteRow ? await itemById(env, sb, quoteRow.raw.item_id, quoteRow.raw.item_source) : null;
  if (!quoted) return null;
  if (sig.cardHit && quoted.metadata && quoted.metadata.fangate_url) {
    const sentLink = await sendFangateLink(env, sb, conn, conv, msg.chat.id, quoted);
    if (sentLink) return sentLink;
  }
  // Stars first: a digital item is unlocked in this chat, not by bank details.
  if (sig.methodHit === "stars" && starsEligible(quoted)) {
    const starsSent = await sendStarsItem(env, sb, conn, conv, msg.chat.id, quoted);
    if (starsSent) return starsSent;
  }
  if (!sig.methodHit) {
    const choice = await sendPayChoice(env, sb, conn, conv, msg.chat.id, quoted);
    if (choice) return choice;
  }
  const bankMethod = sig.methodHit === "stars" ? "bank" : (sig.methodHit || "bank");
  return await sendPayDetails(env, sb, conn, conv, msg.chat.id, quoted, bankMethod);
}

/* Gate 5: "what would that cost" about the thing she just sent. */
async function sendPriceOfThat(env, sb, conn, conv, msg, lm) {
  if (!lm) return null;
  if (!lm.item_id) return { ask_owner: true };          // a photo from her phone
  const item = await itemById(env, sb, lm.item_id, lm.source || "media");
  if (!item) return { ask_owner: true };
  if (!lm.free && Number(item.price_gbp || 0) > 0) {
    const req = await sendPaymentRequest(env, sb, conn, conv, msg, item);
    if (req) return req;
    // The lock is already on screen: say the price once, do not re-post it.
    const s = starsEligible(item) ? starsFor(item, env) : 0;
    if (!s) return null;
    return await sendLine(env, sb, conn, conv, msg.chat.id, `that one's ${s} ⭐ babe, just tap the lock 😏`,
      "price-of-that", { item_id: item.id, stars: s }, msg.message_id);
  }
  const kind = item.kind;
  const paid = (await sellableItems(env, sb, conn))
    .filter(i => i.kind === kind && Number(i.price_gbp || 0) > 0 && starsFor(i, env) > 0)
    .sort((a, b) => starsFor(a, env) - starsFor(b, env));
  const next = paid[0];
  const line = "that one's yours babe 😘" + (next ? " if you want more, " + next.title + " is " + starsFor(next, env) + " ⭐ x" : " x");
  return await sendLine(env, sb, conn, conv, msg.chat.id, line, "price-of-that",
    { item_id: item.id, free: true, next_item: next ? next.id : null }, msg.message_id);
}

/* Gate 8: he asked for a video without naming one. Show the ones she has. */
async function sendVideoList(env, sb, conn, conv, msg) {
  const vids = (await sellableItems(env, sb, conn))
    .filter(i => i.kind === "video" && Number(i.price_gbp || 0) > 0);
  if (vids.length === 1) return await sendPaymentRequest(env, sb, conn, conv, msg, vids[0]);
  if (vids.length < 2) return null;
  const lines = ["which one baby 😈"];
  for (const v of vids.slice(0, 6)) {
    const s = Number(v.price_stars) || starsFor(v, env) || 0;
    lines.push("• " + v.title + " - " + s + " ⭐");
  }
  lines.push("say the one you want and I'll unlock it x");
  const r = await sendLine(env, sb, conn, conv, msg.chat.id, lines.join("\n"), "video-options",
    { count: vids.length }, msg.message_id);
  return r ? { video_options: vids.length } : null;
}

async function autoReply(env, sb, conn, conv, msg, text, forcedReply) {
  // A photo or video with no caption is still a message. It used to be dropped
  // here because there was no text to answer, which is why sending a picture
  // got silence.
  const mediaOnly = !text && !!(msg.photo || msg.video || msg.animation ||
                                 msg.document || msg.sticker || msg.voice || msg.audio);
  if (!text && !mediaOnly) return null;
  if (mediaOnly) {
    text = "he sent you an attachment. React to it in one dirty line, like you just opened it. Never say you cannot see it, never describe it, and never ask him to send it again.";
  }

  const persona = await loadPersonaRow(env, sb, conn);
  const p = persona.row;
  if (p && p.enabled === false) return null;   // persona off: stay quiet

  // No typing indicator here: the reply is queued for 20 seconds to 2 minutes,
  // and a typing badge that runs that long is a tell, not a human touch. The
  // deterministic sends keep their own short typing pause.
  const stopTyping = () => {};

  // ROUTING. Narrowest intent first, canned lists last (OPUS-PLAN Fix 8). The
  // decision is the pure inboundSignals(); this only loads what it needs and
  // runs each route's existing sender, falling through when a sender has
  // nothing to send. Meet/platform already ran in onMessage (maybeDeflect).
  const mem = memOf(conv);
  const outs = (await sb(env, "messages?conversation_id=eq." + conv.id +
    "&direction=eq.out&select=raw,body_preview,sent_at&order=sent_at.desc&limit=12").catch(() => null)) || [];
  const quoteRow = openQuoteRow(outs, conv, mem);
  const lm = mem.last_media || null;
  const preSig = inboundSignals(text, {});
  const shortText = !preSig.synthetic && !preSig.free && !preSig.menuAsk &&
    bareOf(String(text || "").toLowerCase()).split(/\s+/).filter(Boolean).length <= 9;
  const namedItem = shortText ? await strongItemMatch(env, sb, conn, text) : null;
  const sig = inboundSignals(text, {
    offered: menuOffered(outs),
    quoted: !!quoteRow,
    menuRecent: outs.some(r => r.raw && r.raw.via === "menu-text" && minsAgo(r.sent_at) < 30),
    lastMediaFresh: !!(lm && minsAgo(lm.at) < 15),
    namedItem: !!namedItem,
  });
  const lower = String(text || "").toLowerCase();
  const rejectHit = sig.reject;
  let customAsk = false, ownerPhotoAsk = false;
  console.log(JSON.stringify({ evt: "tg.route", conversation: conv.id, routes: sig.routes }));
  for (const route of sig.routes) {
    if (route === "model" || route === "meet") break;
    if (route === "custom") { customAsk = true; break; }
    let r = null;
    if (route === "payment") {
      r = await routePayment(env, sb, conn, conv, msg, text, sig, quoteRow);
    } else if (route === "price-of-that") {
      r = await sendPriceOfThat(env, sb, conn, conv, msg, lm);
      if (r && r.ask_owner) { ownerPhotoAsk = true; break; }
    } else if (route === "menu-question") {
      r = await sendLine(env, sb, conn, conv, msg.chat.id, pickOf(MENU_QUESTIONS), "menu-question", {}, msg.message_id);
    } else if (route === "menu") {
      r = await maybeSendMenu(env, sb, conn, conv, msg);
    } else if (route === "named-item") {
      const picked = namedItem || await matchLiveItem(env, sb, conn, text);
      if (picked) r = await sendPaymentRequest(env, sb, conn, conv, msg, picked);
    } else if (route === "video-list") {
      r = await sendVideoList(env, sb, conn, conv, msg);
    } else if (route === "free") {
      // Never while a price is open: the free one would undercut it.
      if (!quoteRow) r = await maybeSendFreeItem(env, sb, conn, conv, msg);
    }
    if (r) { stopTyping(); return r; }
  }

  // A custom ask reaches the owner now, deterministically, before the model
  // can promise it or price it. The DeepSeek classifier is only a refinement
  // for asks the regex does not catch (maybeFlagCustomAsk after the queue).
  if (customAsk) {
    const who = (msg.from && (msg.from.first_name || msg.from.username)) || "someone";
    await notifyOwner(env, sb, conn, conv, msg, "Needs you", "Custom request from " + who + ": " + String(text).slice(0, 160)).catch(() => null);
    await remember(env, sb, conv, { custom_ask: { text: String(text).slice(0, 200), at: new Date().toISOString(), kind: "custom" } });
    console.log(JSON.stringify({ evt: "tg.custom_ask.gate", conversation: conv.id }));
  }
  if (ownerPhotoAsk) {
    const who = (msg.from && (msg.from.first_name || msg.from.username)) || "someone";
    await notifyOwner(env, sb, conn, conv, msg, "Needs you", who + " is asking the price of the photo you sent: " + String(text).slice(0, 120)).catch(() => null);
  }

  // Recent history. The stored preview is cut at 80 characters, so the end of
  // everything he said is lost; open the sealed body when the key is available.
  const hist = await sb(env, "messages?conversation_id=eq." + conv.id +
    "&direction=in.(" + encodeURIComponent("in,out") + ")&select=direction,body_preview,body_enc,body_nonce,sent_at" +
    "&order=sent_at.desc&limit=30").catch(() => null);
  let histDek = null;
  try { histDek = await getDek(env, sb, conn.creator_id); } catch (e) { histDek = null; }
  // Internal rows carry console-only labels like "[free] PIC TITLE" or
  // "[menu] 2 paid". They are bookkeeping, not chat the girl said, so strip
  // them before the model sees them - otherwise it parrots the tag verbatim.
  const stripInternal = s => String(s || "").replace(/\s*\[[^\]]{1,40}\]\s*/g, " ").replace(/\s+/g, " ").trim();
  const histRows = [];
  for (const m of (hist || []).reverse()) {
    let body = m.body_preview;
    if (histDek && m.body_enc && m.body_nonce) {
      try { body = await open(histDek, m.body_enc, m.body_nonce); } catch (e) { /* keep the preview */ }
    }
    if (!body || body === text) continue;
    const t = stripInternal(body);
    if (t) histRows.push({ dir: m.direction, text: t, sent_at: m.sent_at });
  }
  // "Still waiting babe" two days after "nearly ready for you x" is not the
  // next line in a hot chat. Mark the gap so the model knows time has passed.
  const history = withGapMarkers(histRows, Date.now());

  // Generate. A forced intercept answer skips the model.
  let replyText = null, via = null;
  // His name as Telegram knows it, for the post-generation guard: a name the
  // profile already gives must never be asked for.
  let guardName = "";
  try {
    if (forcedReply) {
      replyText = forcedReply.text;
      via = "intercept";
    } else {
      const catalogue = await liveCatalogue(env, sb, conn);
      // Who she's talking to + how far back it goes, so returning customers
      // are continued, not restarted.
      let custLine = "";
      {
        // conv.customers is not populated by the conversation query, which is
        // why every reply used to be told "you do not know his name yet" and
        // asked again even seconds after he had told her. Read the customer.
        let cu = (conv && conv.customers) || null;
        if (!cu && conv) {
          const q = conv.customer_id
            ? "customers?id=eq." + encodeURIComponent(conv.customer_id)
            : "customers?creator_id=eq." + encodeURIComponent(conn.creator_id) +
              "&tg_user_id=eq." + encodeURIComponent(conv.customer_ref || "");
          const rows = await sb(env, q + "&select=first_name,username,flags&limit=1").catch(() => null);
          cu = (rows && rows[0]) || {};
        }
        const custUser = String((cu && cu.username) || "").trim();
        const knownName = nameForChat(cu);
        const userHint = knownName || nameFromUsername(custUser);
        guardName = userHint || "";
        const askedBefore = history.some(h => h.dir === "out" && NAME_QUESTION.test(h.text));
        if (knownName) {
          custLine = "You're chatting with " + knownName + ", that is his name and he has told you. Use it now and then, the way you would with someone you know. Never ask him his name, not now and not later.";
        } else if (userHint) {
          custLine = "His username is @" + custUser + " and it carries the name " + userHint +
            ". Use it naturally without asking. Never ask him his name.";
        } else if (askedBefore) {
          custLine = "You have already asked him what he is called and he did not tell you. That is the end of it: never ask again, in this message or any later one. Carry on without a name and do not bring it up.";
        } else {
          custLine = "You do not know his name and his username gives nothing away. You may ask what he is called, casually, once, in the first few messages and never in the middle of a scene. If he does not answer, let it go and never ask again.";
        }
        // An open sale: a price quoted in the last three hours with nothing paid
        // since. Without this she answered "Tony" and drifted into flirting
        // instead of finishing the sale.
        try {
          const outs = await sb(env, "messages?conversation_id=eq." + conv.id +
            "&direction=eq.out&select=sender,sent_at,raw,body_preview&order=sent_at.desc&limit=6").catch(() => null);
          for (const m of outs || []) {
            const via = m.raw && m.raw.via;
            if ((via === "menu-buy" || via === "pay-details") &&
                (Date.now() - new Date(m.sent_at).getTime()) < 3 * 3600 * 1000) {
              custLine += " You quoted him " + (m.body_preview || "an item") +
                " and he has not paid yet. Do not chase it: if he comes back without paying, talk to him normally and let him raise it. One light mention at most, then never again.";
              break;
            }
          }
        } catch (e) { /* no open sale */ }
        const first = await sb(env, "messages?conversation_id=eq." + conv.id +
          "&direction=eq.in&select=sent_at&order=sent_at.asc&limit=1").catch(() => null);
        if (first && first[0]) {
          const days = Math.max(0, Math.round((Date.now() - new Date(first[0].sent_at)) / 86400000));
          if (days >= 1) custLine += " You two have been chatting for " + (days === 1 ? "a day" : days + " days") + " - pick up where you left off, don't restart like it's a first conversation.";
        }
      }
      let payLine = "";
      {
        const prof = await sb(env, "ai_profiles?creator_id=eq." + encodeURIComponent(conn.creator_id) +
          "&select=wallet_address,pay_bank_name,pay_sort_code,pay_account_no,pay_paypal,pay_note").catch(() => null);
        payLine = payLineFrom(prof && prof[0]);
      }
      // What she has already sent, so the prompt can name those lines and the
      // guard below can reject a rephrasing of one.
      const priorOut = history.filter(h => h.dir === "out").map(h => h.text).filter(Boolean).slice(-6);
      // Pick up what he sent since her last reply. A man who has sent four
      // things since she was last on does not need all four answered; he needs
      // the ones that matter, answered in a way that moves the chat on.
      let lastOutIdx = -1;
      for (let i = history.length - 1; i >= 0; i--) if (history[i].dir === "out") { lastOutIdx = i; break; }
      const since = history.slice(lastOutIdx + 1).filter(h => h.dir === "in").map(h => h.text).filter(Boolean);
      let catchUp = "";
      if (since.length) {
        catchUp = " Since your last reply he has sent: " + since.map(s => '"' + s + '"').join("; ") +
          ". Answer every direct question in there (where he is, how old, what you do, where you are based) inside that one reply, plus anything sexual or about buying; skip only pure filler. Do not answer each message separately, and do not let it go flat: take the dirtiest thread and push it further.";
      }
      // Selling before he has said anything is the thing that makes a chat feel
  // like a shop. In a new chat she flirts and nothing else.
  const hisCount = history.filter(h => h.dir === "in").length;
  const sellGate = hisCount < 2
    ? " He has only sent " + hisCount + " message" + (hisCount === 1 ? "" : "s") +
      " so far. Do not mention selling, prices or content at all in this reply, and do not drop hints about it. Chat and flirt, that is all."
    : "";
  const openerRule = hisCount === 1
    ? " This is your first reply to him. Pick up on what he actually said, in his own words, then ask him ONE short question about it (what he is into, where he is, what he does with his evenings). Overriding the usual rule against questions: ask that one question now. No prices, no menu, no content talk."
    : "";
  const rejectLine = rejectHit
    ? " He has just turned down what you offered. Do not repost it, do not repeat the price and do not ask him to unlock it again. Say something light, and if your menu has something else, name ONE other item (the cheapest is fine) exactly as it is written, once — then drop it. If he is not buying, just carry on chatting and flirting with him."
    : "";
  // What she knows about him, from this conversation's own memory only.
  const memLine = memoryLine(memOf(conv));
  if (memLine) custLine += (custLine ? " " : "") + memLine;
  const customLine = customAsk
    ? " He has just asked for something made specially for him. Do not quote a price, do not list anything and do not say yes or no to it yet. Ask him, in your own words, to tell you exactly what he wants, like \"ooh tell me exactly what you want x\"."
    : "";
  const ownerPhotoLine = ownerPhotoAsk
    ? " He is asking what the photo you just sent would cost. Do not give a price; say you will sort him out in a minute, warmly."
    : "";
  // He is chasing something she said she would send. Never "what did I say I'd send you?".
  const chasing = CHASE_IN.test(String(text || "")) &&
    (!!(memOf(conv).open_promise) || priorOut.some(o => PROMISE_OUT.test(o)));
  if (chasing && !quoteRow && !customAsk) {
    const kept = await maybeSendFreeItem(env, sb, conn, conv, msg).catch(() => null);
    if (kept) {
      await remember(env, sb, conv, { open_promise: { text: "chased", at: new Date().toISOString(), status: "kept" } });
      stopTyping();
      return kept;
    }
  }
  const chaseLine = chasing
    ? " He is asking where the thing you said you would send is. Never ask him what you said you would send. Say sorry babe in one light line, then ask if he wants to see what you've got."
    : "";
  // The re-offer is one question inside a normal reply, at most once a day,
  // never mid-scene, never after a no and never with a price open.
  let reoffer = false;
  if (!customAsk && !rejectHit && !chasing && !ownerPhotoAsk) {
    const since24 = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const recentSell = await sb(env, "messages?conversation_id=eq." + conv.id +
      "&direction=eq.out&raw->>via=in.(menu-text,menu-reoffer)&sent_at=gte." + encodeURIComponent(since24) +
      "&select=id&limit=1").catch(() => null);
    reoffer = reofferDue({
      hisCount,
      sellRecent: !Array.isArray(recentSell) || recentSell.length > 0,
      declinedRecent: minsAgo(conv.declined_at) < 24 * 60,
      quoted: !!quoteRow,
      recentIn: history.filter(h => h.dir === "in").slice(-3).map(h => h.text).concat([String(text || "")]),
    });
  }
  const reofferLine = reoffer
    ? " At the end of this reply, ask him lightly if he wants to see what you've got. Do not list anything and do not name a price."
    : "";
  const system = personaSystemPrompt(p, conn, catalogue, payLine, priorOut) + (custLine ? " " + custLine : "") + catchUp + sellGate + openerRule + rejectLine +
    customLine + ownerPhotoLine + chaseLine + reofferLine;
      try {
        replyText = scrubBankText(await generateReply(env, system, history, text));
      } catch (e) {
        // A failed generation must never leave him on read. Send one safe line.
        console.log(JSON.stringify({ evt: "tg.reply.generate_failed", err: String(e && e.message || e).slice(0, 200) }));
        replyText = "sorry babe my phone's playing up x say that again?";
        notifyOwner(env, sb, conn, conv, msg, "Reply failed",
          String(e && e.message || e).slice(0, 200)).catch(() => null);
      }
      via = "workers-ai";
      // The model has learned the gate wording and sometimes writes "N ⭐ unlocks
      // it" with no locked media behind it. That is a dead end for the customer.
      // If there is no wall on screen, post the real one for the item he named.
      if (replyText && /\d{2,5}\s*⭐/.test(replyText)) {
        const walls = await sb(env, "messages?conversation_id=eq." + conv.id +
          "&direction=eq.out&raw->>via=eq.stars-paid-media&select=id,sent_at&order=sent_at.desc&limit=1").catch(() => null);
        const onScreen = walls && walls[0] && Date.now() - new Date(walls[0].sent_at).getTime() < 30 * 60 * 1000;
        if (!onScreen) {
          const picked = await matchLiveItem(env, sb, conn, text);
          if (picked && starsEligible(picked)) {
            const walled = await sendPaymentRequest(env, sb, conn, conv, msg, picked);
            if (walled) { console.log(JSON.stringify({ evt: "tg.reply.gate_guard_walled", item: picked.id })); return walled; }
          }
          replyText = "want me to send you my menu so you can pick one? x";
          console.log(JSON.stringify({ evt: "tg.reply.gate_guard_text" }));
        }
      }
      // A name the profile or the username already gives must never be asked
      // for. The prompt says so, but a small model still asks, so this is the
      // hard backstop: one rewrite, then the question is cut out.
      if (replyText && guardName && NAME_QUESTION.test(replyText)) {
        console.log(JSON.stringify({ evt: "tg.reply.name_question", name: guardName, text: replyText.slice(0, 80) }));
        const fixed = await generateReply(env, system +
          " His name is " + guardName + " and you already know it. Never ask what he is called. " +
          "Rewrite the reply without any name question.", history, text).catch(() => null);
        if (fixed && !NAME_QUESTION.test(fixed)) replyText = fixed;
        else {
          replyText = stripNameQuestion(replyText) || ("hey " + guardName + " x");
          console.log(JSON.stringify({ evt: "tg.reply.name_question_stripped", text: replyText.slice(0, 80) }));
        }
      }
      // One retry when the model loops. Without it a small model sends the
      // same sentence twice in a row, which is what the owner hears as
      // "she is very repetitive". If the retry loops too, nothing is sent: a
      // repeat means she has just answered him, and the same line twice is
      // worse than a beat of silence.
      if (replyText && repeatsSomething(replyText, priorOut)) {
        console.log(JSON.stringify({ evt: "tg.reply.repeat_retry", text: replyText.slice(0, 80) }));
        let fresh = null;
        for (let attempt = 0; attempt < 2 && !fresh; attempt++) {
          const retry = await generateReply(env, system +
            " You were about to repeat yourself. Do NOT send this line or anything like it: \"" + replyText +
            "\". Say something completely new about what he just said.", history, text);
          if (!retry) break;
          if (!repeatsSomething(retry, priorOut)) fresh = retry;
          else console.log(JSON.stringify({ evt: "tg.reply.repeat_again", text: retry.slice(0, 80) }));
        }
        if (fresh) replyText = fresh;
        else {
          console.log(JSON.stringify({ evt: "tg.reply.repeat_suppressed",
            conversation: conv.id, text: replyText.slice(0, 80) }));
          // Silence reads as a broken bot. A short, plain line is better.
          replyText = pickOf(["say that again for me x", "go on, tell me x", "and? x"]);
        }
      }
      if (replyText) replyText = ensureEmoji(replyText, p && p.emoji_level);
      // An empty model answer must never become silence: a man waiting on a
      // reply assumes the account is dead. One short line keeps it alive.
      if (!replyText) {
        replyText = pickOf(["you still there? x", "mmm go on x", "tell me more x"]);
        console.log(JSON.stringify({ evt: "tg.reply.empty_fallback", conversation: conv.id }));
      }
      // Never queue a promise nothing will keep. Keep it now with a picture
      // he is still allowed, or turn it into an offer he can say yes to.
      if (PROMISE_OUT.test(replyText)) {
        const freeHad = (memOf(conv).free_sent || []).length;
        const kept = (!quoteRow && freeHad < 2)
          ? await maybeSendFreeItem(env, sb, conn, conv, msg).catch(() => null) : null;
        if (kept) {
          await remember(env, sb, conv, { open_promise: { text: replyText.slice(0, 120), at: new Date().toISOString(), status: "kept" } });
          console.log(JSON.stringify({ evt: "tg.reply.promise_kept", conversation: conv.id }));
          stopTyping();
          return kept;
        }
        console.log(JSON.stringify({ evt: "tg.reply.promise_rewritten", conversation: conv.id, text: replyText.slice(0, 80) }));
        const offers = MENU_QUESTIONS.filter(q => !repeatsSomething(q, priorOut));
        replyText = pickOf(offers.length ? offers : MENU_QUESTIONS);
      }
      if (reoffer) {
        if (!MENU_OFFER_RE.test(replyText)) replyText = replyText + "\nwant to see what I've got? x";
        via = "menu-reoffer";
      }
    }
  } catch (e) {
    console.log(JSON.stringify({ evt: "tg.reply.generate_failed", err: String(e).slice(0, 200) }));
    stopTyping();
    return null;
  }

  // Queue the reply with a human delay instead of holding the webhook open.
  // A request that sleeps for two minutes gets retried by Telegram, and a
  // typing indicator cannot run that long either. The queue delivers at the
  // drawn time and records the row then.
  // Is the owner in this chat right now? A human reply in the last fifteen
  // minutes means the account is visibly online, so she answers at that speed.
  let ownerOnline = false;
  try {
    const lastOut = await sb(env, "messages?conversation_id=eq." + conv.id +
      "&direction=eq.out&select=sender,sent_at&order=sent_at.desc&limit=1").catch(() => null);
    if (lastOut && lastOut[0] && lastOut[0].sender === "human") {
      ownerOnline = (Date.now() - new Date(lastOut[0].sent_at).getTime()) < 15 * 60 * 1000;
    }
  } catch (e) { ownerOnline = false; }
  replyText = finishReply(replyText);
  const hisMsgCount = history.filter(h => h.dir === "in").length;
  let delay = 30;
  try { delay = replyDelaySeconds(text, conv, { ownerOnline, hisCount: hisMsgCount,
    priorText: history.slice(-3).map(h => h.text).join(" "),
    replyText,
    sentMedia: !!(msg.photo || msg.voice || msg.video || msg.video_note) }); }
  catch (e) { console.log(JSON.stringify({ evt: "tg.reply.delay_failed", err: String(e && e.message || e).slice(0, 160) })); }
  const sealed = histDek ? await seal(histDek, replyText) : {};
  try {
    await env.REPLY_QUEUE.send({
      conversation_id: conv.id,
      creator_id: conn.creator_id,
      business_connection_id: conn.id,
      chat_id: msg.chat.id,
      text: replyText,
      body_enc: sealed.body_enc || null,
      body_nonce: sealed.body_nonce || null,
      sender: "ai",
      via,
      read_message_id: msg.message_id || null,
      generated_at: new Date().toISOString(),
    }, { delaySeconds: delay });
    stopTyping();
    // After the reply is queued, not before: a custom ask is flagged in the
    // background so it never delays what the customer sees.
    if (!customAsk) await maybeFlagCustomAsk(env, sb, conn, conv, msg, text).catch(() => null);
    console.log(JSON.stringify({ evt: "tg.reply.queued", delay }));
    return { via, text: replyText, queued: delay };
  } catch (e) {
    console.log(JSON.stringify({ evt: "tg.reply.queue_failed", err: String(e).slice(0, 200) }));
    stopTyping();
    return null;
  }
}

/**
 * Send one free (price 0, live) library item when the customer asks for
 * something free. Media goes out through the business connection via a signed
 * URL; the row is recorded so history and the console show it.
 * Returns the send result, or null when nothing suitable / send failed.
 */
/* When he asks for another free one after she has already sent hers, she draws
   the line instead of re-sending the file: the free one was free, the rest is
   paid. Rotated so the same sentence never lands twice. */
const FREE_LIMIT_LINES = [
  "I sell photos and videos yeah, but that's boring… I like knickers 😈 knowing you're sniffing over me 🥵 want to see what I've got x",
  "I do sell pics and videos yeah, but honestly? nothing beats my knickers, worn all day, you sniffing over me 🥵 want the list x",
  "photos and videos yeah, but I'm a knickers girl 😈 knowing you're getting off to the smell of me 🥵 want to see what I've got x",
  "I sell pics and videos too, but that's boring… knickers is where it's at, worn all day, you sniffing them 🥵 want the list x",
  "yeah I sell photos and videos, but my knickers are the thing 😈 all day in them, knowing you're sniffing over me 🥵 want to see what I've got x",
];

async function sendFreeLimitLine(env, sb, conn, conv, msg, recent, token) {
  const seen = (recent || []).map(m => String(m.body_preview || "").toLowerCase());
  const fresh = FREE_LIMIT_LINES.filter(l => !seen.some(b => b.includes(l.slice(0, 22).toLowerCase())));
  const pool = fresh.length ? fresh : FREE_LIMIT_LINES;
  const line = pool[Math.floor(Math.random() * pool.length)];
  const sealedLimit = await sealedBody(env, sb, conn.creator_id, line);
  try {
    const sent = await tg.sendMessage(token, conn.id, msg.chat.id, line);
    await sb(env, "messages", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify({
        conversation_id: conv.id,
        creator_id: conn.creator_id,
        tg_message_id: sent && sent.message_id ? sent.message_id : null,
        direction: "out",
        sender: "ai",
        kind: "text",
        body_preview: line.slice(0, 80),
        ...sealedLimit,
        sent_at: new Date().toISOString(),
        raw: { via: "free-limit" },
      }),
    }).catch(() => {});
    console.log(JSON.stringify({ evt: "tg.free_limit" }));
    return { free_limit: true };
  } catch (e) {
    console.log(JSON.stringify({ evt: "tg.free_limit.failed", err: String(e).slice(0, 200) }));
    return null;
  }
}

async function maybeSendFreeItem(env, sb, conn, conv, msg) {
  if (!conn.telegram_account_id) return null;
  // Live, price-0 items tagged to THIS girl's account.
  let rows = await sb(env, "media_items?telegram_account_id=eq." +
    encodeURIComponent(conn.telegram_account_id) +
    "&visible=eq.true&price_gbp=eq.0&select=id,title,kind,media_key" +
    "&order=uploaded_at.desc&limit=5").catch(() => null);
  // A freebie uploaded before the account existed still counts.
  if (!(rows && rows.length)){
    rows = await sb(env, "media_items?creator_id=eq." + encodeURIComponent(conn.creator_id) +
      "&visible=eq.true&price_gbp=eq.0&select=id,title,kind,media_key" +
      "&order=uploaded_at.desc&limit=5").catch(() => null);
  }
  const items = (rows || []).filter(m => m.media_key);   // need a real file
  if (!items.length) return null;
  // Don't spam the same file repeatedly: skip if we sent this item's media in
  // the last 10 messages of this conversation.
  const recent = await sb(env, "messages?conversation_id=eq." + conv.id +
    "&direction=eq.out&select=tg_message_id,media_key,body_preview&order=sent_at.desc&limit=10").catch(() => null);

  const token = await botTokenFor(env, sb, conn);
  if (!token) return null;

  // Free pictures rotate: two at most, never the same file twice.
  const freeHist = await sb(env, "messages?conversation_id=eq." + conv.id +
    "&direction=eq.out&raw->>via=eq.free-item&select=raw&order=sent_at.desc&limit=10").catch(() => null);
  // Lifetime per (her, his chat): the rows, plus memory, which survives a
  // reconnect even before old rows are merged into this conversation.
  const sentFreeIds = [...new Set((freeHist || []).map(m => m.raw && m.raw.item_id).filter(Boolean)
    .concat(Array.isArray(memOf(conv).free_sent) ? memOf(conv).free_sent : []))];
  if (sentFreeIds.length >= 2) return null;

  // First free request: the face picture, and only that one. He sees her, then
  // the next ask gets the paid list. Other free files stay in reserve.
  const opener = items.find(m => !sentFreeIds.includes(m.id) && /\bface\b|selfie/i.test(m.title || ""))
    || items.find(m => !sentFreeIds.includes(m.id));
  if (!opener) return null;
  const batch = opener ? [opener] : [];
  const sentIds = [];
  for (let i = 0; i < batch.length; i++) {
    const it = batch[i];
    // Signed URL the Telegram servers can fetch the file from. Console uploads
    // live in Supabase Storage (content-store), not the Worker's R2 bucket.
    let fileUrl = null;
    try {
      const r = await fetch(env.SUPABASE_URL + "/storage/v1/object/sign/content-store/" +
        it.media_key.split("/").map(encodeURIComponent).join("/"), {
        method: "POST",
        headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY,
                   "Content-Type": "application/json" },
        body: JSON.stringify({ expiresIn: 3600 }),
      });
      const d = await r.json();
      if (d && d.signedURL) fileUrl = env.SUPABASE_URL + "/storage/v1" + d.signedURL;
    } catch (e) {
      console.log(JSON.stringify({ evt: "tg.free_item.sign_failed", err: String(e).slice(0, 150) }));
    }
    if (!fileUrl) continue;
    const tgKind = it.kind === "image" ? "photo" : it.kind === "video" ? "video" : "document";
    try {
      const cap = pickOf(FREE_CAPTIONS);
      if (i === 0 && msg.message_id) await tg.readBusinessMessage(token, conn.id, msg.chat.id, msg.message_id).catch(() => {});
      if (i === 0) await humanPace(token, conn.id, msg.chat.id, cap);
      const sent = await tg.sendMedia(token, conn.id, msg.chat.id, tgKind, fileUrl,
        i === 0 ? cap : "");
      await sb(env, "messages", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify({
          conversation_id: conv.id,
          creator_id: conn.creator_id,
          tg_message_id: sent && sent.message_id ? sent.message_id : null,
          direction: "out",
          sender: "ai",
          kind: "text",
          body_preview: "[free] " + (it.title || ""),
          media_key: it.media_key,
          sent_at: new Date().toISOString(),
          raw: { via: "free-item", item_id: it.id },
        }),
      }).catch(e => console.log(JSON.stringify({ evt: "tg.free_item.record_failed", err: String(e).slice(0, 160) })));
      sentIds.push(it.id);
      const at = new Date().toISOString();
      await remember(env, sb, conv, m => ({
        free_sent: [...new Set((Array.isArray(m.free_sent) ? m.free_sent : []).concat([it.id]))],
        last_media: { item_id: it.id, source: "media", kind: it.kind || null, stars: 0, free: true, via: "free-item", at },
      }));
    } catch (e) {
      console.log(JSON.stringify({ evt: "tg.free_item.send_failed", item: it.id, err: String(e).slice(0, 200) }));
    }
  }
  if (!sentIds.length) return null;                // fall back to a text reply
  console.log(JSON.stringify({ evt: "tg.free_item.sent", items: sentIds.length }));
  return { free_items: sentIds };
}

/* The owner's menu is the shop, and it is what the model is told to sell from:
   it can hold photos, videos, posted things and services, all priced in pounds.
   Every path that SELLS must read this same list. Before this helper the model
   quoted menu items while the buttons, the matcher and the payment request all
   read media_items, so a customer could pick something no button existed for. */
async function sellableItems(env, sb, conn) {
  if (!conn.telegram_account_id) return [];
  const menu = await sb(env, "telegram_menu_items?telegram_account_id=eq." +
    encodeURIComponent(conn.telegram_account_id) +
    "&active=eq.true&select=id,name,kind,price_gbp,price_stars,description,media_key&order=position.asc&limit=20").catch(() => null);
  if (menu && menu.length) {
    return menu.filter(m => m.name).map(m => ({ ...m, title: m.name, source: "menu" }));
  }
  const rows = await sb(env, "media_items?telegram_account_id=eq." +
    encodeURIComponent(conn.telegram_account_id) +
    "&visible=eq.true&select=id,title,kind,price_gbp,price_stars,media_key,metadata,duration_secs&order=price_gbp.desc.nullslast&limit=20").catch(() => null);
  return (rows || []).filter(m => m.title).map(m => ({ ...m, source: "media" }));
}

/* MENU: list the items she actually sells, with their prices, when a customer
   asks what she offers. Paid items come from the owner's menu; a freebie still
   comes from the library because it has to be a real file. Falls through to the
   model when there is nothing, so nothing is invented from thin air. */
async function maybeSendMenu(env, sb, conn, conv, msg) {
  if (!conn.telegram_account_id) return null;
  const items = (await sellableItems(env, sb, conn)).filter(m => m.title);
  if (!items.length) return null;

  const priceOf = m => Number(m.price_gbp || 0);
  const fmt = m => {
    const s = Number(m.price_stars) || starsFor(m, env) || 0;
    return s ? s + " ⭐" : "";
  };
  const paid = items.filter(m => priceOf(m) > 0).slice(0, 45);
  if (!paid.length) return null;
  const lines = ["here's what you can have from me 😈"];
  for (const m of paid) {
    lines.push("• " + m.title + " - " + fmt(m) + (m.kind === "physical" ? " (posted)" : ""));
  }
  lines.push("and I'm dirty and my imagination's crazy, so if there's something you want that's not on there, tell me and we'll make it happen 😈");
  lines.push("want any of them? treat me right and they're yours x");
  const menuText = lines.join("\n");

  const token = await botTokenFor(env, sb, conn);
  if (!token) return null;
  try {
    // No holding line, no buttons, and no free picture glued to it: sent in
    // the same breath, the freebie looked like the product. The list lands as
    // plain text a few seconds later, like she typed it.
    const menuDelay = 18 + Math.floor(Math.random() * 14);   // 18 to 31 seconds
    await env.REPLY_QUEUE.send({
      conversation_id: conv.id,
      creator_id: conn.creator_id,
      business_connection_id: conn.id,
      chat_id: msg.chat.id,
      text: menuText,
      body_enc: null,
      body_nonce: null,
      sender: "ai",
      via: "menu-text",
      read_message_id: msg.message_id || null,
      generated_at: new Date().toISOString(),
    }, { delaySeconds: menuDelay });
    console.log(JSON.stringify({ evt: "tg.menu.sent", paid: paid.length, delay: menuDelay }));
    return { menu: true, queued: menuDelay };
  } catch (e) {
    console.log(JSON.stringify({ evt: "tg.menu.send_failed", err: String(e).slice(0, 200) }));
    return null;
  }
}

/* A customer asking for something she does not sell (a tin of beans, worn
   socks, a phone call) is the best lead in the chat and the worst thing to leave
   to her: she will either promise it or fob him off. A cheap check spots the
   ask, and the owner gets a Telegram nudge with the exact words so he can step
   in and price it himself. */
const CUSTOM_ASK_GATE = /\b(can you|could you|do you have|have you got|got any|any chance|i want|i'd like|i would like|send me|make me|is there any|would you|do you do)\b/i;

/* Every device that installed the console on its home screen gets the same
   nudge as the Telegram owner, so whoever is watching the shop hears about an
   off-menu request even with the app closed. Dead subscriptions are dropped. */
/* One place that tells the owner something happened: Telegram for the phone in
   his pocket even when the app is closed, and a home-screen push for every
   device that installed the console. */
export async function notifyOwner(env, sb, conn, conv, msg, title, body) {
  const url = "https://telebotcreator.turboit.uk/#inbox";
  const who = (conv && conv.customer_ref) ? "" : "";
  try {
    const token = await botTokenFor(env, sb, conn);
    if (token && env.OWNER_TELEGRAM_ID) {
      await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: env.OWNER_TELEGRAM_ID,
          text: "🔔 " + title + "\n" + String(body || "").slice(0, 300) + "\n\n" + url,
          disable_web_page_preview: true,
        }),
      }).catch(() => {});
    }
  } catch (e) { /* the push below is the backstop */ }
  // The icon badge counts alerts since the app was last opened, so the number
  // on the icon means "things I have not looked at", not "messages".
  let badge = 0;
  try {
    badge = (Number(await env.PUSH_KV.get("badge")) || 0) + 1;
    await env.PUSH_KV.put("badge", String(badge));
  } catch (e) { badge = 0; }
  await sendPushToAll(env, title, body, url, badge).catch(() => 0);
}

async function sendPushToAll(env, title, body, url, badge) {
  if (!env.PUSH_KV || !env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return 0;
  let sent = 0;
  try {
    const list = await env.PUSH_KV.list({ prefix: "sub:" });
    for (const k of list.keys) {
      const row = await env.PUSH_KV.get(k.name, "json");
      const sub = row && row.subscription;
      if (!sub) continue;
      try {
        const payload = await buildPushPayload(
          { data: JSON.stringify({ title, body, url, badge }), options: { ttl: 3600, urgency: "high" } },
          sub,
          { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY },
        );
        const res = await fetch(sub.endpoint, payload);
        if (res.status === 404 || res.status === 410) await env.PUSH_KV.delete(k.name);
        if (res.ok) sent++;
      } catch (e) {
        console.log(JSON.stringify({ evt: "push.failed", err: String(e).slice(0, 120) }));
      }
    }
  } catch (e) {
    console.log(JSON.stringify({ evt: "push.list_failed", err: String(e).slice(0, 120) }));
  }
  return sent;
}

async function maybeFlagCustomAsk(env, sb, conn, conv, msg, text) {
  if (!env.OWNER_TELEGRAM_ID || !env.DEEPSEEK_API_KEY) return null;
  if (!text || /^he sent you/.test(text)) return null;
  if (!CUSTOM_ASK_GATE.test(text)) return null;
  try {
    const menu = (await sellableItems(env, sb, conn)).map(m => m.title).filter(Boolean);
    const prompt = "Menu: " + (menu.join(", ") || "priced pictures and videos") +
      "\nCustomer: \"" + String(text).slice(0, 400) + "\"\n" +
      "Is he asking for something specific that is NOT on the menu (for example a tin of beans, worn socks, a phone call, a meet)? Answer YES or NO only.";
    const r = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.DEEPSEEK_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 4,
        temperature: 0,
        stream: false,
      }),
    });
    const d = await r.json();
    const verdict = String(d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content || "").trim();
    if (!/^yes/i.test(verdict)) return null;
    const who = conv.customer_name || conv.title || (msg.from && msg.from.first_name) || "someone";
    await notifyOwner(env, sb, conn, conv, msg, "Off-menu request", who + ": " + String(text).slice(0, 140));
    console.log(JSON.stringify({ evt: "tg.custom_ask.flagged" }));
    return true;
  } catch (e) {
    console.log(JSON.stringify({ evt: "tg.custom_ask.failed", err: String(e).slice(0, 160) }));
    return null;
  }
}

async function botTokenFor(env, sb, conn) {  // The bot token lives in the bots table, keyed by persona. We try the
  // telegram account username first, then the connection's account username.
  const unames = [];
  if (conn.telegram_account_id) {
    const acc = await sb(env, "telegram_accounts?id=eq." +
      encodeURIComponent(conn.telegram_account_id) + "&select=username").catch(() => null);
    if (acc && acc[0] && acc[0].username) unames.push(acc[0].username.toLowerCase());
  }
  for (const uname of unames) {
    const rows = await sb(env, "bots?persona=eq." + encodeURIComponent(uname) + "&select=token")
      .catch(() => null);
    if (rows && rows.length && rows[0].token) return rows[0].token;
  }
  return null;
}

async function onDeleted(env, sb, d) {
  const rows = await sb(env, "conversations?business_connection_id=eq." +
    encodeURIComponent(d.business_connection_id) + "&chat_id=eq." + d.chat.id + "&select=id");
  const conv = rows && rows[0];
  if (!conv) return { skipped: "unknown conversation" };
  const ids = (d.message_ids || []).join(",");
  if (!ids) return { skipped: "no ids" };
  await sb(env, `messages?conversation_id=eq.${conv.id}&tg_message_id=in.(${ids})`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ deleted_at: new Date().toISOString() }),
  });
  return { deleted: d.message_ids.length };
}

// ---------------------------------------------------------------------------
// Direct message to the BOT itself (someone opened @Michelle0161bot and typed).
/* Does this message look like the customer choosing an item? Catches
   "the video please", "i'll take the full nude one", "yes", "yes pls". */
/* A short message that names an item is a buy signal in a shop, even without a
   verb. "worn leggings" as a reply to the menu means quote it, not talk about
   it. Requiring two matching words keeps "knickers" from quoting at random. */
async function strongItemMatch(env, sb, conn, text) {
  const items = (await sellableItems(env, sb, conn))
    .filter(m => m.title && Number(m.price_gbp || 0) > 0);
  const clean = (v) => String(v || "").replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, " ").toLowerCase();
  const lower = clean(text);
  let best = null, bestScore = 0;
  for (const it of items) {
    const t = clean(it.title).replace(/[^a-z0-9]+/g, " ").trim();
    if (!t) continue;
    let score = t.split(" ").filter(w => w.length > 3 && lower.includes(w)).length;
    if (lower.includes(t)) score = 99;
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return bestScore >= 2 ? best : null;
}

async function looksLikeBuyIntent(text, lower) {
  if (!text) return false;
  // Only a clear decision to buy. Naming a video or asking to see something is
  // not a purchase, and treating it as one fired prices and payment buttons at
  // men who were only chatting.
  return BUY_INTENT_RE.test(text);
}

/* Match their words against her live item titles. Exact-word overlap wins;
   fall back to kind words (video/pic) matching the item kind. */
async function matchLiveItem(env, sb, conn, text) {
  // Same list the model sells from. A media-only matcher could never find a
  // menu item, so "the three photo set please" produced no payment request.
  const items = (await sellableItems(env, sb, conn))
    .filter(m => m.title && Number(m.price_gbp || 0) > 0);
  if (!items.length) return null;
  const lower = String(text || "").toLowerCase();
  let best = null, bestScore = 0;
  for (const it of items) {
    const words = it.title.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3);
    let score = 0;
    for (const w of words) if (lower.includes(w)) score++;
    if (score > bestScore) { bestScore = score; best = it; }
  }
  if (best && bestScore > 0) return best;
  // "the 2 min one" is how men ask for a video. Match on the length.
  const dm = lower.match(/(\d+)\s*(mins?|minutes?|secs?|seconds?)/);
  if (dm) {
    const want = /min/.test(dm[2]) ? Number(dm[1]) * 60 : Number(dm[1]);
    const hit = items.find(i => Number(i.duration_secs) > 0 &&
      Math.abs(Number(i.duration_secs) - want) <= Math.max(3, want * 0.2));
    if (hit) return hit;
  }
  // Kind-based fallback: "the video please" when exactly one video is live.
  const wantsVideo = /video|vid|clip/.test(lower);
  const wantsPic = /pic|photo|image|nude|naked/.test(lower);
  if (wantsVideo) {
    const vids = items.filter(i => i.kind === "video");
    if (vids.length === 1) return vids[0];
  } else if (wantsPic) {
    const pics = items.filter(i => i.kind === "image");
    if (pics.length === 1) return pics[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// callback_query: a customer tapped a menu button. buy:<media_id> asks for
// payment (TON transfer to her wallet), free:<media_id> sends the freebie.
// ---------------------------------------------------------------------------
async function onCallback(env, sb, cq, persona) {
  const data = String(cq.data || "");
  const m = data.match(/^(buy|free):([0-9a-f-]{36})$/i);
  const pm = data.match(/^pay:(ton|paypal|bank|stars):([0-9a-f-]{36})$/i);
  if (!m && !pm) {
    console.log(JSON.stringify({ evt: "tg.callback.unknown", data: data.slice(0, 40) }));
    return { skipped: "unknown callback" };
  }
  const action = m ? m[1] : "pay";
  const mediaId = m ? m[2] : pm[2];

  // free: is always a library row because it has to send a real file. buy: and
  // pay: resolve through the same helper as the quote, so menu items work.
  let item = null;
  if (action === "free") {
    const rows = await sb(env, "media_items?id=eq." + encodeURIComponent(mediaId) + "&select=*").catch(() => null);
    item = rows && rows[0] ? { ...rows[0], source: "media" } : null;
  } else {
    item = await itemById(env, sb, mediaId);
  }
  if (!item) return { skipped: "item not found" };

  const bcId = (cq.message && cq.message.business_connection_id) || null;
  let conn = null;
  if (bcId) {
    const c = await sb(env, "business_connections?id=eq." + encodeURIComponent(bcId) +
      "&select=id,creator_id,telegram_account_id,tg_user_id,is_enabled,rights").catch(() => null);
    conn = c && c[0];
  }
  if (!conn && item.telegram_account_id) {
    const c = await sb(env, "business_connections?telegram_account_id=eq." +
      encodeURIComponent(item.telegram_account_id) + "&is_enabled=eq.true&creator_id=not.is.null" +
      "&select=id,creator_id,telegram_account_id,tg_user_id,is_enabled,rights").catch(() => null);
    conn = c && c[0];
  }
  if (!conn || !conn.creator_id) return { skipped: "no connection for callback" };

  const token = await botTokenFor(env, sb, conn);
  const chatId = cq.message ? cq.message.chat.id : null;
  if (!token || !chatId) return { skipped: "no token or chat" };

  const upsertCust = await upsert(sb, env, "customers", "creator_id,tg_user_id", {
    creator_id: conn.creator_id,
    tg_user_id: cq.from.id,
    username: cq.from.username || null,
    first_name: cq.from.first_name || null,
    last_name: cq.from.last_name || null,
    last_seen_at: new Date().toISOString(),
  });
  const cust = upsertCust && upsertCust[0];
  const conv = await findOrCreateConversation(env, sb, conn, chatId, {
    customer_id: cust ? cust.id : null,
    customer_ref: String(cq.from.id),
  });
  if (!conv) return { skipped: "no conversation" };

  if (action === "pay") {
    const method = pm[1];
    try { await tg.answerCallbackQuery(token, cq.id); } catch (e) {
      console.log(JSON.stringify({ evt: "tg.callback.ack_failed", err: String(e).slice(0, 120) })); }
    if (method === "stars" && starsEligible(item)) {
      const starSent = await sendStarsItem(env, sb, conn, conv, chatId, item);
      if (starSent) return starSent;
    }
    return await sendPayDetails(env, sb, conn, conv, chatId, item, method === "stars" ? "bank" : method);
  }

  if (action === "free") {
    try { await tg.answerCallbackQuery(token, cq.id, "Sending it over 😊"); } catch (e) {
      console.log(JSON.stringify({ evt: "tg.callback.ack_failed", err: String(e).slice(0, 120) })); }
    const fakeMsg = { chat: { id: chatId }, message_id: cq.message ? cq.message.message_id : null };
    const sentFree = await maybeSendFreeItem(env, sb, conn, conv, fakeMsg);
    if (sentFree) return { free_item: mediaId };
    await tg.sendMessage(token, conn.id, chatId, "Sorry, that one's not available right now 💔");
    return { free_fallback: true };
  }

  // buy: ack, then the shared payment-request flow.
  try { await tg.answerCallbackQuery(token, cq.id, item.title + " · " + (starsFor(item, env) || 0) + " ⭐"); } catch (e) {
    console.log(JSON.stringify({ evt: "tg.callback.ack_failed", err: String(e).slice(0, 120) })); }
  const r = await sendPaymentRequest(env, sb, conn, conv, { chat: { id: chatId } }, item);
  await sb(env, "conversations?id=eq." + conv.id, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ purchase_intent_at: new Date().toISOString() }),
  }).catch(() => {});
  console.log(JSON.stringify({ evt: "tg.menu.buy_pressed", item: item.id, price: item.price_gbp }));
  return r || { buy_pressed: item.id };
}


/* The most recent item this conversation was quoted for, if any. */
/* One id can be a menu item or an older library row. Resolve it the same way
   everywhere so a quote, a button tap and a payment lookup never disagree. */
async function itemById(env, sb, id, source) {
  if (!id) return null;
  if (source !== "media") {
    const m = await sb(env, "telegram_menu_items?id=eq." + encodeURIComponent(id) + "&select=*").catch(() => null);
    if (m && m[0]) return { ...m[0], title: m[0].name || m[0].title, source: "menu" };
  }
  const r = await sb(env, "media_items?id=eq." + encodeURIComponent(id) + "&select=*").catch(() => null);
  return r && r[0] ? { ...r[0], source: "media" } : null;
}

async function lastQuotedItem(env, sb, conv) {
  const rows = await sb(env, "messages?conversation_id=eq." + conv.id +
    "&direction=eq.out&select=raw&order=sent_at.desc&limit=10").catch(() => null);
  const m = (rows || []).find(r => r.raw && r.raw.via === "menu-buy" && r.raw.item_id);
  if (!m) return null;
  return await itemById(env, sb, m.raw.item_id, m.raw.item_source);
}

/* Telegram Stars. A digital item with a file behind it can be unlocked in the
   chat for Stars; a posted item or a service can never be, so it is bank only.
   Star price is derived from the GBP price unless the item carries its own. */
const STAR_GBP_DEFAULT = 0.0097;   // £ the bot keeps per Star ($0.0130 × 0.749); override with STAR_GBP_RATE

function starsEligible(item) {
  if (!item) return false;
  const kind = String(item.kind || "").toLowerCase();
  if (kind === "physical" || kind === "service") return false;
  return !!item.media_key;
}

function starsFor(item, env) {
  if (!item) return 0;
  const explicit = Number(item.price_stars) || 0;
  if (explicit > 0) return Math.min(25000, Math.max(1, Math.round(explicit)));
  // price_gbp only: price_ton always held pounds and is deprecated (0018).
  const gbp = Number(item.price_gbp) || 0;
  if (!gbp) return 0;
  const rate = Number(env.STAR_GBP_RATE) > 0 ? Number(env.STAR_GBP_RATE) : STAR_GBP_DEFAULT;
  const raw = gbp / rate;
  const rounded = raw >= 100 ? Math.round(raw / 10) * 10 : Math.max(1, Math.round(raw));
  return Math.min(25000, rounded);
}

/* The cheapest payable digital item, used when he says "stars" without having
   picked one: something locked has to appear for him to tap. */
async function cheapestStarsItem(env, sb, conn) {
  const items = (await sellableItems(env, sb, conn))
    .filter(i => starsEligible(i) && starsFor(i, env) > 0);
  if (!items.length) return null;
  items.sort((a, b) => starsFor(a, env) - starsFor(b, env));
  return items[0];
}

const STARS_THANKS = [
  "enjoy that one 😏",
  "all yours now x",
  "there you go babe 😈",
  "paid and sent, just like that 💋",
  "have fun with it 😜",
];

/* Console uploads live in Supabase Storage (content-store), not R2. Sign a URL
   Telegram can fetch; fall back to uploading R2 bytes for legacy rows. */
async function sendPaidFile(env, token, bcId, chatId, item, type, stars, payload, caption) {
  let url = null;
  try {
    const path = String(item.media_key || "").split("/").map(encodeURIComponent).join("/");
    const r = await fetch(env.SUPABASE_URL + "/storage/v1/object/sign/content-store/" + path, {
      method: "POST",
      headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: 3600 }),
    });
    const d = await r.json();
    if (d && d.signedURL) url = env.SUPABASE_URL + "/storage/v1" + d.signedURL;
  } catch (e) { /* fall through to R2 */ }
  if (url) return await tg.sendPaidMedia(token, bcId, chatId, [{ type, media: url }], stars, payload, caption);
  const obj = await env.MEDIA.get(item.media_key);
  if (!obj) throw new Error("media missing in storage and R2");
  const data = await obj.arrayBuffer();
  const ct = (obj.httpMetadata && obj.httpMetadata.contentType) || (type === "video" ? "video/mp4" : "image/jpeg");
  const filename = String(item.media_key).split("/").pop() || "item";
  return await tg.sendPaidMediaUpload(token, bcId, chatId, { type, filename, contentType: ct, data }, stars, payload, caption);
}

/* Post the item as paid media, in this chat, as the account. The customer taps once and Stars do the rest; nobody leaves the conversation for a bot. */
async function sendStarsItem(env, sb, conn, conv, chatId, item) {
  const token = await botTokenFor(env, sb, conn);
  if (!token || !chatId) return null;
  const stars = starsFor(item, env);
  if (!stars) return null;
  const meta = (item && item.metadata) || {};
  const kind = String(item.media_type || item.kind || "image").toLowerCase();
  const type = /video/.test(kind) ? "video" : "photo";
  const caption = pickOf(PAID_CAPTIONS);
  const payload = ("v1|" + conv.id + "|" + item.id).slice(0, 128);
  // Already on screen from the last half hour? Then it is already his to tap.
  const prior = await sb(env, "messages?conversation_id=eq." + conv.id +
    "&direction=eq.out&raw->>via=eq.stars-paid-media&select=raw,sent_at&order=sent_at.desc&limit=5").catch(() => null);
  const onScreen = (prior || []).some(m => m.raw && m.raw.item_id === item.id &&
    Date.now() - new Date(m.sent_at).getTime() < 30 * 60 * 1000);
  if (onScreen) return { stars_media: item.id, stars, reused: true };
  let sent = null;
  try {
    if (meta.tg_file_id) {
      sent = await tg.sendPaidMedia(token, conn.id, chatId, [{ type, media: meta.tg_file_id }], stars, payload, caption);
    } else {
      sent = await sendPaidFile(env, token, conn.id, chatId, item, type, stars, payload, caption);
      const fileId = tg.paidMediaFileId(sent);
      if (fileId) {
        await sb(env, "media_items?id=eq." + encodeURIComponent(item.id), {
          method: "PATCH", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ metadata: { ...meta, tg_file_id: fileId } }),
        }).catch(() => null);
      }
    }
  } catch (e) {
    console.log(JSON.stringify({ evt: "tg.stars.send_failed", item: item.id, err: String(e && e.message || e).slice(0, 200) }));
    return null;
  }

  // This row is what every "already on screen" guard reads. It needs kind
  // 'paid_media' in messages_kind_check (0018); without it the insert failed
  // silently and the same lock could be re-posted.
  const wallText = caption + " · " + stars + " ⭐";
  const sealedWall = await sealedBody(env, sb, conn.creator_id, wallText);
  await sb(env, "messages", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({
      conversation_id: conv.id,
      creator_id: conn.creator_id,
      tg_message_id: sent && sent.message_id ? sent.message_id : null,
      direction: "out",
      sender: "ai",
      kind: "paid_media",
      body_preview: "[stars] " + wallText,
      ...sealedWall,
      sent_at: new Date().toISOString(),
      raw: { via: "stars-paid-media", item_id: item.id, item_source: item.source || "media", stars },
    }),
  }).catch(e => console.log(JSON.stringify({ evt: "tg.stars.record_failed", what: "stars-paid-media",
    item: item.id, err: String(e && e.message || e).slice(0, 200) })));
  {
    const at = new Date().toISOString();
    const mediaKind = /video/.test(kind) ? "video" : "image";
    await remember(env, sb, conv, {
      last_media: { item_id: item.id, source: item.source || "media", kind: mediaKind, stars, free: false, via: "stars-paid-media", at },
      open_quote: { item_id: item.id, source: item.source || "media", stars, at, status: "open" },
    });
  }
  await sb(env, "conversations?id=eq." + conv.id, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ purchase_intent_at: new Date().toISOString() }),
  }).catch(() => {});
  console.log(JSON.stringify({ evt: "tg.stars.media_sent", item: item.id, stars,
    message_id: (sent && sent.message_id) || null }));
  return { stars_media: item.id, stars, tg_message_id: (sent && sent.message_id) || null };
}

/* Seal a deterministic line so the inbox can show it in full. */
async function sealedBody(env, sb, creatorId, text) {
  try { const dek = await getDek(env, sb, creatorId); const x = await seal(dek, text); return { body_enc: x.body_enc, body_nonce: x.body_nonce }; } catch (e) { return {}; }
}


/* Soft, in-character deflections. A man offering WhatsApp or a meet gets one
   warm line that keeps her where she is, not a lecture and not a hard stop
   repeated every message. */
const PLATFORM_RE = /\b(whats\s?app|whatsap|snap(chat)?|snap me|kik|instagram|insta|signal|onlyfans|of page)\b|\+44\s?\d{9,}|\b0?7\d{9}\b/i;
const DEFLECT_PLATFORM = [
  "i'd rather keep it all on here tbh x 😘",
  "i'm rubbish with other apps babe, telegram's where i am x",
  "just keep me on here x i like it better 😏",
  "i don't really do other apps, this is where you get me x",
  "haha you'll have to keep me on telegram, i'm comfy here 💋",
  "no other apps babe, but i'm not going anywhere on here x",
];
const DEFLECT_MEET = [
  "you've not even spoiled me yet 😏 do that and see how nice i am x",
  "havent even spoiled me yet babe 😇 i like being treated",
  "spoil me first x i'm not going anywhere 😏",
  "you're keen 😅 spoil me a little and i'll be even sweeter on you x",
  "slow down x i like to get to know someone properly first 😘",
  "let's keep chatting a bit first, i'm not in a rush x",
];

async function maybeDeflect(env, sb, conn, conv, msg, text) {
  const isPlatform = PLATFORM_RE.test(text);
  const isMeet = !isPlatform && MEET_RE.test(text);
  if (!isPlatform && !isMeet) return null;
  const via = isPlatform ? "deflect-platform" : "deflect-meet";
  const recent = await sb(env, "messages?conversation_id=eq." + conv.id +
    "&direction=eq.out&raw->>via=eq." + via + "&select=sent_at&order=sent_at.desc&limit=1").catch(() => null);
  if (recent && recent[0] && Date.now() - new Date(recent[0].sent_at).getTime() < 30 * 60 * 1000) return null;
  if (isMeet) {
    await remember(env, sb, conv, { custom_ask: { text: String(text).slice(0, 200), at: new Date().toISOString(), kind: "meet" } });
    if (VIDEO_WITH_ME_RE.test(text)) {
      const who = (msg.from && (msg.from.first_name || msg.from.username)) || "someone";
      await notifyOwner(env, sb, conn, conv, msg, "Needs you",
        who + " wants to be in a video with you: " + String(text).slice(0, 140)).catch(() => null);
    }
  }
  const pool = isPlatform ? DEFLECT_PLATFORM : DEFLECT_MEET;
  // Never the same line twice in a chat: read the ones already used, walk
  // through the rest, and only repeat once the whole pool is spent.
  const usedRows = await sb(env, "messages?conversation_id=eq." + conv.id +
    "&direction=eq.out&raw->>via=eq." + via + "&select=raw&order=sent_at.desc&limit=8").catch(() => null);
  const used = new Set((usedRows || []).map(r => r.raw && Number.isInteger(r.raw.i) ? r.raw.i : -1));
  const free = pool.map((_, i) => i).filter(i => !used.has(i));
  const pick = free.length ? free[Math.floor(Math.random() * free.length)]
                           : Math.floor(Math.random() * pool.length);
  let line = pool[pick];
  const menus = await sb(env, "messages?conversation_id=eq." + conv.id +
    "&direction=eq.out&raw->>via=eq.menu-text&select=id&limit=1").catch(() => null);
  if (!menus || !menus.length) line += " want the list? x";
  const token = await botTokenFor(env, sb, conn);
  if (!token) return null;
  await humanPace(token, conn.id, msg.chat.id, line);
  const sent = await tg.sendMessage(token, conn.id, msg.chat.id, line);
  const sealed = await sealedBody(env, sb, conn.creator_id, line);
  await sb(env, "messages", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({
      conversation_id: conv.id, creator_id: conn.creator_id,
      tg_message_id: sent && sent.message_id ? sent.message_id : null,
      direction: "out", sender: "ai", kind: "text",
      body_preview: "[" + via + "] " + line.slice(0, 60),
      sent_at: new Date().toISOString(), ...sealed,
      raw: { via, i: pick },
    }),
  }).catch(() => {});
  console.log(JSON.stringify({ evt: "tg.deflect", kind: via, conversation: conv.id }));
  return { conversation_id: conv.id, direction: "in", intercept: via,
           sent: { via, text: line } };
}

/* The item's Fangate checkout, sent as her in the chat. */
async function sendFangateLink(env, sb, conn, conv, chatId, item) {
  const token = await botTokenFor(env, sb, conn);
  const url = item && item.metadata && item.metadata.fangate_url;
  if (!token || !chatId || !url) return null;
  const line = `here you go babe 💕 ${url}`;
  const sealedLink = await sealedBody(env, sb, conn.creator_id, line);
  await humanPace(token, conn.id, chatId, line);
  const sent = await tg.sendMessage(token, conn.id, chatId, line);
  await sb(env, "messages", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({
      conversation_id: conv.id, creator_id: conn.creator_id,
      tg_message_id: sent && sent.message_id ? sent.message_id : null,
      direction: "out", sender: "ai", kind: "text",
      body_preview: "[fangate] " + (item.title || item.name || ""),
      ...sealedLink,
      sent_at: new Date().toISOString(),
      raw: { via: "fangate-link", item_id: item.id },
    }),
  }).catch(() => {});
  return { fangate_link: item.id };
}

/* Payment request for a specific item (shared by buy button and text). */
async function sendPaymentRequest(env, sb, conn, conv, msg, item) {
  const token = await botTokenFor(env, sb, conn);
  if (!token) return null;
  let wallet = null;
  const prof = await sb(env, "ai_profiles?creator_id=eq." +
    encodeURIComponent(conn.creator_id) + "&select=wallet_address").catch(() => null);
  if (prof && prof[0] && prof[0].wallet_address) wallet = prof[0].wallet_address;
  // The customer only ever sees Stars. GBP is the owner's accounting, shown in
  // the console preview and the owner alert, always as £9.50.
  const gbp = Number(item.price_gbp) || 0;
  const price = gbpText(gbp);
  const name = item.name || item.title || "that";
  const starPrice = starsEligible(item) ? starsFor(item, env) : 0;
  const fangate = (item.metadata && item.metadata.fangate_url) || "";
  // If the gated picture for this item is already sitting in the chat, do not
  // post it again: that is what made her look like a vending machine.
  const wallHist = await sb(env, "messages?conversation_id=eq." + conv.id +
    "&direction=eq.out&raw->>via=eq.stars-paid-media&select=raw,sent_at&order=sent_at.desc&limit=5").catch(() => null);
  const wallRecent = (wallHist || []).some(m => m.raw && m.raw.item_id === item.id &&
    Date.now() - new Date(m.sent_at).getTime() < 30 * 60 * 1000);
  if (wallRecent) return null;
  // Wall first. A digital item is posted locked, for Stars, the moment he picks
  // it; bank transfer is the fallback he is told about in the line underneath.
  if (starPrice) {
    const wall = await sendStarsItem(env, sb, conn, conv, msg.chat.id, item);
    // A line pointing at a lock nobody can see is worse than no line at all.
    const wallOk = !!(wall && (wall.reused === true || wall.tg_message_id));
    if (wall && !wallOk) {
      console.log(JSON.stringify({ evt: "tg.stars.wall_no_message", item: item.id }));
      return null;
    }
    if (wallOk) {
      const line = `${starPrice} ⭐ unlocks it babe, tap the lock 😏` + (fangate ? `\nor card here if you'd rather 💕 ${fangate}` : ` x`);
      const sealedLine = await sealedBody(env, sb, conn.creator_id, line);
      try {
        await humanPace(token, conn.id, msg.chat.id, line);
        const sent = await tg.sendMessage(token, conn.id, msg.chat.id, line);
        await sb(env, "messages", {
          method: "POST",
          headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
          body: JSON.stringify({
            conversation_id: conv.id,
            creator_id: conn.creator_id,
            tg_message_id: sent && sent.message_id ? sent.message_id : null,
            direction: "out",
            sender: "ai",
            kind: "text",
            body_preview: "[payment request] " + name + " · " + price + " / " + starPrice + " stars",
            ...sealedLine,
            sent_at: new Date().toISOString(),
            raw: { via: "menu-buy", item_id: item.id, item_source: item.source || "media", price_gbp: gbp, stars: starPrice },
          }),
        }).catch(() => {});
      } catch (e) {
        console.log(JSON.stringify({ evt: "tg.stars.line_failed", err: String(e && e.message || e).slice(0, 160) }));
      }
      return { buy_pressed: item.id, stars_wall: starPrice };
    }
  }
  const payText = fangate
    ? `ooh good choice 😏 ${name} is ${starPrice} ⭐ babe, here's the link 💕 ${fangate}`
    : `ooh good choice 😏 ${name} is stars only at the moment babe, tap the lock on the one you want x`;
  const sealedPay = await sealedBody(env, sb, conn.creator_id, payText);
  // No inline keyboard. Buttons make the account look like a shop bot; the
  // methods are named in the text and he answers with the one he wants.
  try {
    await humanPace(token, conn.id, msg.chat.id, payText);
    const sent = await tg.sendMessage(token, conn.id, msg.chat.id, payText);
    await sb(env, "messages", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify({
        conversation_id: conv.id,
        creator_id: conn.creator_id,
        tg_message_id: sent && sent.message_id ? sent.message_id : null,
        direction: "out",
        sender: "ai",
        kind: "text",
        body_preview: "[payment request] " + name + " · " + price,
        ...sealedPay,
        sent_at: new Date().toISOString(),
        raw: { via: "menu-buy", item_id: item.id, item_source: item.source || "media", price_gbp: gbp },
      }),
    }).catch(() => {});
    await remember(env, sb, conv, { open_quote: { item_id: item.id, source: item.source || "media",
      stars: starPrice || 0, at: new Date().toISOString(), status: "open" } });
    console.log(JSON.stringify({ evt: "tg.pay_request.sent", item: item.id, price }));
    return { buy_pressed: item.id };
  } catch (e) {
    console.log(JSON.stringify({ evt: "tg.pay_request.failed", err: String(e).slice(0, 200) }));
    return null;
  }
}

/* Payment details as plain text, in her voice. Used when he answers "paypal",
   "bank" or "ton" to the payment request, and by the old button taps. */
const PAY_CLOSERS = [
  "let me know once you've sent it babe 😈",
  "give me a shout when it's done 😘",
  "tell me when you've paid and it's all yours 🤩",
  "can't wait 💕 just say when you've sent it",
  "drop me a message once it's in 💋",
  "I'll be waiting 😏 just tell me when it's done",
  "once it lands it's straight over to you 💝 say the word",
];

/* Both ways, with both prices, so he can pick. Bank details only go out once
   he has chosen bank, or when Stars is not available for that item. */
async function sendPayChoice(env, sb, conn, conv, chatId, item){
  const token = await botTokenFor(env, sb, conn);
  if (!token || !chatId || !item) return null;
  const gbp = Number(item.price_gbp || 0);
  const starPrice = starsEligible(item) ? starsFor(item, env) : 0;
  if (!starPrice) return await sendPayDetails(env, sb, conn, conv, chatId, item, "bank");
  const name = item.name || item.title || "that";
  const line = `${name} is ${starPrice} ⭐ here in the chat. tap the lock and it's yours x`;
  const sealedChoice = await sealedBody(env, sb, conn.creator_id, line);
  try {
    await humanPace(token, conn.id, chatId, line);
    const sent = await tg.sendMessage(token, conn.id, chatId, line);
    await sb(env, "messages", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify({
        conversation_id: conv.id, creator_id: conn.creator_id,
        tg_message_id: sent && sent.message_id ? sent.message_id : null,
        direction: "out", sender: "ai", kind: "text",
        body_preview: "[pay choice] " + name + " · " + gbpText(gbp) + " / " + starPrice + " stars",
        ...sealedChoice,
        sent_at: new Date().toISOString(),
        raw: { via: "pay-choice", item_id: item.id, price_gbp: gbp, stars: starPrice },
      }),
    }).catch(() => {});
    return { pay_choice: item.id };
  } catch (e) {
    console.log(JSON.stringify({ evt: "tg.pay_choice.failed", err: String(e).slice(0, 160) }));
    return null;
  }
}

/* A picture with "for you" on every send reads like a bot. Rotate the line. */
const FREE_CAPTIONS = [
  "here's a little something 💜",
  "thought you'd like this x",
  "me, earlier 😏",
  "just for you, keep it between us x",
  "a taste 😈",
  "this is me being good 💋",
  "don't go sharing this x",
  "one from this morning x",
];
const PAID_CAPTIONS = [
  "unlock me 😏",
  "this one's worth it x",
  "you know you want to 😈",
  "go on then 😏",
  "worth every star x",
];
function pickOf(list){ return list[Math.floor(Math.random() * list.length)]; }

async function sendPayDetails(env, sb, conn, conv, chatId, item, method) {
  const token = await botTokenFor(env, sb, conn);
  if (!token || !chatId) return null;
  // Once an item has a Fangate checkout, that IS its payment method: asking for
  // "bank" gets the link, never the bank details. Remove the link and bank works
  // again, so the two rail changes need no code.
  if (item && item.metadata && item.metadata.fangate_url) {
    return await sendFangateLink(env, sb, conn, conv, chatId, item);
  }
  // Bank, PayPal and TON are off until the owner confirms the account. Nothing
  // here reads the payment fields, so no wrong numbers can go out.
  const detail = "it's stars only at the moment babe, tap the lock on the one you want x";
  const sealedDetail = await sealedBody(env, sb, conn.creator_id, detail);
  try {
    await humanPace(token, conn.id, chatId, detail);
    const sent = await tg.sendMessage(token, conn.id, chatId, detail);
    await sb(env, "messages", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify({
        conversation_id: conv.id,
        creator_id: conn.creator_id,
        tg_message_id: sent && sent.message_id ? sent.message_id : null,
        direction: "out",
        sender: "ai",
        kind: "text",
        body_preview: "[pay details] " + method + (item ? " · " + (item.name || item.title || "") : ""),
        ...sealedDetail,
        sent_at: new Date().toISOString(),
        raw: { via: "pay-details", method, item_id: item ? item.id : null },
      }),
    }).catch(() => {});
    console.log(JSON.stringify({ evt: "tg.pay_details.sent", method, item: item ? item.id : null }));
    return { pay_details: method };
  } catch (e) {
    console.log(JSON.stringify({ evt: "tg.pay_details.failed", err: String(e).slice(0, 200) }));
    return null;
  }
}

/* A meet or an address. Money offered for one is not a payment for an item. */
const MEET_RE = /\b(meet|meeting|meet ?up|come (round|over)|your address|where do you live|postcode|hotel|visit you|see you in person|be in (the|a|your) (video|vid|clip)|film (me|us|together)|make a (video|vid) (with|of) (me|us)|star in)\b/i;
// He wants to be IN the content: a meet in disguise, and the owner's call.
const VIDEO_WITH_ME_RE = /\b(be in (the|a|your) (video|vid|clip)|film (me|us|together)|make a (video|vid) (with|of) (me|us)|star in)\b/i;

/* A small model once invented "M Thompson, sort code 04-00-75" and sent it to a
   customer. No model-written message may carry bank details: the deterministic
   path is the only one allowed to send the real ones. */
function scrubBankText(text){
  if (!text) return text;
  if (/\b(sort code|account (number|no\.?|num)|acc(?:ount)?\s*#?\s*\d{6,})\b/i.test(text)) {
    console.log(JSON.stringify({ evt: "tg.reply.bank_details_blocked", text: String(text).slice(0, 100) }));
    return "let me send you the proper details x";
  }
  // Stars only. A pound figure in a reply is wrong even if it is accurate.
  if (/£\s?\d/.test(text)) {
    console.log(JSON.stringify({ evt: "tg.reply.pounds_blocked", text: String(text).slice(0, 100) }));
    return "it's stars only babe x";
  }
  return text;
}

/* A payment claim we should act on. A question is not a claim, a promise is
   not a claim, a negation is not a claim, sending a photo is not money, and
   money offered to meet is not a payment. */
function isPaymentClaim(text) {
  const raw = String(text || "").trim();
  if (MEET_RE.test(raw)) return false;
  const lower = raw.toLowerCase();
  const paidWord = /\b(paid|payed|sent|transferred|transfer|payment)\b/i.test(raw);
  const notMoney = /\b(pic|pics|photo|photos|video|clip|message|msg|text|email)\b/i.test(raw);
  const negated = /\b(not|never|no|haven'?t|hasn'?t|hadn'?t|didn'?t|don'?t|doesn'?t|won'?t|can'?t|couldn'?t|isn'?t|aren'?t|wasn'?t|weren'?t)\b[^.!?]{0,24}\b(paid|payed|sent|send|transferred|transfer)\b/.test(lower)
    || /\b(not yet|nothing yet|haven'?t yet)\b/.test(lower);
  const future = /\b(will|gonna|going to|want to|wanna|can i|could i|should i|how do i|how can i|where do i)\b[^.!?]{0,18}\b(pay|send|transfer)\b/.test(lower);
  const question = /^(what|which|who|why|how|did|have|has|do|does)\b/.test(lower);
  return paidWord && !notMoney && !negated && !future && !question &&
    raw.split(/\s+/).filter(Boolean).length <= 10;
}

async function onDirectMessage(env, sb, msg, persona) {
  const uname = String(persona || "").toLowerCase();
  const acc = await sb(env, "telegram_accounts?username=ilike." + encodeURIComponent(uname) +
    "&select=id,creator_id,connected").catch(() => null);
  const account = acc && acc[0];
  if (!account || !account.creator_id) return { skipped: "direct message to unknown account" };
  if (msg.chat && msg.chat.type !== "private") return { skipped: "non-private chat" };
  const from = msg.from || {};
  if (from.is_bot) return { skipped: "from a bot" };

  // Find the active business connection for this account; it carries
  // user_chat_id (the owner's chat with the bot) used as the customer id.
  const rows = await sb(env, "business_connections?telegram_account_id=eq." +
    encodeURIComponent(account.id) + "&is_enabled=eq.true&creator_id=not.is.null" +
    "&select=id,creator_id,telegram_account_id,tg_user_id,user_chat_id,is_enabled,rights");
  const conn = rows && rows[0];
  if (!conn) return { skipped: "no active business connection" };

  // Reuse the full business_message path: same customer/conversation/message
  // bookkeeping, same persona auto-reply.
  return await onMessage(env, sb, { ...msg, business_connection_id: conn.id }, false);
}

// ---------------------------------------------------------------------------

/* A customer paid for Stars paid-media. The payload carries the conversation
   and item because the update itself carries no chat id. The media is already
   unlocked by Telegram; this records the sale, thanks him and tells the owner. */
export async function onPaidMediaPurchase(env, sb, ppm, updateId) {
  const payload = String((ppm && ppm.paid_media_payload) || "");
  const m = payload.match(/^v1\|([0-9a-f-]{36})\|([0-9a-f-]{36})$/i);
  if (!m) {
    console.log(JSON.stringify({ evt: "tg.stars.purchase_unknown_payload", payload: payload.slice(0, 60) }));
    return { skipped: "unknown payload" };
  }
  const convId = m[1], itemId = m[2];
  const convs = await sb(env, "conversations?id=eq." + encodeURIComponent(convId) + "&select=*").catch(() => null);
  let conv = convs && convs[0];
  if (!conv) return { skipped: "conversation not found" };
  // A lock posted before a reconnect points at a conversation that has since
  // been merged into the current one. Follow it, at most a few hops.
  for (let hop = 0; hop < 3 && conv && conv.merged_into; hop++) {
    const next = await sb(env, "conversations?id=eq." + encodeURIComponent(conv.merged_into) + "&select=*").catch(() => null);
    if (!(next && next[0])) break;
    conv = next[0];
  }
  const conns = await sb(env, "business_connections?id=eq." + encodeURIComponent(conv.business_connection_id) +
    "&select=id,creator_id,telegram_account_id,tg_user_id,user_chat_id,is_enabled,rights").catch(() => null);
  const conn = conns && conns[0];
  if (!conn) return { skipped: "connection not found" };

  const item = await itemById(env, sb, itemId);
  // The stars he actually paid are the ones on the lock, i.e. the last wall
  // posted for this item; the item's current price is only the fallback.
  let stars = starsFor(item, env);
  try {
    const walls = await sb(env, "messages?conversation_id=eq." + conv.id +
      "&direction=eq.out&raw->>via=eq.stars-paid-media&select=raw&order=sent_at.desc&limit=10");
    const w = (walls || []).find(r => r.raw && r.raw.item_id === itemId && Number(r.raw.stars) > 0);
    if (w) stars = Number(w.raw.stars);
  } catch (e) { /* keep the item's price */ }
  const gbp = Number(item && item.price_gbp) || 0;
  const rate = Number(env.STAR_GBP_RATE) > 0 ? Number(env.STAR_GBP_RATE) : STAR_GBP_DEFAULT;
  const netPence = Math.round(stars * rate * 100);
  const buyer = (ppm && ppm.from) || {};
  // update_id is unique per purchase. stars:<buyer>:<stars> collided when one
  // man bought two things at the same price, and processor_ref is UNIQUE.
  const ref = updateId != null ? "stars:" + updateId
    : "stars:" + (buyer.id || "?") + ":" + conv.id + ":" + itemId + ":" + Date.now();

  await sb(env, "payments", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      creator_id: conn.creator_id,
      conversation_id: conv.id,
      processor_ref: ref,
      amount_pence: netPence,           // actual net to the bot at STAR_GBP_RATE, not the list price
      fee_pence: 0,
      status: "paid",
    }),
  }).catch((e) => console.log(JSON.stringify({ evt: "tg.stars.record_failed", what: "payments", ref,
    err: String(e && e.message || e).slice(0, 200) })));

  const paidText = (item ? (item.name || item.title || "") : itemId) + " · " + stars + " ⭐";
  const sealedPaid = await sealedBody(env, sb, conn.creator_id, paidText);
  await sb(env, "messages", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({
      conversation_id: conv.id,
      creator_id: conn.creator_id,
      direction: "in",
      sender: "customer",
      kind: "payment",
      body_preview: "[stars paid] " + paidText,
      ...sealedPaid,
      sent_at: new Date().toISOString(),
      raw: { via: "stars-purchase", item_id: itemId, stars, buyer: buyer.id || null, processor_ref: ref, net_pence: netPence },
    }),
  }).catch((e) => console.log(JSON.stringify({ evt: "tg.stars.record_failed", what: "payment-message",
    err: String(e && e.message || e).slice(0, 200) })));

  await remember(env, sb, conv, mem => {
    const at = new Date().toISOString();
    const oq = mem.open_quote && mem.open_quote.item_id === itemId ? { ...mem.open_quote, status: "paid", at } : mem.open_quote;
    return { bought: (Array.isArray(mem.bought) ? mem.bought : []).concat([itemId]).slice(-50), open_quote: oq || null };
  });

  const token = await botTokenFor(env, sb, conn);
  if (token && conv.chat_id) {
    const line = STARS_THANKS[Math.floor(Math.random() * STARS_THANKS.length)];
    try { await tg.sendMessage(token, conn.id, conv.chat_id, line); }
    catch (e) { console.log(JSON.stringify({ evt: "tg.stars.thanks_failed", err: String(e && e.message || e).slice(0, 120) })); }
  }
  await notifyOwner(env, sb, conn, conv, null, "Stars sale",
    (item ? (item.name || item.title || "") : itemId) + " · " + stars + " ⭐"
    + (gbp ? " (listed " + gbpText(gbp) + ", about " + gbpText(netPence / 100) + " net)" : "")).catch(() => null);
  console.log(JSON.stringify({ evt: "tg.stars.paid", item: itemId, stars, conv: conv.id }));
  return { stars_paid: stars, item: itemId };
}

export async function handleWebhook(request, env, sb, persona) {
  // 1. Authenticate Telegram before reading the body.
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    console.log(JSON.stringify({ evt: "tg.webhook.bad_secret", persona }));
    return new Response("", { status: 401 });
  }

  let update;
  try { update = await request.json(); }
  catch { return ok(); }                       // malformed: never ask for a retry
  if (!update || typeof update.update_id !== "number") return ok();

  const kind = updateKind(update);
  const bcId = bcIdOf(update);

  // Log BEFORE the first subrequest. If the subrequest budget is later
  // exhausted this line is the only evidence the update ever arrived.
  console.log(JSON.stringify({ evt: "tg.webhook.in", persona, kind,
                               update_id: update.update_id, bc: bcId }));

  let fresh;
  try {
    fresh = await claimUpdate(sb, env, update, kind, bcId);
  } catch (e) {
    console.log(JSON.stringify({ evt: "tg.webhook.claim_failed", update_id: update.update_id,
                                 err: String(e).slice(0, 200) }));
    return ok();                               // 200: a retry would fail the same way
  }
  if (!fresh) {
    console.log(JSON.stringify({ evt: "tg.webhook.replay", update_id: update.update_id }));
    return ok();
  }

  // Which of our accounts owns this bot? Needed when the update is about a
  // human connecting the bot to their own Telegram.
  let botAccount = null;
  try {
    const bots = await sb(env, "bots?persona=eq." + encodeURIComponent(persona) + "&select=username");
    const botUser = bots && bots[0] && bots[0].username;
    if (botUser) {
      const acc = await sb(env, "telegram_accounts?username=eq." + encodeURIComponent(botUser) + "&select=*");
      if (acc && acc[0]) botAccount = acc[0];
    }
  } catch (e) { console.log(JSON.stringify({ evt: "tg.webhook.bot_lookup_failed", err: String(e).slice(0, 120) })); }

  let result = null, error = null;
  try {
    if (kind === "business_connection")        result = await onConnection(env, sb, update.business_connection, botAccount);
    else if (kind === "business_message")      result = await onMessage(env, sb, update.business_message, false);
    else if (kind === "edited_business_message") result = await onMessage(env, sb, update.edited_business_message, true);
    else if (kind === "deleted_business_messages") result = await onDeleted(env, sb, update.deleted_business_messages);
    else if (kind === "message")              result = await onDirectMessage(env, sb, update.message, persona);
    else if (kind === "purchased_paid_media") result = await onPaidMediaPurchase(env, sb, update.purchased_paid_media, update.update_id);
    else if (kind === "callback_query")         result = await onCallback(env, sb, update.callback_query, persona);
    else result = { skipped: "unhandled kind: " + kind };
  } catch (e) {
    error = String(e && e.message ? e.message : e).slice(0, 400);
    console.log(JSON.stringify({ evt: "tg.webhook.error", kind, update_id: update.update_id, err: error }));
  }

  await finish(sb, env, update.update_id, error);
  console.log(JSON.stringify({ evt: "tg.webhook.done", kind, update_id: update.update_id, result }));

  // Always 200. A non-2xx makes Telegram retry the same update indefinitely,
  // and we have already recorded it.
  return ok();
}

// Exported for the reply-quality regression tests.
export { generateReply, repeatsSomething, personaSystemPrompt, ensureEmoji, sellableItems,
         nameFromText, nameForChat, nameFromUsername, usableName, NAME_QUESTION, stripNameQuestion,
         isPaymentClaim, scrubBankText,
         inboundSignals, routeInbound, menuOffered, openQuoteRow, reofferDue, withGapMarkers, memoryLine,
         PROMISE_OUT, CHASE_IN, MEET_RE, gbpText, starsFor, onMessage, onConnection, sendStarsItem };
