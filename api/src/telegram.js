/**
 * Telegram Bot API client, Business-aware.
 *
 * Verified against Bot API 10.3 (2026-08-24). Field names here are the LIVE
 * ones - do not "correct" them from older library examples.
 */

const API = "https://api.telegram.org/bot";

export async function call(token, method, params) {
  const r = await fetch(API + token + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params || {}),
  });
  const body = await r.json().catch(() => ({ ok: false, description: "non-json response" }));
  if (!body.ok) {
    const err = new Error(`telegram ${method}: ${body.description || r.status}`);
    err.telegram = body;
    // Flood control: Telegram tells us exactly how long to wait.
    err.retryAfter = body.parameters && body.parameters.retry_after;
    throw err;
  }
  return body.result;
}

/**
 * The full set of updates this platform needs. allowed_updates behaviour for
 * business updates is underspecified in the current docs, so we ALWAYS pass the
 * explicit list and never rely on the default. Omitting these is the single
 * most common reason a Business bot looks dead.
 */
export const ALLOWED_UPDATES = [
  "message",
  "edited_message",
  "business_connection",
  "business_message",
  "edited_business_message",
  "deleted_business_messages",
  "callback_query",
  "pre_checkout_query",
  "purchased_paid_media",
];

export function setWebhook(token, url, secret) {
  return call(token, "setWebhook", {
    url,
    secret_token: secret,
    allowed_updates: ALLOWED_UPDATES,
    drop_pending_updates: false,
    max_connections: 40,
  });
}

export const deleteWebhook = (token) => call(token, "deleteWebhook", { drop_pending_updates: false });
export const getWebhookInfo = (token) => call(token, "getWebhookInfo", {});
export const getMe = (token) => call(token, "getMe", {});

/* A thumbs up on a message, on the account's behalf. Used for the brush-off:
   acknowledging a "fuck off" without spending a model call or chasing him. */
export const setMessageReaction = (token, chatId, messageId, emoji, businessConnectionId) =>
  call(token, "setMessageReaction", {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: "emoji", emoji: emoji || "👍" }],
    is_big: false,
    ...(businessConnectionId ? { business_connection_id: businessConnectionId } : {}),
  });

/**
 * Re-read a connection's rights from Telegram.
 *
 * telegram-dm-bot exported this and never called it, so cached rights could go
 * stale forever with no TTL and the send path would happily send on them. Call
 * it before any send that matters, not just at connect time.
 */
export const getBusinessConnection = (token, businessConnectionId) =>
  call(token, "getBusinessConnection", { business_connection_id: businessConnectionId });

/**
 * BusinessBotRights - all 14 live fields, Bot API 10.3. Every one is Optional
 * and typed `True`, so ABSENT means "not granted".
 *
 * Trap: Telegram's own prose for setBusinessAccountName/Username/Bio says
 * "requires the can_change_name/can_change_username/can_change_bio right", but
 * the schema field names are can_edit_*. Code checking can_change_* silently
 * never matches. These are the schema names, which are the real ones.
 */
export const RIGHT_FIELDS = [
  "can_reply",
  "can_read_messages",
  "can_delete_sent_messages",
  "can_delete_all_messages",
  "can_edit_name",
  "can_edit_bio",
  "can_edit_profile_photo",
  "can_edit_username",
  "can_change_gift_settings",
  "can_view_gifts_and_stars",
  "can_convert_gifts_to_stars",
  "can_transfer_and_upgrade_gifts",
  "can_transfer_stars",
  "can_manage_stories",
];

/**
 * Rights we will NEVER exercise even when granted. These are withdrawal rights
 * over an account we do not own. Granting them is the owner's mistake; acting
 * on them would be ours.
 */
export const NEVER_USE = [
  "can_transfer_stars",
  "can_transfer_and_upgrade_gifts",
  "can_convert_gifts_to_stars",
  "can_change_gift_settings",
];

/**
 * Normalise a BusinessConnection into the shape we store.
 *
 * The live object has NO flat can_reply - it carries a `rights` object. If
 * `rights` is missing we fail CLOSED, but we also flag it, because on API 10.3
 * a missing rights object means something is wrong, not that we should guess.
 */
export function normaliseConnection(conn) {
  const rights = conn.rights && typeof conn.rights === "object" ? conn.rights : null;
  const out = {};
  for (const f of RIGHT_FIELDS) out[f] = rights ? rights[f] === true : false;
  return {
    id: conn.id,
    tg_user_id: conn.user && conn.user.id,
    user_chat_id: conn.user_chat_id || null,
    is_enabled: conn.is_enabled === true,
    connected_at: conn.date ? new Date(conn.date * 1000).toISOString() : null,
    rights: out,
    rights_missing: !rights,
    over_granted: NEVER_USE.filter((r) => out[r]),
    user: conn.user || null,
  };
}

/** Send text as the connected account. business_connection_id is what makes it
 *  appear under the owner's identity rather than the bot's. */
export function sendMessage(token, businessConnectionId, chatId, text, extra) {
  return call(token, "sendMessage", {
    business_connection_id: businessConnectionId,
    chat_id: chatId,
    text,
    ...(extra || {}),
  });
}

/** Mark the customer's message read. Requires can_read_messages AND the chat
 *  to have been active in the last 24h. */
export function readBusinessMessage(token, businessConnectionId, chatId, messageId) {
  return call(token, "readBusinessMessage", {
    business_connection_id: businessConnectionId,
    chat_id: chatId,
    message_id: messageId,
  });
}

/**
 * deleteMessage does NOT accept business_connection_id - calling it against a
 * business chat operates on the wrong namespace. deleteBusinessMessages is the
 * only correct method here. 1-100 ids, all in the same chat.
 */
export function deleteBusinessMessages(token, businessConnectionId, messageIds) {
  return call(token, "deleteBusinessMessages", {
    business_connection_id: businessConnectionId,
    message_ids: messageIds.slice(0, 100),
  });
}

export function sendChatAction(token, businessConnectionId, chatId, action) {
  return call(token, "sendChatAction", {
    business_connection_id: businessConnectionId,
    chat_id: chatId,
    action: action || "typing",
  });
}

/** Acknowledge a button tap so Telegram stops the spinner on it. */
export function answerCallbackQuery(token, callbackQueryId, text, showAlert) {
  return call(token, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text || undefined,
    show_alert: !!showAlert,
  });
}

/** Media sends that accept business_connection_id (verified against 10.3). */
export const MEDIA_METHODS = {
  photo: "sendPhoto",
  video: "sendVideo",
  document: "sendDocument",
  audio: "sendAudio",
  voice: "sendVoice",
  animation: "sendAnimation",
  sticker: "sendSticker",
};

export function sendMedia(token, businessConnectionId, chatId, kind, fileUrl, caption) {
  const method = MEDIA_METHODS[kind];
  if (!method) throw new Error("unsupported media kind: " + kind);
  const field = kind === "animation" ? "animation" : kind;
  return call(token, method, {
    business_connection_id: businessConnectionId,
    chat_id: chatId,
    [field]: fileUrl,
    ...(caption ? { caption } : {}),
  });
}

/** The 24h reply window. can_reply is scoped to private chats with an INCOMING
 *  message in the last 24 hours; an outgoing message does not reopen it. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

export function withinWindow(lastInboundAtIso, now) {
  if (!lastInboundAtIso) return false;
  return now - new Date(lastInboundAtIso).getTime() < WINDOW_MS;
}
