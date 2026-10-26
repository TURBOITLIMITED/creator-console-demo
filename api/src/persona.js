/**
 * Per-creator personality for the one reply that is never free-form:
 * the answer to "are you a bot?".
 *
 * Design rule carried over from copy.js: this answer is a deterministic
 * intercept, not a behaviour we hope the model maintains. But the WORDING is
 * the creator's, so it can be cheeky, warm and on-voice instead of corporate.
 *
 * The guarantee is content, not tone. A variant may be as playful as the
 * creator likes, and MUST still be true read on its own, with no surrounding
 * context, by someone about to spend money.
 */

/** Self-identification. Without one of these the line answers nothing. */
const IDENTIFIES = /\b(a\.?i\.?|bot|assistant|automated|autoresponder|robot)\b/i;

/** Denying being automated. Flatly incompatible with the question asked. */
const DENIES_AI =
  /\b(not|ain'?t|isn'?t|aren'?t)\s+(a\s+|an\s+|the\s+)?(a\.?i\.?|bot|robot|machine|automated|computer)\b/i;

/** Claiming to be a person. The Fraud Act line. */
const CLAIMS_HUMAN =
  /\b(i'?m|i am|this is|it'?s)\s+(a\s+)?(real\s+)?(human|person|girl|guy|woman|man|me,? personally)\b|\breal\s+person\s+here\b|\b100%\s*(real|human)\b/i;

/**
 * Validate a creator-authored answer.
 * Returns {ok} or {ok:false, reason} with text fit to show in the dashboard.
 */
export function validateBotAnswer(text) {
  const t = String(text || "").trim();
  if (!t) return { ok: false, reason: "Cannot be empty." };
  if (t.length > 300) return { ok: false, reason: "Keep it under 300 characters." };
  if (CLAIMS_HUMAN.test(t)) {
    return { ok: false, reason:
      "This claims to be a person. Say anything you like, but not that." };
  }
  if (DENIES_AI.test(t)) {
    return { ok: false, reason:
      "This denies being automated. That is the one answer that cannot ship." };
  }
  if (!IDENTIFIES.test(t)) {
    return { ok: false, reason:
      "Nothing in this says it's an AI, so it doesn't answer the question. " +
      "\"Ahhhh you got me 😉\" reads as banter from a person — add something like " +
      "\"I'm the AI bit\" and keep the rest exactly as it is." };
  }
  return { ok: true };
}

/**
 * Defaults, in the house voice. Playful, short, emoji — and each one answers.
 * {name} is replaced with the creator's display name.
 */
export const DEFAULT_BOT_ANSWERS = [
  "Ahhhh you got me 😉 I'm {name}'s AI assistant — want me to grab her?",
  "Hahaha what gave it away 😂 yep, AI assistant here. Want {name} herself?",
  "Caught meee 🤭 I'm the AI bit — say the word and I'll pass you to {name}",
  "Busted 😅 I'm the assistant that helps {name} reply quickly. Want her directly?",
];

/* Owner's rule (standing, and asked for twice): she must never mention AI, bots
   or being automated, and she must not deny it either. A question about it is
   answered with a playful deflection and the chat carries on. These replace the
   disclosure answers above, which are kept only as history. */
export const DEFLECTIONS = [
  "what do you think x 😏",
  "guess x",
  "you tell me x",
  "does it matter? 😈",
  "hmm, what do you reckon x",
];

/**
 * The unambiguous form. Used when the customer is spending money, has asked
 * twice, or is plainly serious — moments where a wink is the wrong register
 * even if it is technically truthful.
 */
export const EXPLICIT_BOT_ANSWER =
  "Just so you know before you decide: I'm {name}'s AI assistant, not {name} herself. " +
  "Want me to pass you to her?";

const fill = (s, name) => String(s).replace(/\{name\}/g, name || "them");

/**
 * Has the customer asked before in this conversation? A second ask means the
 * first answer did not land, so stop being clever.
 */
export function pickBotAnswer(profile, opts) {
  // Never confirm, never deny, never name it. That is the owner's standing rule
  // and it overrides the disclosure pools above. The question is still recorded
  // on the conversation, so the owner can see how often it comes up.
  return { text: DEFLECTIONS[Math.floor(Math.random() * DEFLECTIONS.length)], variant: "deflect" };
}

/**
 * A customer genuinely pressing for confirmation, as opposed to asking in
 * passing. Deliberately wide: erring towards the clear answer costs a little
 * charm, erring the other way costs a chargeback.
 */
const SERIOUS = /\b(serious|seriously|honestly|be honest|truth|really|actually)\b|\bare you (really|actually|genuinely)\b|\bi need to know\b|\btell me (the truth|straight)\b|\bno jokes?\b|\byes or no\b/i;

export function isSeriousRequest(text) {
  return SERIOUS.test(text || "");
}

/**
 * Money is on the table: anything that reads as buying intent moves the
 * conversation into the register where only the plain answer is acceptable.
 */
const PURCHASE = /\b(buy|buying|purchase|pay|paying|payment|order|checkout|price|cost|how much|send me|unlock|subscribe|subscription|refund|invoice)\b|£\s*\d|\$\s*\d|\b\d+\s*(quid|stars?)\b/i;

export function isPurchaseContext(text) {
  return PURCHASE.test(text || "");
}
