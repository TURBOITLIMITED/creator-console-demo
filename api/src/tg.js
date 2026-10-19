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
async function onConnection(env, sb, conn) {
  const n = tg.normaliseConnection(conn);
  const u = n.user || {};

  // The account row is keyed on the stable Telegram user id, never the username.
  // Only upsert when an account row already exists for this tg_user_id: an
  // unknown human granting access must not crash the insert (creator_id NOT
  // NULL) and must not create an unclaimed shell row either. The connection
  // row below still records the link, waiting to be claimed in the dashboard.
  const found = await sb(env, "telegram_accounts?tg_user_id=eq." + n.tg_user_id + "&select=id,creator_id");
  const account = found && found[0] || null;
  if (account) {
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
           has_sender_business_bot: !!msg.sender_business_bot },
    sent_at: msg.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString(),
    edited_at: edited ? new Date().toISOString() : null,
    delivered: true,
  }, "resolution=merge-duplicates,return=minimal");

  const patch = { last_message_at: new Date().toISOString() };
  if (!outgoing) patch.last_inbound_at = new Date().toISOString();
  else patch.last_outbound_at = new Date().toISOString();

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
  const rows = await sb(env, "media_items?telegram_account_id=eq." +
    encodeURIComponent(conn.telegram_account_id) +
    "&visible=eq.true&select=title,kind,price_ton&order=price_ton.desc&limit=15").catch(() => null);
  const items = (rows || []).filter(m => m.title);
  if (!items.length) return "";
  const lines = ["Your current live content for sale (the ONLY things you can offer, use these exact names and prices):"];
  for (const m of items) {
    lines.push("- " + m.title + " (" + (m.kind || "content") + ", " +
      (Number(m.price_ton) > 0 ? Number(m.price_ton) + " TON" : "FREE - only send it if they ask for something free") + ")");
  }
  lines.push("Never mention or invent any other content, and never write placeholders like [Insert Picture Link]. When they pick something, tell them the price and that you'll send it as soon as it's paid.");
  return lines.join("\n");
}

function personaSystemPrompt(p, conn, catalogue) {
  const name = (p && p.display_name) || "the creator";
  const tone = { warm: "friendly, personal, a little chatty",
                 playful: "light jokes, emoji, high energy",
                 professional: "polite, precise, no slang",
                 concise: "short answers, straight to the point" }[(p && p.tone) || "warm"];
  const lines = [
    `You are ${name}, replying to fans in her Telegram DMs. You are chatting to sell your photos and videos.`,
    `Voice: ${tone}.`,
  ];
  if (p && p.system_prompt) lines.push(String(p.system_prompt));
  if (catalogue) lines.push(catalogue);
  lines.push(
    "You are here to sell your content: weave what you offer into the chat naturally, flirt a little and invite them to buy. Never say you are 'not here for that' or push away from selling; selling is the whole point.",
    "Write like a real human woman texting: natural, warm, playful, small imperfections are fine.",
    "Replies should be 2 to 4 sentences, chatty and engaging, not one-word answers.",
    "Never mention being a bot or AI unless directly asked.",
    "Never promise anything about money, meets or content that is not already stated in your instructions.",
    "If a message is ambiguous, reply warmly and ask one short question.",
  );
  return lines.join(" ");
}

async function generateReply(env, system, history, incoming) {
  const messages = [
    { role: "system", content: system },
    ...history.map(h => ({ role: h.dir === "in" ? "user" : "assistant", content: h.text })),
    { role: "user", content: incoming },
  ];
  const out = await env.AI.run(env.AI_MODEL || "@cf/mistralai/mistral-small-3.1-24b-instruct", {
    messages, max_tokens: 500,
  });
  const text = typeof out === "string" ? out : (out && out.response) || "";
  return String(text).trim().replace(/^["']|["']$/g, "");
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
  const askingFree = /(free|4free|for free|anything for me|freebie|sample|preview)/.test(lower);
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
    "&order=sent_at.desc&limit=8").catch(() => null);
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
      const system = personaSystemPrompt(p, conn, catalogue);
      replyText = await generateReply(env, system, history, text);
      via = "workers-ai";
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
  const rows = await sb(env, "media_items?telegram_account_id=eq." +
    encodeURIComponent(conn.telegram_account_id) +
    "&visible=eq.true&price_ton=eq.0&select=id,title,kind,media_key" +
    "&order=uploaded_at.desc&limit=5").catch(() => null);
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

/* MENU: list her live items with prices when a customer asks what she
   offers. Paid items first with their TON price; if she has a free item,
   mention it as available on request. Falls back to the model when the
   library is empty, so nothing is invented from thin air. */
async function maybeSendMenu(env, sb, conn, conv, msg) {
  if (!conn.telegram_account_id) return null;
  const rows = await sb(env, "media_items?telegram_account_id=eq." +
    encodeURIComponent(conn.telegram_account_id) +
    "&visible=eq.true&select=id,title,kind,price_ton" +
    "&order=price_ton.desc&limit=20").catch(() => null);
  const items = (rows || []).filter(m => m.title);
  if (!items.length) return null;

  const fmt = t => Number(t) > 0 ? Number(t) + " TON" : null;
  const paid = items.filter(m => Number(m.price_ton) > 0).slice(0, 8);
  const free = items.filter(m => !Number(m.price_ton));
  const lines = ["Here's what I've got right now 💕"];
  for (const m of paid) {
    lines.push("• " + m.title + " - " + fmt(m.price_ton));
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
      text: (m.title + " · " + fmt(m.price_ton)).slice(0, 60),
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
        raw: { via: "menu", items: items.map(m => m.id) },
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
  if (!conn.telegram_account_id) return null;
  const rows = await sb(env, "media_items?telegram_account_id=eq." +
    encodeURIComponent(conn.telegram_account_id) +
    "&visible=eq.true&select=id,title,kind,price_ton,media_key" +
    "&order=price_ton.desc&limit=20").catch(() => null);
  const items = (rows || []).filter(m => m.title && Number(m.price_ton) > 0);
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
  if (!m) {
    console.log(JSON.stringify({ evt: "tg.callback.unknown", data: data.slice(0, 40) }));
    return { skipped: "unknown callback" };
  }
  const action = m[1], mediaId = m[2];

  const rows = await sb(env, "media_items?id=eq." + encodeURIComponent(mediaId) + "&select=*").catch(() => null);
  const item = rows && rows[0];
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
  try { await tg.answerCallbackQuery(token, cq.id, item.title + " · " + Number(item.price_ton) + " TON"); } catch (e) {
    console.log(JSON.stringify({ evt: "tg.callback.ack_failed", err: String(e).slice(0, 120) })); }
  const r = await sendPaymentRequest(env, sb, conn, conv, { chat: { id: chatId } }, item);
  await sb(env, "conversations?id=eq." + conv.id, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ purchase_intent_at: new Date().toISOString() }),
  }).catch(() => {});
  console.log(JSON.stringify({ evt: "tg.menu.buy_pressed", item: item.id, price: item.price_ton }));
  return r || { buy_pressed: item.id };
}

/* Payment request for a specific item (shared by buy button and text). */
async function sendPaymentRequest(env, sb, conn, conv, msg, item) {
  const token = await botTokenFor(env, sb, conn);
  if (!token) return null;
  let wallet = null;
  const prof = await sb(env, "ai_profiles?creator_id=eq." +
    encodeURIComponent(conn.creator_id) + "&select=wallet_address").catch(() => null);
  if (prof && prof[0] && prof[0].wallet_address) wallet = prof[0].wallet_address;
  const price = Number(item.price_ton) || 0;
  // Two payment options: TON wallet when set, and bank transfer details
  // (sort code + account number). The customer picks whichever suits them.
  let payText = `You picked: ${item.title} · ${price} TON 💎

How would you like to pay?
`;
  if (wallet) {
    payText += `
👉 TON: send ${price} TON to
${wallet}
`;
  }
  payText += `
📅 Bank transfer: sort code 00-00-00, account 56483213

Once you've paid, reply "done" and I'll send it straight over 😊`;
  try {
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
        body_preview: "[payment request] " + item.title + " · " + price + " TON",
        sent_at: new Date().toISOString(),
        raw: { via: "menu-buy", item_id: item.id, price_ton: price },
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

  let result = null, error = null;
  try {
    if (kind === "business_connection")        result = await onConnection(env, sb, update.business_connection);
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
