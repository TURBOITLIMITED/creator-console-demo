// A small model invented "M Thompson, sort code 04-00-75, account 38127588"
// and sent it to a customer. The model must never write bank details.
import test from "node:test";
import assert from "node:assert/strict";
import { scrubBankText } from "../src/tg.js";

test("model-written bank details are replaced", () => {
  for (const t of [
    "account name: M Thompson, sort code 04-00-75, account number 38127588 x",
    "my sort code is 23-01-63",
    "send it to account number 90535295",
  ]) {
    assert.equal(scrubBankText(t), "let me send you the proper details x", t);
  }
});

test("ordinary chat is untouched", () => {
  for (const t of ["hey you x", "it's £20 babe", "send me a pic x"]) {
    assert.equal(scrubBankText(t), t, t);
  }
});
