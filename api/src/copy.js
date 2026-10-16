/**
 * Customer-facing text that must NEVER be model-generated.
 *
 * Ported from telegram-dm-bot/src/copy.ts with two fixes:
 *   - {PRIVACY_URL}/{TERMS_URL} were shipped as literal unsubstituted braces.
 *     A real customer would have received the characters "{PRIVACY_URL}".
 *     They are now real template functions.
 *   - The four-touchpoint disclosure design is reduced to ONE first-contact
 *     line. Telegram's own bot attribution already tells the customer; we are
 *     not going to repeat it in every message.
 *
 * Version these. The version string is stored on the conversation so we can
 * prove what a given customer was shown and when.
 */

export const COPY_VERSION = "v2";

/**
 * Sent ONCE, on first contact, before the first AI-assisted reply.
 * Not a consent prompt - no tap required, no interruption. Plain transparency.
 * {name} is the creator's display name.
 */
export const firstContact = (name) =>
  `Quick heads-up — ${name} uses an AI assistant to help reply quickly, any time of day. ` +
  `Ask for a person whenever you like and I'll hand you straight over.`;

/**
 * Answer to any form of "are you a bot?".
 * A deterministic intercept that runs BEFORE the model, not a behaviour we hope
 * the model maintains. This is the control that keeps us out of Fraud Act /
 * DMCCA territory, and it is the one disclosure that is never optional.
 */
export const AM_I_A_BOT =
  "I'm an AI assistant, not a person. Happy to keep helping, or say \"human\" and I'll hand you over.";

export const HANDED_TO_HUMAN =
  "Passing you to a person now — they'll pick this up shortly. Thanks for bearing with me.";

export const AI_DECLINED =
  "No problem. I've switched the AI off for this chat — a person will reply here from now on.";

export const OUT_OF_WINDOW_NOTE =
  "This conversation has gone quiet for over 24 hours, so I can't reply automatically any more. " +
  "A person will follow up.";

export const privacy = (url) =>
  "We store the messages in this chat to answer you and to handle orders. " +
  "Replies are AI-assisted. You can ask for a human, ask us to switch the AI off, " +
  "or ask us to delete your data at any time." +
  (url ? ` Full policy: ${url}` : "");

export const terms = (url) => (url ? `Our terms: ${url}` : "Terms are available on request.");

/** Only required when a creator is switched to a third-party model provider. */
export const thirdPartyConsent = (name) =>
  `Before we carry on: ${name}'s assistant uses an external AI service to draft replies, ` +
  `which means your messages are processed by that provider. Happy to continue?`;

/** Matches a customer asking whether they're talking to a machine or a person. */
const BOT_QUESTION =
  /\b(are|r)\s+(you|u)\s+(a\s+)?(bot|ai|real|human|a\s+person|chatgpt|robot)\b|\bis\s+this\s+(a\s+)?(bot|ai|real|automated|a\s+real\s+person|a\s+person|human)\b|\bam\s+i\s+(talking|speaking|chatting)\s+to\s+(a\s+)?(bot|ai|real|human|person|machine)\b|\b(bot|ai)\s*\?$|\breal\s+person\?/i;

export function isAskingIfBot(text) {
  return BOT_QUESTION.test(text || "");
}

/** Matches an explicit request for a human. */
const HUMAN_REQUEST =
  /\b(speak|talk|chat)\s+to\s+(a\s+)?(human|person|someone|real\s+person|staff|manager)\b|\b(human|real\s+person)\s+please\b|^\s*human\s*$/i;

export function isAskingForHuman(text) {
  return HUMAN_REQUEST.test(text || "");
}

/**
 * Deterministic age-signal screen. Runs before the model; a hit freezes the
 * conversation, disables every SKU for that contact and forwards NOTHING.
 * There is no review-then-release branch. A refusal mechanism, not a
 * classifier to tune for accuracy. Err wide.
 */
const AGE_SIGNALS = [
  /\bi(?:'m| am)\s+(?:only\s+)?(?:1[0-7]|[1-9])\b(?!\s*(?:0|,|\.\d))/i,
  /\bi(?:'m| am)\s+(?:a\s+)?(?:minor|underage|under\s*18|kid|child)\b/i,
  /\b(?:year\s*)(?:7|8|9|10|11)\b/i,
  /\b(?:in|at)\s+(?:year|grade)\s*\d{1,2}\b/i,
  /\bmy\s+(?:mum|mom|dad|parents?|guardian)\s+(?:will|would|might|doesn'?t|don'?t)\b/i,
  /\b(?:secondary|high)\s*school\b/i,
  /\bgcses?\b/i,
  /\bsixth\s*form\b/i,
  /\bturn(?:ing)?\s+1[1-8]\s+(?:soon|next|this)\b/i,
];

export function hasAgeSignal(text) {
  return AGE_SIGNALS.some((re) => re.test(text || ""));
}
