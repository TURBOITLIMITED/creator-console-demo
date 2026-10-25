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
import { getDek, seal, preview } from "./crypto.js";
import { isAskingIfBot, isAskingForHuman, hasAgeSignal, COPY_VERSION } from "./copy.js";
const sleep = ms => new Promise(r => setTimeout(r, ms));

import { pickBotAnswer, isSeriousRequest, isPurchaseContext } from "./persona.js";
import { sign as signMedia } from "./media.js";

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
  const windowOpen = tg.withinWindow(priorInbound, Date.now());

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

  const patch = { last_message_at: new Date().toISOString() };
  // talking to her again wakes a thread she had left alone
  if (!outgoing) patch.state = "active";
  if (!outgoing) patch.last_inbound_at = new Date().toISOString();
  else patch.last_outbound_at = new Date().toISOString();

  /* "fuck off", "piss off", "not interested": he has dismissed her. She likes
     the message and moves on. No model call, no chase, and he is still free to
     come back another day. */
  const DISMISS = /\b(f+u+c+k+\s*off|piss\s*off|sod\s*off|get\s*lost|jog\s*on|do\s*one|not\s*interested|no\s*thanks?|no\s*ta|leave\s*it|bog\s*off|bore\s*off|fuck\s*you|go\s*away)\b/i;

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
    } else if (DISMISS.test(text)) {
      // nothing to say, and nothing worth spending a model call on
      intercept = "dismissed";
      patch.state = "dormant";
    }
  }

  await sb(env, "conversations?id=eq." + conv.id, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch),
  });

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
  let sent = null;
  if (!outgoing && (reply || !intercept) && windowOpen && conv.mode !== "human" && !conv.ai_disabled) {
    sent = await autoReply(env, sb, conn, conv, msg, text, reply);
  }

  return {
    conversation_id: conv.id, direction: outgoing ? "out" : "in", sender,
    window_open: windowOpen, intercept,
    reply: reply ? { text: reply.text, register: reply.variant } : null,
    sent: sent ? { via: sent.via, text: sent.text } : null,
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
    "&visible=eq.true&select=title,kind,price_ton,price_gbp&order=price_ton.desc&limit=15").catch(() => null);
  // Content uploaded before an account existed sits unassigned. It is still
  // hers, so it counts rather than the bot saying she has nothing to sell.
  if (!(rows && rows.length)){
    rows = await sb(env, "media_items?creator_id=eq." + encodeURIComponent(conn.creator_id) +
      "&telegram_account_id=is.null&visible=eq.true&select=title,kind,price_ton,price_gbp&order=price_ton.desc&limit=15").catch(() => null);
  }
  const items = (rows || []).filter(m => m.title);
  if (!items.length) return "";
  const lines = ["Your current live content for sale (the ONLY things you can offer, use these exact names and prices):"];
  for (const m of items) {
    // UK customers, pounds, never crypto and never dollars
    lines.push("- " + m.title + " (" + (m.kind || "content") + ", " +
      (Number(m.price_gbp || m.price_ton) > 0 ? "£" + Number(m.price_gbp || m.price_ton) : "FREE - only send it if they ask for something free") + ")");
  }
  lines.push("Never mention or invent any other content, and never write placeholders like [Insert Picture Link]. When they pick something, tell them the price and that you'll send it as soon as it's paid.");
  return lines.join("\n");
}

/* The owner's payment details, as the model is allowed to speak them. Only
   methods that are actually filled in are offered: a missing method is a
   method she does not have. */
function payLineFrom(prof) {
  const f = prof || {};
  const bits = [];
  if (f.pay_bank_name || f.pay_sort_code || f.pay_account_no) {
    const b = [];
    if (f.pay_bank_name) b.push("name " + f.pay_bank_name);
    if (f.pay_sort_code) b.push("sort code " + f.pay_sort_code);
    if (f.pay_account_no) b.push("account " + f.pay_account_no);
    bits.push("bank transfer (" + b.join(", ") + ")");
  }
  if (f.pay_paypal) bits.push("PayPal (" + f.pay_paypal + ")");
  if (f.wallet_address) bits.push("TON, only if he asks for crypto (" + f.wallet_address + ")");
  if (f.pay_note) bits.push(f.pay_note);
  if (!bits.length) return "";
  return "Payment methods you have, and the ONLY details you may give: " + bits.join("; ") +
    ". Everything is quoted in pounds. Offer bank transfer first unless he asks for something else. " +
    "Never invent or alter a detail, never mention crypto unless he does, and never promise a link.";
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
    `You are ${name}, replying to fans in her Telegram DMs. You are chatting to sell her photos and videos.`,
    `Voice: ${tone}. Emoji: ${emoji}.`,
  ];
  if (p && p.system_prompt) lines.push(String(p.system_prompt));
  if (catalogue) lines.push(catalogue);
  lines.push(
    "Warm him up first: three or four messages of proper chat before you mention selling at all, and nothing about money, prices or content in the first three. Then tell him plainly what you do, once (\"I sell my content, some lads love it, some don't\"), and only after that name one item and its price. Never pitch in the first message.",
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
    "Answer him first, briefly. Once the chat is warm, let him know what you are without announcing it like a job title or using a script: in your own words, once, that you sell your photos, videos and knickers. Say it differently every time. Light, once, then carry on.",
    // Every man arrives with his own thing. Match it instead of correcting it:
    // the owner's rule is that "yes mummy" is an invitation, not a mistake.
    "Play along with absolutely anything he is into. Whatever the fantasy, the kink, the pet name, the way he wants to be treated or the thing he wants you to be, take it in your stride and act like you enjoy it. Never correct him, never say you are not into it, never make him explain or apologise, never make him feel odd. Let him say it again and answer in kind, then carry on. Work out what this one wants and become it. The only things you never play along with are the hard stops: anyone under 18, a meet or an address, and real-world harm.",
    // The owner's complaint: a direct sexual instruction got the sales line
    // back. Stay in the scene; selling waits.
    "When he tells you what to do, do it in words: describe doing it and how it feels, filthy and in one line. Never answer a sexual instruction with what you sell, and never cut into his fantasy with a price. The selling waits until he has finished.",
    "Never repeat yourself. Do not reuse a sentence, phrase or pitch you have already sent in this chat, and do not say the same thing in slightly different words. Answer what he just said with something new. If he tells you that you are repeating, change the subject or react to him, do not apologise twice and do not send the same line again.",
    "Never mention being a bot or AI unless directly asked.",
    "Never promise anything about money, meets or content that is not already stated in your instructions.",
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
          messages, max_tokens: 120, temperature: 0.9,
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
        messages, max_tokens: 110, temperature: 0.85,
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

async function autoReply(env, sb, conn, conv, msg, text, forcedReply) {
  // Need text to reply to, and a bot token to send with.
  if (!text) return null;

  const persona = await loadPersonaRow(env, sb, conn);
  const p = persona.row;
  if (p && p.enabled === false) return null;   // persona off: stay quiet

  // Typing indicator first: a real person doesn't reply instantly. Show
  // "typing..." while we work, then hold for a beat scaled to reply length.
  const token0 = await botTokenFor(env, sb, conn);
  if (token0) {
    try {
      let typing = true;
      const typer = async () => {
        while (typing) {
          await tg.sendChatAction(token0, conn.id, msg.chat.id, "typing").catch(() => {});
          await sleep(4500);
        }
      };
      typer();
      conv.__typingStop = () => { typing = false; };
    } catch (e) {
      console.log(JSON.stringify({ evt: "tg.typing_failed", err: String(e).slice(0, 100) }));
    }
  }
  const stopTyping = () => { try { conv.__typingStop && conv.__typingStop(); } catch {} };

  // FREE CONTENT: "anything free?" -> send a live, price-0 item from this
  // account's library, once per conversation until they ask again later.
  const lower = String(text || "").toLowerCase();
  // "send us a pic" is the most common opener there is. It gets the free one,
  // the same as asking for a freebie.
  const askingFree = /(free|4free|for free|anything for me|freebie|sample|preview|\bpic|\bphoto|\bpicture|show (me|us)|what do you look like|send (me )?(something|one)|any nudes|\bnudes\b)/.test(lower);
  if (askingFree) {
    const sentFree = await maybeSendFreeItem(env, sb, conn, conv, msg);
    if (sentFree) { stopTyping(); return sentFree; }   // media sent; no text needed
  }

  // MENU: "what do you offer / send me the menu" -> list live items with
  // prices straight from her library, not the model's imagination.
  const askingMenu = /(menu|what.*(offer|have|sell|sellin|got)|price list|how much|options|what can i buy|show me what)/.test(lower);
  if (askingMenu && !askingFree) {
    const menu = await maybeSendMenu(env, sb, conn, conv, msg);
    if (menu) { stopTyping(); return menu; }
  }

  // "how do I pay?" -> re-send the payment-method buttons for the last item
  // they were quoted, instead of letting the model invent details.
  const askingHowPay = /how (do|can) i pay|how.*(pay|payment)|payment (method|options|details)?|ways? to pay|pay options/.test(lower);
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
  if (!askingFree && !askingMenu && await looksLikeBuyIntent(text, lower)) {
    const picked = await matchLiveItem(env, sb, conn, text);
    if (picked) {
      const payReq = await sendPaymentRequest(env, sb, conn, conv, msg, picked);
      if (payReq) { stopTyping(); return payReq; }
    }
  }

  // Recent history (decrypted previews are enough context for tone).
  const hist = await sb(env, "messages?conversation_id=eq." + conv.id +
    "&direction=in.(" + encodeURIComponent("in,out") + ")&select=direction,body_preview,sent_at" +
    "&order=sent_at.desc&limit=30").catch(() => null);
  // Internal rows carry console-only labels like "[free] PIC TITLE" or
  // "[menu] 2 paid". They are bookkeeping, not chat the girl said, so strip
  // them before the model sees them - otherwise it parrots the tag verbatim.
  const stripInternal = s => String(s || "").replace(/\s*\[[^\]]{1,40}\]\s*/g, " ").replace(/\s+/g, " ").trim();
  const history = (hist || []).reverse()
    .filter(m => m.body_preview && m.body_preview !== text)
    .map(m => ({ dir: m.direction, text: stripInternal(m.body_preview) }))
    .filter(m => m.text);

  // Generate. A forced intercept answer skips the model.
  let replyText = null, via = null;
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
        const custName = (conv && conv.customers) ? (conv.customers.first_name || conv.customers.username) : null;
        if (custName) custLine = "You're chatting with " + custName + ".";
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
      const system = personaSystemPrompt(p, conn, catalogue, payLine, priorOut) + (custLine ? " " + custLine : "");
      replyText = await generateReply(env, system, history, text);
      via = "workers-ai";
      // One retry when the model loops. Without it a small model sends the
      // same sentence twice in a row, which is what the owner hears as
      // "she is very repetitive".
      if (replyText && repeatsSomething(replyText, priorOut)) {
        console.log(JSON.stringify({ evt: "tg.reply.repeat_retry", text: replyText.slice(0, 80) }));
        const retry = await generateReply(env, system +
          " You were about to repeat yourself. Do NOT send this line or anything like it: \"" + replyText + "\".", history, text);
        if (retry) {
          if (repeatsSomething(retry, priorOut)) console.log(JSON.stringify({ evt: "tg.reply.repeat_again" }));
          replyText = retry;
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

  // Send through the business connection as the account.
  const token = await botTokenFor(env, sb, conn);
  if (!token) {
    console.log(JSON.stringify({ evt: "tg.reply.no_token", persona: null }));
    stopTyping();
    return null;
  }
  try {
    // Human pacing: a short pause that scales with reply length, so the
    // typing indicator reads as someone actually composing a message.
    const words = replyText.split(/\s+/).length;
    const think = Math.min(9000, 1500 + words * 220 + Math.random() * 1200);
    await sleep(think);
    stopTyping();
    const sent = await tg.sendMessage(token, conn.id, msg.chat.id, replyText);
    // Price or item mentioned in her reply -> always follow with the
    // clickable payment options (customer never has to ask twice).
    try {
      const lowerReply = String(replyText || "").toLowerCase();
      const mentionsItem = await matchLiveItem(env, sb, conn, replyText);
      const mentionsPrice = /£\s?\d|\d+\s?(ton|quid|£)/i.test(replyText);
      if (mentionsItem || mentionsPrice) {
        const item = mentionsItem || await lastQuotedItem(env, sb, conv);
        if (item) await sendPaymentRequest(env, sb, conn, conv, msg, item);
      }
    } catch (e) {
      console.log(JSON.stringify({ evt: "tg.reply.paybtn_failed", err: String(e).slice(0, 150) }));
    }
    // Record our own reply as an outbound message row.
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
        body_preview: preview(replyText),
        raw: { via, business_connection_id: conn.id },
        sent_at: new Date().toISOString(),
        delivered: true,
      }),
    }).catch(() => {});
    await sb(env, "conversations?id=eq." + conv.id, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ last_outbound_at: new Date().toISOString() }),
    }).catch(() => {});
    return { via, text: replyText };
  } catch (e) {
    console.log(JSON.stringify({ evt: "tg.reply.send_failed", err: String(e).slice(0, 200) }));
    return null;
  }
}

/**
 * Send one free (price 0, live) library item when the customer asks for
 * something free. Media goes out through the business connection via a signed
 * URL; the row is recorded so history and the console show it.
 * Returns the send result, or null when nothing suitable / send failed.
 */
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
    "&direction=eq.out&select=tg_message_id,media_key&order=sent_at.desc&limit=10").catch(() => null);
  const recentKeys = new Set((recent || []).map(m => m.media_key).filter(Boolean));
  const item = items.find(m => !recentKeys.has(m.media_key)) || null;

  const token = await botTokenFor(env, sb, conn);
  if (!token) return null;

  // All her freebies already sent in this chat: re-send the SAME one she
  // already had and call them cheeky, instead of pretending there's nothing.
  if (!item) {
    const again = items[0];
    try {
      const r = await fetch(env.SUPABASE_URL + "/storage/v1/object/sign/content-store/" +
        again.media_key.split("/").map(encodeURIComponent).join("/"), {
        method: "POST",
        headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY,
                   "Content-Type": "application/json" },
        body: JSON.stringify({ expiresIn: 3600 }),
      });
      const d = await r.json();
      if (!d || !d.signedURL) return null;
      const fileUrl = env.SUPABASE_URL + "/storage/v1" + d.signedURL;
      const tgKind = again.kind === "image" ? "photo" : again.kind === "video" ? "video" : "document";
      const sent = await tg.sendMedia(token, conn.id, msg.chat.id, tgKind, fileUrl,
        "look, you've already had this one for free, cheeky 😜");
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
          body_preview: "[free again] " + again.title,
          media_key: again.media_key,
          sent_at: new Date().toISOString(),
          raw: { via: "free-item-again", item_id: again.id },
        }),
      }).catch(() => {});
      console.log(JSON.stringify({ evt: "tg.free_item.again", item: again.id }));
      return { free_again: again.id };
    } catch (e) {
      console.log(JSON.stringify({ evt: "tg.free_item.again_failed", err: String(e).slice(0, 200) }));
      return null;
    }
  }

  // Signed URL the Telegram servers can fetch the file from. Console uploads
  // live in Supabase Storage (content-store), not the Worker's R2 bucket, so
  // /m/ would 404 here; mint a Supabase signed URL instead.
  let fileUrl = null;
  try {
    const r = await fetch(env.SUPABASE_URL + "/storage/v1/object/sign/content-store/" +
      item.media_key.split("/").map(encodeURIComponent).join("/"), {
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
  if (!fileUrl) return null;
  // Telegram media methods take a kind: image->photo, video->video, else document.
  const tgKind = item.kind === "image" ? "photo" : item.kind === "video" ? "video" : "document";

  try {
    const sent = await tg.sendMedia(token, conn.id, msg.chat.id, tgKind, fileUrl, "for you 💜");
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
        body_preview: "[free] " + item.title,
        media_key: item.media_key,
        sent_at: new Date().toISOString(),
        raw: { via: "free-item", item_id: item.id },
      }),
    }).catch(() => {});
    console.log(JSON.stringify({ evt: "tg.free_item.sent", item: item.id, kind: tgKind }));
    return { free_item: item.id };
  } catch (e) {
    console.log(JSON.stringify({ evt: "tg.free_item.send_failed", err: String(e).slice(0, 200) }));
    return null;                                  // fall back to a text reply
  }
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
    "&active=eq.true&select=id,name,kind,price_gbp,description,media_key&order=position.asc&limit=20").catch(() => null);
  if (menu && menu.length) {
    return menu.filter(m => m.name).map(m => ({ ...m, title: m.name, source: "menu" }));
  }
  const rows = await sb(env, "media_items?telegram_account_id=eq." +
    encodeURIComponent(conn.telegram_account_id) +
    "&visible=eq.true&select=id,title,kind,price_ton,price_gbp,media_key&order=price_ton.desc&limit=20").catch(() => null);
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
  const paid = items.filter(m => priceOf(m) > 0).slice(0, 8);
  if (!paid.length) return null;
  const freeRows = await sb(env, "media_items?telegram_account_id=eq." +
    encodeURIComponent(conn.telegram_account_id) +
    "&visible=eq.true&price_ton=eq.0&select=id,title,media_key&limit=5").catch(() => null);
  const free = (freeRows || []).filter(m => m.media_key);
  const lines = ["Here's what I've got right now 💕"];
  for (const m of paid) {
    lines.push("• " + m.title + " - " + fmt(m) + (m.kind === "physical" ? " (posted)" : ""));
  }
  if (free.length) lines.push("I've also got a freebie if you'd like one, just ask 😊");
  lines.push("Want any of them?");
  const menuText = lines.join("\n");

  const token = await botTokenFor(env, sb, conn);
  if (!token) return null;
  try {
    // Clickable menu: one button per paid item, a freebie button if she has
    // one. Taps arrive as callback_query (onCallback below).
    const buttons = paid.map(m => ([{
      text: (m.title + " · " + fmt(m)).slice(0, 60),
      callback_data: "buy:" + m.id,
    }]));
    if (free.length) buttons.push([{ text: "🎁 Free pic", callback_data: "free:" + free[0].id }]);
    const sent = await tg.sendMessage(token, conn.id, msg.chat.id, menuText, {
      reply_markup: { inline_keyboard: buttons },
    });
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
        body_preview: "[menu] " + paid.length + " paid, " + free.length + " free",
        sent_at: new Date().toISOString(),
        raw: { via: "menu", items: paid.map(m => m.id) },
      }),
    }).catch(() => {});
    console.log(JSON.stringify({ evt: "tg.menu.sent", paid: paid.length, free: free.length }));
    return { menu: true };
  } catch (e) {
    console.log(JSON.stringify({ evt: "tg.menu.send_failed", err: String(e).slice(0, 200) }));
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
async function looksLikeBuyIntent(text, lower) {
  if (!text) return false;
  if (/(video|pic|pics|photo|photos|set|bundle|nude|naked|image|vid|clip|content)/.test(lower)) return true;
  if (/^yes\b|^yep\b|^yeah\b|^pls\b|please$|take it|i('| a)?ll take|i want (it|that|this)\b|send (it|that)\b/gi.test(text)) return true;
  return false;
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
  const pm = data.match(/^pay:(ton|paypal|bank):([0-9a-f-]{36})$/i);
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
    // Closing line varies every time so it never reads like a template.
    const CLOSERS = [
      "let me know once you've sent it babe 😈",
      "give me a shout when it's done 😘",
      "tell me when you've paid and it's all yours 🤩",
      "can't wait 💕 just say when you've sent it",
      "drop me a message once it's in 💋",
      "I'll be waiting 😏 just tell me when it's done",
      "once it lands it's straight over to you 💝 say the word",
    ];
    const closer = CLOSERS[Math.floor(Math.random() * CLOSERS.length)];
    let detail = null;
    const prof2 = await sb(env, "ai_profiles?creator_id=eq." +
      encodeURIComponent(conn.creator_id) +
      "&select=wallet_address,pay_bank_name,pay_sort_code,pay_account_no,pay_paypal").catch(() => null);
    const pay = (prof2 && prof2[0]) || {};
    if (method === "ton" && pay.wallet_address) {
      detail = `my ton address is\n${pay.wallet_address}\nput your username in the comment so I know it's you x\n${closer}`;
    } else if (method === "paypal" && pay.pay_paypal) {
      detail = `paypal me at ${pay.pay_paypal} x\n${closer}`;
    } else if (method === "bank" && (pay.pay_sort_code || pay.pay_account_no)) {
      detail = `bank transfer x\nname ${pay.pay_bank_name || ""}\nsort code ${pay.pay_sort_code || ""}\naccount ${pay.pay_account_no || ""}\n${closer}`;
    } else {
      // Nothing set for that method: never invent it.
      detail = `give me a sec and I'll send you the details x`;
    }
    try {
      await tg.sendMessage(token, conn.id, chatId, detail);
      await sb(env, "messages", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify({
          conversation_id: conv.id,
          creator_id: conn.creator_id,
          direction: "out",
          sender: "ai",
          kind: "text",
          body_preview: "[pay details] " + method + " · " + item.title,
          sent_at: new Date().toISOString(),
          raw: { via: "pay-details", method, item_id: item.id },
        }),
      }).catch(() => {});
      console.log(JSON.stringify({ evt: "tg.pay_details.sent", method, item: item.id }));
      return { pay_details: method };
    } catch (e) {
      console.log(JSON.stringify({ evt: "tg.pay_details.failed", err: String(e).slice(0, 200) }));
      return null;
    }
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
  const payText = `ooh good choice 😏 ${name} is ${price} babe, how d'you wanna pay?`;
  // Payment-method buttons: tapping one sends just that method's details,
  // in her voice. Methods without details configured are still offered so
  // the conversation can continue either way.
  const methods = [[
    { text: "👉 TON", callback_data: "pay:ton:" + item.id },
    { text: "📝 PayPal", callback_data: "pay:paypal:" + item.id },
    { text: "🏦 Bank transfer", callback_data: "pay:bank:" + item.id },
  ]];
  try {
    const sent = await tg.sendMessage(token, conn.id, msg.chat.id, payText, {
      reply_markup: { inline_keyboard: methods },
    });
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
export { generateReply, repeatsSomething, personaSystemPrompt, ensureEmoji, sellableItems };
