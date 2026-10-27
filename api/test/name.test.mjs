// The owner's complaint: he told her "Mark for now", then "Mark Miss", and was
// asked what his name was again three times. These lock the two causes: the
// name was never learned, and the prompt was never told what the customer row
// actually said.
import test from "node:test";
import assert from "node:assert/strict";
import { nameFromText, nameForChat, nameFromUsername, usableName, NAME_QUESTION } from "../src/tg.js";

test("the name he actually gave is learned", () => {
  assert.equal(nameFromText("Mark for now. You're Michaela?", false), "Mark");
  assert.equal(nameFromText("Mark Miss.", false), "Mark");
  assert.equal(nameFromText("mark", true), "Mark");
  assert.equal(nameFromText("I'm Mark", false), "Mark");
  assert.equal(nameFromText("call me mark x", false), "Mark");
  assert.equal(nameFromText("my name's Tony", false), "Tony");
});

test("a bare word is only a name when she asked for one", () => {
  assert.equal(nameFromText("mark", false), null);
  assert.equal(nameFromText("anything", true), null);
  assert.equal(nameFromText("Please Miss, what can I do?", false), null);
  assert.equal(nameFromText("I'm on my knees for you", true), null);
  assert.equal(nameFromText("Yes Miss. I'm on my knees", true), null);
});

test("a profile that is not a name is not used", () => {
  assert.equal(usableName("Me"), null);
  assert.equal(usableName("Kinkster74"), null);
  assert.equal(usableName(""), null);
  assert.equal(nameForChat({ first_name: "Me", username: "Kinkster74" }), null);
  assert.equal(nameForChat({ first_name: "Me", flags: { learned_name: "Mark" } }), "Mark");
  assert.equal(nameForChat({ first_name: "Tony" }), "Tony");
});

test("the username is used when it holds a name, and only then", () => {
  assert.equal(nameFromUsername("mark74"), "Mark");
  assert.equal(nameFromUsername("mark_smith"), "Mark");
  assert.equal(nameFromUsername("Tony1962"), "Tony");
  assert.equal(nameFromUsername("johnnyboy"), "Johnny");
  assert.equal(nameFromUsername("Kinkster74"), null);
  assert.equal(nameFromUsername("darkwolf88"), null);
  assert.equal(nameFromUsername(""), null);
});

test("the name question is recognised in every wording she uses", () => {
  assert.match("good boy... now what's your name? 😘 x", NAME_QUESTION);
  assert.match("hey you, what shall i call you? 😏", NAME_QUESTION);
  assert.match("you still not told me what to call you 👀", NAME_QUESTION);
  assert.doesNotMatch("you're a bad boy x", NAME_QUESTION);
});
