import test from "node:test";
import assert from "node:assert/strict";
import { replyDelaySeconds } from "../src/tg.js";

test("module imports without a top-level ReferenceError", () => {
  assert.equal(typeof replyDelaySeconds, "function");
});

test("delay is a sane number at every engagement level", () => {
  for (const n of [0, 1, 5, 25, 100]) {
    const d = replyDelaySeconds("hi", {}, { replyText: "hey x", hisCount: n });
    assert.equal(typeof d, "number");
    assert.ok(d >= 8 && d < 200, `delay out of range: ${d}`);
  }
});

test("delay survives a missing hisCount", () => {
  const d = replyDelaySeconds("hi", {}, { replyText: "hey x" });
  assert.ok(Number.isFinite(d));
});

test("a warm chat answers faster than a cold one", () => {
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const cold = [], warm = [];
  for (let i = 0; i < 60; i++) {
    cold.push(replyDelaySeconds("hi", {}, { replyText: "hey x", hisCount: 1 }));
    warm.push(replyDelaySeconds("hi", {}, { replyText: "hey x", hisCount: 30 }));
  }
  assert.ok(avg(warm) < avg(cold), `warm ${avg(warm)} not faster than cold ${avg(cold)}`);
});
