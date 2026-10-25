// Regression tests for reply quality: the model chain must survive a model id
// the account does not serve, and the repeat guard must catch a rephrase, not
// just an identical string. The owner's complaint is "she is very repetitive".
import test from "node:test";
import assert from "node:assert/strict";
import { generateReply, repeatsSomething, ensureEmoji } from "../src/tg.js";

test("a repeat, and a close rephrase, are both caught", () => {
  const prev = ["I bet you're good at it. I love a bit of vape smoke. Do you do it for a living?"];
  assert.equal(repeatsSomething(prev[0], prev), true);
  assert.equal(repeatsSomething("I bet you're good at it, I love vape smoke. What do you do for a living?", prev), true);
  assert.equal(repeatsSomething("you're a bad boy then x", prev), false);
  assert.equal(repeatsSomething("hey x", ["hey there x"]), false, "short greetings must not collide");
});

test("the model chain falls through an unavailable model instead of failing the chat", async () => {
  const calls = [];
  const env = {
    AI_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    AI: { run: async (model) => {
      calls.push(model);
      if (model === "@cf/meta/llama-3.3-70b-instruct-fp8-fast") throw new Error("5007: No such model");
      return { response: "  play with me then x  " };
    } },
  };
  const out = await generateReply(env, "system", [], "hi");
  assert.equal(out, "play with me then x");
  assert.equal(calls.length, 2);
  assert.equal(calls[0], "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
});

test("every model failing throws so the caller records a real error", async () => {
  const env = { AI: { run: async () => { throw new Error("boom"); } } };
  await assert.rejects(() => generateReply(env, "system", [], "hi"), /boom/);
});

test("the prompt names the lines already sent and the role-play rule", async () => {
  const { personaSystemPrompt } = await import("../src/tg.js");
  const prompt = personaSystemPrompt({ display_name: "Michaela", tone: "playful", emoji_level: "medium" }, {}, "", "", ["you're a bad boy x"]);
  assert.match(prompt, /You have already sent these lines in this chat/);
  assert.match(prompt, /you're a bad boy x/);
  assert.match(prompt, /Play along with absolutely anything he is into/);
  assert.match(prompt, /Never correct him/);
  assert.match(prompt, /Never answer a sexual instruction with what you sell/);
  assert.doesNotMatch(prompt, /I'm not your mummy/);
});

test("emoji and warmth survive the length rule", async () => {
  const { personaSystemPrompt } = await import("../src/tg.js");
  const prompt = personaSystemPrompt({ display_name: "Michaela", emoji_level: "medium" }, {}, "", "", []);
  assert.match(prompt, /Emoji: one or two in most messages/);
  assert.match(prompt, /same one twice in a row/);
  assert.match(prompt, /two short lines at most, under twenty words/);
  assert.doesNotMatch(prompt, /three to six words/);
});

test("DeepSeek is used first when its key is set, with thinking switched off", async () => {
  const realFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: "  hey you 😏  " } }] }), { status: 200 });
  };
  try {
    const env = { DEEPSEEK_API_KEY: "k", AI: { run: async () => { throw new Error("Workers AI should not be reached"); } } };
    const out = await generateReply(env, "sys", [], "hi");
    assert.equal(out, "hey you 😏");
    assert.match(seen.url, /api\.deepseek\.com/);
    assert.equal(seen.body.model, "deepseek-v4-pro");
    assert.deepEqual(seen.body.thinking, { type: "disabled" });
    assert.ok(seen.body.max_tokens <= 150);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a reply with no emoji gets one that fits, before the trailing x", () => {
  assert.equal(ensureEmoji("play with that cock x", "medium"), "play with that cock 🍆 x");
  assert.equal(ensureEmoji("i'm so horny for you", "medium"), "i'm so horny for you 🥵");
  assert.equal(ensureEmoji("you filthy boy", "medium"), "you filthy boy 😈");
  assert.equal(ensureEmoji("let me look at you", "medium"), "let me look at you 👀");
  assert.equal(ensureEmoji("already got one 😏", "medium"), "already got one 😏");
  assert.equal(ensureEmoji("hey x", "low"), "hey x");
});
