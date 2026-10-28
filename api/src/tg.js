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
function replyDelaySeconds(text, conv, opts) {
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
  const typing = Math.min(9000, 700 + replyWords * 320);
  if (o.ownerOnline) return Math.max(8, Math.round((typing + 2500 + Math.random() * 3500) / 1000));
  if (horny) return Math.max(8, Math.round((typing + 3000 + Math.random() * 4000) / 1000));
  return 12 + Math.floor(Math.random() * 39);                        // 12 to 50 seconds
}

/* The deterministic sends (menu, payment request, freebie) used to land the
   instant he typed, which reads as a machine. Show typing and hold for a beat
   the way the model path does. */
async function humanPace(token, connId, chatId, text) {
  if (!token || !chatId) return;
  const words = String(text || "").split(/\s+/).filter(Boolean).length;
  const hold = Math.min(7000, 1200 + words * 180 + Math.random() * 1500);
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
  const found = await sb(env, "telegram_accounts?tg_user_id=eq." + n.tg_user_id + "&select=id,creator_id");
  // The human granting access is not one of our bot accounts, so the link
  // belongs to the bot's own account. Without this the insert dies on
  // creator_id NOT NULL and the connection is never recorded at all.
  const ownerAccount = (found && found[0]) || null;
  const account = ownerAccount || botAccount || null;
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

  // creator_id stays NULL until a human claims this account in the dashboard.
  // Guessing here would attach a stranger's private DMs to the wrong creator,
  // which is the one onboarding mistake that cannot be walked back.
  await upsert(sb, env, "business_connections", "id", {
    id: n.id,
    creator_id: (account && account.creator_id) || null,
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
      action: n.is_enabled ? "business_connection.granted" : "business_connection.revoked",
      detail: {
        connection_id: n.id,
        tg_user_id: n.tg_user_id,
        username: u.username || null,
        rights: n.rights,
        // Rights we will never exercise, reported back so the owner can narrow them.
        over_granted: n.over_granted,
        // On API 10.3 an absent rights object means something is wrong.
        rights_missing: n.rights_missing,
        claimed: !!(account && account.creator_id),
      },
    }),
  }).catch(() => {});

  return { claimed: !!(account && account.creator_id) };
}

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

  // The composite key is load-bearing: chat_id alone COLLIDES across accounts
  // and that collision is a cross-account data leak.
  const convs = await upsert(sb, env, "conversations", "business_connection_id,chat_id", {
    business_connection_id: bcId,
    chat_id: msg.chat.id,
    creator_id: conn.creator_id,
    customer_id: customer ? customer.id : null,
    customer_ref: String(custTgId),
    last_message_at: new Date().toISOString(),
  });
  let conv = convs && convs[0];
  if (!conv) {
    const found = await sb(env, "conversations?business_connection_id=eq." +
      encodeURIComponent(bcId) + "&chat_id=eq." + msg.chat.id + "&select=*");
    conv = found && found[0];
  }
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
      if (seen && seen.length === 1) {
        await notifyOwner(env, sb, conn, conv, msg, "New chat", who + ": " + String(text).slice(0, 120));
      } else if (saysPaid) {
        // He says he has sent it. She says she is checking straight away, then
        // half a minute later the bank is read and she answers with the truth.
        try {
          const tk = await botTokenFor(env, sb, conn);
          if (tk) {
            await tg.sendMessage(tk, conn.id, msg.chat.id, "ok checking now x");
            await sb(env, "messages", {
              method: "POST",
              headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
              body: JSON.stringify({
                conversation_id: conv.id, creator_id: conn.creator_id,
                direction: "out", sender: "ai", kind: "text",
                body_preview: "ok checking now x",
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
      // He has been quoted and said no. The conversation goes dead: no reply,
      // no follow-up, and the bot stays off in this chat.
      intercept = "declined";
      patch.state = "dormant";
      patch.ai_disabled = true;
    } else if (DISMISS.test(text)) {
      // nothing to say, and nothing worth spending a model call on
      intercept = "dismissed";
      patch.state = "dormant";
    }
  }

  await sb(env, "conversations?id=eq." + conv.id, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch),
  });

  // Not every line needs an answer. A short ack, a laugh or a single emoji after
  // she has already replied is left alone about half the time, which is what a
  // person does and what stops the thread reading as a reply machine. Never
  // skipped when it is money talk.
  if (!outgoing && !intercept && text && !isPurchaseContext(text)) {
    const t = String(text).trim().toLowerCase();
    const ack = /^(ok|okay|kk|cool|nice|lol|lmao|haha+|hehe+|yeah|yea|yep|yes|no|cheers|thanks|ta|x+|😊|😂|🤣|👍)[\s.!?]*$/i.test(t);
    if (ack && Math.random() < 0.55) {
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
    "&active=eq.true&select=name,kind,price_gbp,description&order=position.asc&limit=20").catch(() => null);
  if (menu && menu.length){
    const lines = ["Your menu for sale (the ONLY things you can offer, use these exact names and prices):"];
    for (const m of menu){
      const kind = m.kind === "physical" ? "posted to him" : m.kind === "service" ? "done with you live" : (m.kind || "content");
      lines.push("- " + m.name + " (" + kind + ", £" + Number(m.price_gbp || 0) +
        (m.description ? " - " + String(m.description).slice(0, 60) : "") + ")");
    }
    lines.push("Digital things are sent the moment payment is confirmed. A physical thing is posted, so say it gets posted out and let the human take the address after payment. Never invent anything that is not on this list.");
    return lines.join("\n");
  }

  let rows = await sb(env, "media_items?telegram_account_id=eq." +
    encodeURIComponent(conn.telegram_account_id) +
    "&visible=eq.true&select=title,kind,price_ton,price_gbp,media_key&order=price_ton.desc&limit=15").catch(() => null);
  // Content uploaded before an account existed sits unassigned. It is still
  // hers, so it counts rather than the bot saying she has nothing to sell.
  if (!(rows && rows.length)){
    rows = await sb(env, "media_items?creator_id=eq." + encodeURIComponent(conn.creator_id) +
      "&telegram_account_id=is.null&visible=eq.true&select=title,kind,price_ton,price_gbp,media_key&order=price_ton.desc&limit=15").catch(() => null);
  }
  const items = (rows || []).filter(m => m.title && !String(m.media_key || "").startsWith("demo/"));
  if (!items.length) return "";
  const priceOf = m => Number(m.price_gbp || m.price_ton || 0);
  const paid = items.filter(m => priceOf(m) > 0);
  const free = items.filter(m => priceOf(m) <= 0);
  const lines = [];
  if (paid.length) {
    lines.push("Your current live content for sale. These are the ONLY things you can sell, with these exact names and prices:");
    for (const m of paid) lines.push("- " + m.title + " (" + (m.kind || "content") + ", £" + priceOf(m) + ")");
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
  const f = prof || {};
  const bits = [];
  if (f.pay_bank_name || f.pay_sort_code || f.pay_account_no) bits.push("bank transfer");
  if (!bits.length) return "";
  // The numbers are deliberately NOT in the prompt. The model leaked them to a
  // man who offered money to meet, so only the deterministic payment path sends
  // the real details, and only for an item.
  return "Payment methods you have: " + bits.join("; ") +
    ", plus Telegram Stars for photos and videos (never for anything posted, a meet or a service). " +
    "Everything is quoted in pounds. Never type, quote or invent bank details, a sort code, an account number, a PayPal address or a link: the system sends the real details when he is paying for an item. " +
    "Stars are never sent to you: he taps the unlock on the picture or video you posted in the chat. " +
    "If he asks for a meet, never send payment details. Never offer or mention PayPal, crypto or any other method, and if he asks for one say bank transfer or stars is all you do x.";
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
  const hasPaid = !!catalogue && /£\d/.test(catalogue);
  if (hasPaid) lines.push(
    "Build the connection first: answer him, flirt, take it dirtier than he does. As soon as he has replied a couple of times, or the moment he asks what you do or what you have got, prompt him to your menu: say you have got a menu of your stuff and ask if he wants to see it. Do not wait for him to ask twice.",
    "When he picks something, name it naturally and give the exact price from your list. Never invent an item, an add-on, a discount or a price.",
    "Never say free, freebie, or that he has already had one. If he asks for more pictures after the opener, do not mention what he has had; just point him at the menu.");
  lines.push(
    // Real payment details are the owner's to give. Never quote a placeholder
    // sort code or an address at a paying customer.
    wallet || `Prices are always in pounds, like £15, never dollars. You have no payment details set, so when he asks how to pay say \"give me a sec and I'll send you the details x\" and leave it for the human. Never invent a bank account, sort code, PayPal address or link.`,
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
  const messages = [
    { role: "system", content: system },
    ...history.map(h => ({ role: h.dir === "in" ? "user" : "assistant", content: h.text })),
    { role: "user", content: incoming },
  ];
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
        messages, max_tokens: 150, temperature: 0.85,
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
    "&select=id,creator_id,business_connection_id,chat_id,mode,ai_disabled").catch(() => null);
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

  const history = msgs.map(m => ({ dir: m.dir, text: m.text })).slice(-20);
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
  const system = personaSystemPrompt(p, conn, catalogue, payLine, priorOut) +
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

  // FREE CONTENT: "anything free?" -> send a live, price-0 item from this
  // account's library, once per conversation until they ask again later.
  // A picture or a voice note is answered from the description or transcript.
  // That text is synthetic, so it must never be read as a request for a freebie,
  // a menu or a purchase: the word "photo" inside a description once fired the
  // free item instead of answering the picture.
  const mediaSynthetic = /^he sent you (an image|a voice note)/.test(text || "");
  const lower = String(text || "").toLowerCase();
  // "send us a pic" is the most common opener there is. It gets the free one,
  // the same as asking for a freebie.
  const askingFree = !mediaSynthetic && /(free|4free|for free|anything for me|freebie|sample|preview|\bpic|\bphoto|\bpicture|show (me|us)|what do you look like|send (me )?(something|one)|any nudes|\bnudes\b|can i see you|let me see you|see you|show yourself|your body|your tits|your arse|your ass)/.test(lower);
  if (askingFree) {
    const sentFree = await maybeSendFreeItem(env, sb, conn, conv, msg);
    if (sentFree) { stopTyping(); return sentFree; }   // media sent; no text needed
  }

  // MENU: "what do you offer / send me the menu" -> list live items with
  // prices straight from her library, not the model's imagination.
  const askingMenu = !mediaSynthetic && /(menu|what.*(offer|have|sell|sellin|got)|price list|how much|options|what can i buy|show me what)/.test(lower);
  // He has just been told what she does and asked to see it. That is a yes to
  // the menu, so it goes out rather than another line about knickers.
  // Any sign of interest counts, not only a clean yes. The menu only goes out
  // once per chat, so an early prompt costs nothing.
  const wantsMenu = !mediaSynthetic && (
    /^(yes|yeah|yep|yeh|ye|yup|yh|ya|why not|sure|ok|okay|go on|go for it|please|pls|send it|send them|send us|show me|let'?s see|of course|course|definitely|absolutely|sounds good|alright|aye|deal|do it|i'?ll (have|take|get)|fine|cool)\b/i.test(lower) ||
    /(what else|what kind|what sort|like what|such as|tell me more|what do you mean|what'?s on (it|the menu)|how much|any good|what can i (get|have)|maybe|hmm+|interesting|oh yeah|really\?|go on then|and\?)/i.test(lower)
  );
  if (wantsMenu) {
    // He is saying yes to whatever she offered last. If that was the menu, the
    // list goes out now, whoever wrote the offer.
    const lastOut = await sb(env, "messages?conversation_id=eq." + conv.id +
      "&direction=eq.out&select=body_preview,sent_at&order=sent_at.desc&limit=2").catch(() => null);
    const offered = (lastOut || []).find(m => Date.now() - new Date(m.sent_at).getTime() < 30 * 60 * 1000 &&
      /menu|price|list|what i (have|do|sell)|my stuff/i.test(m.body_preview || ""));
    const recentLimit = await sb(env, "messages?conversation_id=eq." + conv.id +
      "&direction=eq.out&raw->>via=eq.free-limit&select=sent_at&order=sent_at.desc&limit=1").catch(() => null);
    const limitFresh = recentLimit && recentLimit[0] && Date.now() - new Date(recentLimit[0].sent_at).getTime() < 30 * 60 * 1000;
    // A bare yes from a man who has never seen the menu gets the menu. Once it
    // has gone out, another yes is just a yes and the model answers it.
    const menuSent = await sb(env, "messages?conversation_id=eq." + conv.id +
      "&direction=eq.out&raw->>via=eq.menu-text&select=id&limit=1").catch(() => null);
    const neverSent = Array.isArray(menuSent) && menuSent.length === 0;
    if (offered || limitFresh || neverSent) {
      const m = await maybeSendMenu(env, sb, conn, conv, msg);
      if (m) { stopTyping(); return m; }
    }
  }

  if (askingMenu && !askingFree) {
    const menu = await maybeSendMenu(env, sb, conn, conv, msg);
    if (menu) { stopTyping(); return menu; }
  }

  // He answers in words now, because there are no buttons to tap. Bank is the
  // only rail: a yes gets the bank details. If he names PayPal or crypto, the
  // model answers "bank only x" from the persona rather than us sending a bank
  // message he did not ask for.
  // "hmmm myeah" is a yes. Strip the filler before deciding, or a man who has
  // agreed in the way men actually type is left without the bank details.
  const bare = lower.replace(/^(h+m+|m+h+m+|m+y+e+a+h+|ah+|oh+|erm+|well|ha+|aye)\s+/i, "").trim();
  const affirmative = !mediaSynthetic && /^(yes|yeah|yep|yeh|ye|myeah|ok|okay|go on|please|pls|send it|send them|send us it|go for it|sure|course|of course|sound|perfect|aye|alright|i'?ll take|i'?ll have|i'?ll get|let'?s do it|do it|deal)\b/i.test(bare);
  const starsHit = !mediaSynthetic && /\bstars?\b|⭐/.test(lower) &&
    (/\b(pay|paying|payment|with|use|send|via|ok|yes|yeah|please|can|do)\b/.test(lower) ||
     bare.split(/\s+/).filter(Boolean).length <= 4);
  const methodHit = !mediaSynthetic
    ? (starsHit ? "stars" : (/\bbank\b|\btransfer\b/i.test(lower) ? "bank" : null))
    : null;
  // "I want to pay for them" is the clearest signal there is, and it must not
  // depend on a quote being recorded by a particular path. Money offered to
  // meet is not that signal.
  const meetAsk = !mediaSynthetic && MEET_RE.test(lower);
  const wantsToPay = !mediaSynthetic && !meetAsk && /\b(pay|paying|payment|send (you )?the (money|cash)|how do i pay|where do i send)\b/i.test(lower);
  const cardHit = !mediaSynthetic && /\b(card|link|fangate)\b/i.test(lower);
  if ((methodHit || cardHit || affirmative || wantsToPay) && !askingFree && !meetAsk) {
    const quoted = await lastQuotedItem(env, sb, conv);
    if (cardHit && quoted && quoted.metadata && quoted.metadata.fangate_url) {
      const sentLink = await sendFangateLink(env, sb, conn, conv, msg.chat.id, quoted);
      if (sentLink) { stopTyping(); return sentLink; }
    }
    // Stars first: a digital item is unlocked in this chat, not by bank details.
    if (methodHit === "stars") {
      let starItem = (quoted && starsEligible(quoted)) ? quoted
        : await matchLiveItem(env, sb, conn, text);
      if (!starItem || !starsEligible(starItem)) starItem = await cheapestStarsItem(env, sb, conn);
      if (starItem && starsEligible(starItem)) {
        const starsSent = await sendStarsItem(env, sb, conn, conv, msg.chat.id, starItem);
        if (starsSent) { stopTyping(); return starsSent; }
      }
    }
    if (quoted && !methodHit) {
      const choice = await sendPayChoice(env, sb, conn, conv, msg.chat.id, quoted);
      if (choice) { stopTyping(); return choice; }
    }
    if (quoted) {
      const bankMethod = methodHit === "stars" ? "bank" : (methodHit || "bank");
      const paid = await sendPayDetails(env, sb, conn, conv, msg.chat.id, quoted, bankMethod);
      if (paid) { stopTyping(); return paid; }
    }
  }

  // "how do I pay?" -> re-send the payment-method buttons for the last item
  // they were quoted, instead of letting the model invent details.
  const askingHowPay = !mediaSynthetic && !meetAsk && /how (do|can) i pay|how.*(pay|payment)|payment (method|options|details)?|ways? to pay|pay options/.test(lower);
  if (askingHowPay && !askingFree && !askingMenu) {
    const lastReq = await sb(env, "messages?conversation_id=eq." + conv.id +
      "&direction=eq.out&select=body_preview,raw&order=sent_at.desc&limit=10").catch(() => null);
    const req = (lastReq || []).find(m => m.raw && m.raw.via === "menu-buy" && m.raw.item_id);
    if (req) {
      const it = await itemById(env, sb, req.raw.item_id, req.raw.item_source);
      if (it) {
        const payReq = await sendPaymentRequest(env, sb, conn, conv, msg, it);
        if (payReq) { stopTyping(); return payReq; }
      }
    }
  }

  // BUY INTENT: they picked or named a specific item ("the video please",
  // "i'll take the half naked one", "yes pls" right after a menu). Match it
  // against her live titles and jump straight to the payment request.
  const shortNamed = !mediaSynthetic && !askingFree && !askingMenu &&
    bare.split(/\s+/).filter(Boolean).length <= 4 && await strongItemMatch(env, sb, conn, text);
  if (!mediaSynthetic && !askingFree && !askingMenu && (shortNamed || await looksLikeBuyIntent(text, lower))) {
    const picked = shortNamed || await matchLiveItem(env, sb, conn, text);
    if (picked) {
      const payReq = await sendPaymentRequest(env, sb, conn, conv, msg, picked);
      if (payReq) { stopTyping(); return payReq; }
    }
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
  const history = [];
  for (const m of (hist || []).reverse()) {
    let body = m.body_preview;
    if (histDek && m.body_enc && m.body_nonce) {
      try { body = await open(histDek, m.body_enc, m.body_nonce); } catch (e) { /* keep the preview */ }
    }
    if (!body || body === text) continue;
    const t = stripInternal(body);
    if (t) history.push({ dir: m.direction, text: t });
  }

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
          ". Answer the ones that matter (a question, anything sexual, anything about what you sell) and skip the filler. Do not answer each one separately, and do not let it go flat: take the dirtiest thread and push it further.";
      }
      // Selling before he has said anything is the thing that makes a chat feel
  // like a shop. In a new chat she flirts and nothing else.
  const hisCount = history.filter(h => h.dir === "in").length;
  const sellGate = hisCount < 2
    ? " He has only sent " + hisCount + " message" + (hisCount === 1 ? "" : "s") +
      " so far. Do not mention selling, prices or content at all in this reply, and do not drop hints about it. Chat and flirt, that is all."
    : "";
  const system = personaSystemPrompt(p, conn, catalogue, payLine, priorOut) + (custLine ? " " + custLine : "") + catchUp + sellGate;
      replyText = await generateReply(env, system, history, text);
      via = "workers-ai";
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
      if (!replyText) { stopTyping(); return null; }
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
  const delay = replyDelaySeconds(text, conv, { ownerOnline,
    priorText: history.slice(-3).map(h => h.text).join(" "),
    replyText,
    sentMedia: !!(msg.photo || msg.voice || msg.video || msg.video_note) });
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
      generated_at: new Date().toISOString(),
    }, { delaySeconds: delay });
    stopTyping();
    // After the reply is queued, not before: a custom ask is flagged in the
    // background so it never delays what the customer sees.
    await maybeFlagCustomAsk(env, sb, conn, conv, msg, text).catch(() => null);
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
    "&visible=eq.true&price_ton=eq.0&select=id,title,kind,media_key" +
    "&order=uploaded_at.desc&limit=5").catch(() => null);
  // A freebie uploaded before the account existed still counts.
  if (!(rows && rows.length)){
    rows = await sb(env, "media_items?creator_id=eq." + encodeURIComponent(conn.creator_id) +
      "&visible=eq.true&price_ton=eq.0&select=id,title,kind,media_key" +
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

  // One opener per chat. A second request gets no line about having had one;
  // the model steers him to the menu instead.
  const alreadyFree = await sb(env, "messages?conversation_id=eq." + conv.id +
    "&direction=eq.out&raw->>via=eq.free-item&select=id&limit=1").catch(() => null);
  if (alreadyFree && alreadyFree.length) return null;

  // First free request: the face picture, and only that one. He sees her, then
  // the next ask gets the paid list. Other free files stay in reserve.
  const opener = items.find(m => /\bface\b|selfie/i.test(m.title || "")) || items[0];
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
      }).catch(() => {});
      sentIds.push(it.id);
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
    "&visible=eq.true&select=id,title,kind,price_ton,price_gbp,price_stars,media_key,metadata&order=price_ton.desc&limit=20").catch(() => null);
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

  const priceOf = m => Number(m.price_gbp || m.price_ton || 0);
  const fmt = m => "£" + priceOf(m);
  const paid = items.filter(m => priceOf(m) > 0).slice(0, 45);
  if (!paid.length) return null;
  const freeRows = await sb(env, "media_items?telegram_account_id=eq." +
    encodeURIComponent(conn.telegram_account_id) +
    "&visible=eq.true&price_ton=eq.0&select=id,title,media_key&limit=5").catch(() => null);
  const free = (freeRows || []).filter(m => m.media_key);
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
    // No holding line and no buttons: the free set goes out first, all at once,
    // so he sees her before he sees a price, then the priced list lands as plain
    // text a few seconds later, like she typed it.
    const alreadyFree = await sb(env, "messages?conversation_id=eq." + conv.id +
      "&direction=eq.out&raw->>via=eq.free-item&select=id&limit=1").catch(() => null);
    if (!(alreadyFree && alreadyFree.length)) {
      await maybeSendFreeItem(env, sb, conn, conv, msg).catch(() => null);
    }
    const menuDelay = 10 + Math.floor(Math.random() * 9);   // 10 to 18 seconds
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
      generated_at: new Date().toISOString(),
    }, { delaySeconds: menuDelay });
    console.log(JSON.stringify({ evt: "tg.menu.sent", paid: paid.length, free: free.length, delay: menuDelay }));
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
    .filter(m => m.title && Number(m.price_gbp || m.price_ton || 0) > 0);
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
  return /\b(i'?ll take|i'?ll buy|i want to buy|buy it|buy that|i'?ll have|take it|pay for (it|that)|send (it|that) (to me|over)|send me (that|the|your|those|them)|give me (that|it|those|them)|i want (that|the|those)|let me see (that|the)|show me (that|the))\b/i.test(text);
}

/* Match their words against her live item titles. Exact-word overlap wins;
   fall back to kind words (video/pic) matching the item kind. */
async function matchLiveItem(env, sb, conn, text) {
  // Same list the model sells from. A media-only matcher could never find a
  // menu item, so "the three photo set please" produced no payment request.
  const items = (await sellableItems(env, sb, conn))
    .filter(m => m.title && Number(m.price_gbp || m.price_ton || 0) > 0);
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
      encodeURIComponent(item.telegram_account_id) + "&is_enabled=eq.true" +
      "&select=id,creator_id,telegram_account_id,tg_user_id,is_enabled,rights").catch(() => null);
    conn = c && c[0];
  }
  if (!conn) return { skipped: "no connection for callback" };

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
  const convs = await upsert(sb, env, "conversations", "business_connection_id,chat_id", {
    business_connection_id: conn.id,
    chat_id: chatId,
    creator_id: conn.creator_id,
    customer_id: cust ? cust.id : null,
    customer_ref: String(cq.from.id),
    last_message_at: new Date().toISOString(),
  });
  let conv = convs && convs[0];
  if (!conv) {
    const found = await sb(env, "conversations?business_connection_id=eq." +
      encodeURIComponent(conn.id) + "&chat_id=eq." + chatId + "&select=*");
    conv = found && found[0];
  }
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
  try { await tg.answerCallbackQuery(token, cq.id, item.title + " · £" + (Number(item.price_gbp) || Number(item.price_ton))); } catch (e) {
    console.log(JSON.stringify({ evt: "tg.callback.ack_failed", err: String(e).slice(0, 120) })); }
  const r = await sendPaymentRequest(env, sb, conn, conv, { chat: { id: chatId } }, item);
  await sb(env, "conversations?id=eq." + conv.id, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ purchase_intent_at: new Date().toISOString() }),
  }).catch(() => {});
  console.log(JSON.stringify({ evt: "tg.menu.buy_pressed", item: item.id, price: item.price_ton }));
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
  const gbp = Number(item.price_gbp) || Number(item.price_ton) || 0;
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
      body_preview: "[stars] " + caption + " · " + stars + " ⭐",
      sent_at: new Date().toISOString(),
      raw: { via: "stars-paid-media", item_id: item.id, item_source: item.source || "media", stars },
    }),
  }).catch(() => {});
  await sb(env, "conversations?id=eq." + conv.id, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ purchase_intent_at: new Date().toISOString() }),
  }).catch(() => {});
  console.log(JSON.stringify({ evt: "tg.stars.media_sent", item: item.id, stars }));
  return { stars_media: item.id, stars };
}

/* The item's Fangate checkout, sent as her in the chat. */
async function sendFangateLink(env, sb, conn, conv, chatId, item) {
  const token = await botTokenFor(env, sb, conn);
  const url = item && item.metadata && item.metadata.fangate_url;
  if (!token || !chatId || !url) return null;
  const line = `here you go babe 💕 ${url}`;
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
  // Prices are shown to the customer in GBP. They can pay by TON,
  // PayPal or bank transfer. Written in her voice, not like an invoice.
  const ton = Number(item.price_ton) || 0;
  const gbp = Number(item.price_gbp) || ton;   // GBP column wins when set
  const price = "£" + gbp;
  const name = item.name || item.title || "that";
  const starPrice = starsEligible(item) ? starsFor(item, env) : 0;
  const fangate = (item.metadata && item.metadata.fangate_url) || "";
  // Wall first. A digital item is posted locked, for Stars, the moment he picks
  // it; bank transfer is the fallback he is told about in the line underneath.
  if (starPrice) {
    const wall = await sendStarsItem(env, sb, conn, conv, msg.chat.id, item);
    if (wall) {
      const line = `${starPrice} ⭐ (${price}) unlocks it babe, tap the lock 😏` + (fangate ? `\nor card here if you'd rather 💕 ${fangate}` : ` or bank transfer if you'd rather x`);
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
    ? `ooh good choice 😏 ${name} is ${price} babe, here's the link 💕 ${fangate}`
    : `ooh good choice 😏 ${name} is ${price} babe, want me to send my bank details? x`;
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
        sent_at: new Date().toISOString(),
        raw: { via: "menu-buy", item_id: item.id, item_source: item.source || "media", price_gbp: gbp },
      }),
    }).catch(() => {});
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
  const gbp = Number(item.price_gbp || item.price_ton || 0);
  const starPrice = starsEligible(item) ? starsFor(item, env) : 0;
  if (!starPrice) return await sendPayDetails(env, sb, conn, conv, chatId, item, "bank");
  const name = item.name || item.title || "that";
  const line = `${name} is £${gbp} by bank transfer, or ${starPrice} ⭐ here in the chat. which one do you want baby? x`;
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
        body_preview: "[pay choice] " + name + " · £" + gbp + " / " + starPrice + " stars",
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
  const closer = PAY_CLOSERS[Math.floor(Math.random() * PAY_CLOSERS.length)];
  const prof = await sb(env, "ai_profiles?creator_id=eq." +
    encodeURIComponent(conn.creator_id) +
    "&select=wallet_address,pay_bank_name,pay_sort_code,pay_account_no,pay_paypal").catch(() => null);
  const pay = (prof && prof[0]) || {};
  let detail;
  if (method === "ton" && pay.wallet_address) {
    detail = `my ton address is\n${pay.wallet_address}\nput your username in the comment so I know it's you x\n${closer}`;
  } else if (method === "paypal" && pay.pay_paypal) {
    detail = `paypal me at ${pay.pay_paypal} x\n${closer}`;
  } else if (method === "bank" && (pay.pay_sort_code || pay.pay_account_no)) {
    detail = `it's my business account x, I keep it separate for my own tax reasons, I'm not a naughty girl when it comes to that 😜\nname ${pay.pay_bank_name || ""}\nsort code ${pay.pay_sort_code || ""}\naccount ${pay.pay_account_no || ""}\nput your name in the reference so I know it's you x\n${closer}`;
  } else {
    detail = "give me a sec and I'll send you the details x";
  }
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
const MEET_RE = /\b(meet|meeting|meet ?up|come (round|over)|your address|where do you live|postcode|hotel|visit you|see you in person)\b/i;

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
    encodeURIComponent(account.id) + "&is_enabled=eq.true" +
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
export async function onPaidMediaPurchase(env, sb, ppm) {
  const payload = String((ppm && ppm.paid_media_payload) || "");
  const m = payload.match(/^v1\|([0-9a-f-]{36})\|([0-9a-f-]{36})$/i);
  if (!m) {
    console.log(JSON.stringify({ evt: "tg.stars.purchase_unknown_payload", payload: payload.slice(0, 60) }));
    return { skipped: "unknown payload" };
  }
  const convId = m[1], itemId = m[2];
  const convs = await sb(env, "conversations?id=eq." + encodeURIComponent(convId) +
    "&select=id,creator_id,business_connection_id,chat_id,customer_ref").catch(() => null);
  const conv = convs && convs[0];
  if (!conv) return { skipped: "conversation not found" };
  const conns = await sb(env, "business_connections?id=eq." + encodeURIComponent(conv.business_connection_id) +
    "&select=id,creator_id,telegram_account_id,tg_user_id,user_chat_id,is_enabled,rights").catch(() => null);
  const conn = conns && conns[0];
  if (!conn) return { skipped: "connection not found" };

  const item = await itemById(env, sb, itemId);
  const stars = starsFor(item, env);
  const gbp = Number(item && item.price_gbp) || 0;
  const buyer = (ppm && ppm.from) || {};

  await sb(env, "payments", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      creator_id: conn.creator_id,
      conversation_id: conv.id,
      processor_ref: "stars:" + (buyer.id || "?") + ":" + stars,
      amount_pence: Math.round(gbp * 100) || null,
      fee_pence: null,
      status: "paid",
    }),
  }).catch((e) => console.log(JSON.stringify({ evt: "tg.stars.payment_write_failed", err: String(e).slice(0, 160) })));

  await sb(env, "messages", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({
      conversation_id: conv.id,
      creator_id: conn.creator_id,
      direction: "in",
      sender: "customer",
      kind: "payment",
      body_preview: "[stars paid] " + (item ? (item.name || item.title || "") : itemId) + " · " + stars + " ⭐",
      sent_at: new Date().toISOString(),
      raw: { via: "stars-purchase", item_id: itemId, stars, buyer: buyer.id || null },
    }),
  }).catch(() => {});

  const token = await botTokenFor(env, sb, conn);
  if (token && conv.chat_id) {
    const line = STARS_THANKS[Math.floor(Math.random() * STARS_THANKS.length)];
    try { await tg.sendMessage(token, conn.id, conv.chat_id, line); }
    catch (e) { console.log(JSON.stringify({ evt: "tg.stars.thanks_failed", err: String(e && e.message || e).slice(0, 120) })); }
  }
  await notifyOwner(env, sb, conn, conv, null, "Stars sale",
    (item ? (item.name || item.title || "") : itemId) + " · " + stars + " ⭐"
    + (gbp ? " (listed £" + gbp + ")" : "")).catch(() => null);
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
      const acc = await sb(env, "telegram_accounts?username=eq." + encodeURIComponent(botUser) + "&select=id,creator_id");
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
    else if (kind === "purchased_paid_media") result = await onPaidMediaPurchase(env, sb, update.purchased_paid_media);
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
         isPaymentClaim };
