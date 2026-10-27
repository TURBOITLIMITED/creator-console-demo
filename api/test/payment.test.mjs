// Harry T said "I haven't sent, asking for meetup" and the bot answered
// "ok checking now x" because the word sent was enough. These lock the reading.
import test from "node:test";
import assert from "node:assert/strict";
import { isPaymentClaim } from "../src/tg.js";

test("a real payment claim is acted on", () => {
  for (const t of [
    "done ive sent £25",
    "i've sent it x",
    "paid x",
    "just transferred it",
    "sent you the money babe",
  ]) assert.equal(isPaymentClaim(t), true, t);
});

test("a negation, a promise, a question or a photo is not a claim", () => {
  for (const t of [
    "i haven't sent",
    "i havent sent, asking for meetup",
    "not sent yet",
    "haven't paid yet",
    "will pay u",
    "what ive sent",
    "did i send it?",
    "send me a pic",
    "i sent you a pic",
  ]) assert.equal(isPaymentClaim(t), false, t);
});

test("money offered to meet is not a payment for an item", () => {
  for (const t of [
    "i can send you £100 to meet",
    "£100 for a meet",
    "will pay u to meet",
    "can i pay you to meet up",
  ]) assert.equal(isPaymentClaim(t), false, t);
});
