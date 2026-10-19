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
import { pickBotAnswer, isSeriousRequest, isPurchaseContext } from "./persona.js";

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

function personaSystemPrompt(p, conn) {
  const name = (p && p.display_name) || "the creator";
  const tone = { warm: "friendly, personal, a little chatty",
                 playful: "light jokes, emoji, high energy",
                 professional: "polite, precise, no slang",
                 concise: "short answers, straight to the point" }[(p && p.tone) || "warm"];
  const lines = [
    `You are ${name}, replying to fans in her Telegram DMs.`,
    `Voice: ${tone}.`,
  ];
  if (p && p.system_prompt) lines.push(String(p.system_prompt));
  lines.push(
    "Keep replies short, one to three sentences, like a real person texting.",
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
  const out = await env.AI.run(env.AI_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp", {
    messages, max_tokens: 200,
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

  // Recent history (decrypted previews are enough context for tone).
  const hist = await sb(env, "messages?conversation_id=eq." + conv.id +
    "&direction=in.(" + encodeURIComponent("in,out") + ")&select=direction,body_preview,sent_at" +
    "&order=sent_at.desc&limit=8").catch(() => null);
  const history = (hist || []).reverse()
    .filter(m => m.body_preview && m.body_preview !== text)
    .map(m => ({ dir: m.direction, text: m.body_preview }));

  // Generate. A forced intercept answer skips the model.
  let replyText = null, via = null;
  try {
    if (forcedReply) {
      replyText = forcedReply.text;
      via = "intercept";
    } else {
      const system = personaSystemPrompt(p, conn);
      replyText = await generateReply(env, system, history, text);
      via = "workers-ai";
      if (!replyText) return null;
    }
  } catch (e) {
    console.log(JSON.stringify({ evt: "tg.reply.generate_failed", err: String(e).slice(0, 200) }));
    return null;
  }

  // Send through the business connection as the account.
  const token = await botTokenFor(env, sb, conn);
  if (!token) {
    console.log(JSON.stringify({ evt: "tg.reply.no_token", persona: null }));
    return null;
  }
  try {
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

async function botTokenFor(env, sb, conn) {
  // The bot token lives in the bots table, keyed by persona. We try the
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
