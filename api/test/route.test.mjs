// The routing table (OPUS-PLAN Fix 0/1/7/8). Literal customer lines from the
// 26-28 Oct transcripts -> the route they must take. This is the regression
// suite for the menu going out at random, "be in the video" getting a price
// list, and the free picture firing on a sexual line.
import test from "node:test";
import assert from "node:assert/strict";
import { routeInbound, inboundSignals, menuOffered, openQuoteRow, reofferDue, withGapMarkers,
         memoryLine, PROMISE_OUT, CHASE_IN, MEET_RE, gbpText } from "../src/tg.js";

const first = (text, ctx) => routeInbound(text, ctx)[0];
const ago = mins => new Date(Date.now() - mins * 60000).toISOString();

test("Fix 1: lines that are NOT a menu ask never route to the menu", () => {
  for (const t of [
    "After maybe 2-3 ejaculations I'll be done for the night",
    "Yeah I though where she gone",
    "Yeah my princess slut is going to be sore",
    "I'll have 2 what",
    "hmm interesting",
    "oh yeah",
    "such as?",
    "really?",
  ]) {
    assert.ok(!routeInbound(t, {}).includes("menu"), t + " -> " + routeInbound(t, {}).join(","));
  }
});

test("Fix 1: a sexual line about her body is not a free-picture request", () => {
  for (const t of ["I want you with your ass in my face", "your tits are amazing", "can't wait to see you naked",
                   "I'd love to see you ride me"]) {
    assert.ok(!routeInbound(t, {}).includes("free"), t);
  }
});

test("Fix 1: real asks still work", () => {
  assert.equal(first("what you selling"), "menu");
  assert.equal(first("send me the menu"), "menu");
  assert.equal(first("how much are your videos"), "menu");
  assert.equal(first("what are your prices"), "menu");
  assert.equal(first("send us a pic"), "free");
  assert.equal(first("got any nudes"), "free");
  assert.equal(first("can i see you"), "free");
  assert.equal(first("what do you look like"), "free");
});

test("Fix 1: a bare yes is a menu yes only after HER offer, inside 30 minutes", () => {
  assert.notEqual(first("yes", { offered: false }), "menu");
  assert.equal(first("yes", { offered: true }), "menu");
  assert.equal(first("go on then show me", { offered: true }), "menu");
  const offer = [{ body_preview: "want to see my menu? x", sent_at: ago(5), raw: {} }];
  assert.equal(menuOffered(offer), true);
  assert.equal(menuOffered([{ body_preview: "want to see my menu? x", sent_at: ago(45), raw: {} }]), false, "stale offer");
  assert.equal(menuOffered([{ body_preview: "x", sent_at: ago(2), raw: { via: "menu-reoffer" } }]), true);
  assert.equal(menuOffered([{ body_preview: "you're naughty x", sent_at: ago(1), raw: {} },
                            { body_preview: "lol", sent_at: ago(2), raw: {} },
                            { body_preview: "want to see my menu? x", sent_at: ago(3), raw: {} }]), false,
    "only her last two lines count");
});

test("Fix 8: be in the video is a meet, and goes first", () => {
  const t = "What if don't want the video but want to be in the video x";
  assert.equal(MEET_RE.test(t), true);
  assert.equal(first(t, { quoted: true, offered: true }), "meet");
  assert.ok(!routeInbound(t).includes("video-list"));
  assert.equal(first("can we film together"), "meet");
});

test("Fix 8: a custom ask goes to the owner, never to the menu or a price", () => {
  for (const t of ["can you make me one with my name in it", "what video would you make for me",
                   "would you do a custom one", "can you wear the red ones for me"]) {
    assert.deepEqual(routeInbound(t, { offered: true, quoted: true }), ["custom", "model"], t);
  }
});

test("Fix 8: the video list only answers a request for a video", () => {
  assert.equal(first("send me a video"), "video-list");
  assert.equal(first("have you got any vids"), "video-list");
  assert.ok(!routeInbound("I watched a video of a girl like you earlier").includes("video-list"));
  assert.ok(!routeInbound("that video call was hot").includes("video-list"));
});

test("Fix 8: payment replies only when a quote is open", () => {
  assert.equal(first("stars please", { quoted: true }), "payment");
  assert.equal(first("yes", { quoted: true, offered: true }), "payment", "a yes to an open quote pays, before the menu");
  assert.ok(!routeInbound("stars please", { quoted: false }).includes("payment"));
  assert.ok(!routeInbound("yes", { quoted: false }).includes("payment"));
});

test("Fix 8: the whole gate order, most specific first", () => {
  const order = routeInbound("I'll take the doggy video, how much is it", { quoted: true, lastMediaFresh: true, namedItem: true });
  // payment (quoted + "take") -> price-of-that ("it" + "how much") -> named item -> video list -> model
  assert.deepEqual(order, ["payment", "price-of-that", "named-item", "model"]);
  assert.deepEqual(routeInbound("he sent you an image: a cat. React to it", { quoted: true }), ["model"], "synthetic text never routes");
  assert.equal(routeInbound("send me a pic")[routeInbound("send me a pic").length - 1], "model");
});

test("Fix 2: a no only counts as a turn-down when something is on the table", () => {
  assert.equal(inboundSignals("No I'm one of the good ones", {}).reject, false);
  assert.equal(inboundSignals("No I'm one of the good ones", { quoted: true }).reject, true);
  assert.equal(inboundSignals("no thanks", { menuRecent: true }).reject, true);
});

test("Fix 7: 'what would that cost' prices the last media, and only when it is fresh", () => {
  assert.equal(first("What would that cost daddy", { lastMediaFresh: true }), "price-of-that");
  assert.equal(first("how much is that", { lastMediaFresh: false }), "menu-question");
  assert.ok(!routeInbound("What would that cost daddy").includes("menu"), "deictic is not a menu ask");
  assert.equal(first("how much would it cost for a video of you"), "menu", "a general price ask is still the menu");
});

test("QUOTED ends on decline or payment", () => {
  const outs = [{ raw: { via: "menu-buy", item_id: "i1" }, sent_at: ago(10) }];
  assert.ok(openQuoteRow(outs, {}, {}));
  assert.equal(openQuoteRow(outs, { declined_at: ago(1) }, {}), null);
  assert.equal(openQuoteRow(outs, {}, { open_quote: { item_id: "i1", status: "paid", at: ago(1) } }), null);
  assert.equal(openQuoteRow([{ raw: { via: "menu-buy", item_id: "i1" }, sent_at: ago(25 * 60) }], {}, {}), null);
});

test("Fix 1: the re-offer is a once-a-day question, never mid-scene", () => {
  const base = { hisCount: 20, sellRecent: false, declinedRecent: false, quoted: false, recentIn: ["how was work", "busy day x"] };
  assert.equal(reofferDue(base), true);
  assert.equal(reofferDue({ ...base, recentIn: ["I'm so hard for you"] }), false);
  assert.equal(reofferDue({ ...base, sellRecent: true }), false);
  assert.equal(reofferDue({ ...base, declinedRecent: true }), false);
  assert.equal(reofferDue({ ...base, quoted: true }), false);
  assert.equal(reofferDue({ ...base, hisCount: 3 }), false);
  // A 30-message hot chat replay: at most one question, never a list.
  let asked = 0, sellRecent = false;
  for (let i = 0; i < 30; i++) {
    const hot = i % 3 !== 0;
    if (reofferDue({ ...base, hisCount: 6 + i, sellRecent, recentIn: [hot ? "ride my cock" : "how are you"] })) { asked++; sellRecent = true; }
  }
  assert.ok(asked <= 1, "asked " + asked);
});

test("Fix 5: a gap of more than six hours is marked in the history", () => {
  const rows = [
    { dir: "out", text: "nearly ready for you x", sent_at: ago(2 * 24 * 60) },
    { dir: "in", text: "Still waiting babe", sent_at: ago(1) },
  ];
  const h = withGapMarkers(rows, Date.now());
  assert.deepEqual(h.map(r => r.dir), ["out", "gap", "in"]);
  assert.match(h[1].text, /2 days later/);
  assert.equal(withGapMarkers([{ dir: "in", text: "hi", sent_at: ago(5) }], Date.now()).length, 1);
  assert.match(withGapMarkers([{ dir: "out", text: "x", sent_at: ago(30 * 60) }], Date.now())[1].text, /1 day later/);
});

test("Fix 6: PROMISE_OUT catches her unbacked promises and nothing else", () => {
  for (const t of ["I've got a free pic to start you off", "one sec babe", "nearly ready for you x"]) assert.ok(PROMISE_OUT.test(t), t);
  for (const t of ["I'd take every inch and still ask for more", "I'll be good for you", "you'd have me dripping"]) assert.ok(!PROMISE_OUT.test(t), t);
  assert.ok(CHASE_IN.test("Still waiting babe how are you"));
  assert.ok(CHASE_IN.test("Said ya was sending me something yeatersay x"));
});

test("Fix 6: the memory block stays under sixty words", () => {
  const line = memoryLine({
    name: "Andy", bought: ["a", "b"], free_sent: ["x", "y"],
    open_quote: { stars: 969, status: "open", at: ago(5) },
    custom_ask: { text: "a video saying my name ".repeat(10), at: ago(5) },
    last_media: { kind: "image", free: true, at: ago(3) },
    owner_notes: "never mention his ex wife ".repeat(20),
  });
  assert.ok(line.split(/\s+/).length <= 60, line);
  assert.match(line, /^What you know about him/);
  assert.equal(memoryLine({}), "");
});

test("Fix 9: pounds always print with two decimals", () => {
  assert.equal(gbpText(9.5), "£9.50");
  assert.equal(gbpText("15"), "£15.00");
  assert.equal(gbpText(null), "£0.00");
});
