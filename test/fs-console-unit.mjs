/**
 * Unit harness for the FabSwingers console code, run without a browser.
 *
 *   node test/fs-console-unit.mjs
 *
 * The signed-in console cannot be driven by the automation browser reliably (the page
 * pegs the main thread there, on the live site too), so the new wiring is exercised
 * here instead: the fields render, the wizard steps render, and the save calls build
 * the payloads the API expects.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const html = fs.readFileSync(path.join(ROOT, "console", "index.html"), "utf8");

const sliceBetween = (start, end) => {
  const a = html.indexOf(start);
  const b = html.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`could not slice ${start} .. ${end}`);
  return html.slice(a, b);
};

const fsBlock = sliceBetween("/* ---------- FabSwingers ---------- */", "/* ---------- Library ---------- */");
const wizBlock = sliceBetween("function wizStep(", "function wizFinish(");

let pass = 0, fail = 0;
const ok = (cond, label, extra = "") => {
  if (cond) { pass++; console.log(`  ok  ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
};

/* ---- stubs the console provides at runtime ---- */
const elements = new Map();
const el = (id) => {
  if (!elements.has(id)) elements.set(id, { id, value: "", textContent: "", innerHTML: "", style: {}, classList: { add() {}, remove() {} } });
  return elements.get(id);
};
const calls = [];
const ctx = {
  state: { session: { access_token: "test-token" } },
  location: { hostname: "127.0.0.1" },
  $: (sel) => (String(sel).startsWith("#") ? el(String(sel).slice(1)) : null),
  esc: (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])),
  ic: (n) => `<svg data-ic="${n}"></svg>`,
  toast: (m, k) => calls.push(["toast", m, k]),
  spinner: () => "<spinner>",
  empty: () => "<empty>",
  errorState: (e) => `<err>${String(e && e.message ? e.message : e)}</err>`,
  ownerPicker: () => "",
  secHead: (s) => `<head>${s}</head>`,
  setView: (h) => { ctx.__view = h; },
  loadAccounts: () => {},
  openAccount: (id) => calls.push(["openAccount", id]),
  Data: { list: async () => ({ rows: [] }) },
  withBusy: async (btn, fn) => { try { const r = await fn(); return r ?? true; } catch (e) { calls.push(["busyError", e.message]); return false; } },
  fetch: async (url, opts) => {
    calls.push(["fetch", url, opts && opts.method, opts && opts.body ? JSON.parse(opts.body) : null]);
    return { ok: true, status: 200, json: async () => ({ ok: true, accounts: [], persona: null }) };
  },
};

const src = `
${fsBlock}
${wizBlock}
return { fsLoginFields, fsPersonaFields, fsSelect, wizStep, fsSaveLogin, fsSavePersona, fsCall, renderFabSwingers, loadFabSwingers, fsAccountPanel, fsEdit, fsLinkPicker };
`;
const api = new Function(...Object.keys(ctx), src)(...Object.values(ctx));

/* ---- 1. the login fields ---- */
let h = api.fsLoginFields(null, "michelle0161");
ok(h.includes('id="fs-username"'), "login fields render the username input");
ok(h.includes('id="fs-password"'), "login fields render the password input");
ok(h.includes('id="fs-tg"'), "login fields render the Telegram handle input");
ok(h.includes('value="michelle0161"'), "the handle is prefilled from the bot username");
ok(!/undefined/.test(h), "no undefined leaks into the markup");

h = api.fsLoginFields({ username: "her_fs", telegram_username: "her_tg" }, "ignored");
ok(h.includes('value="her_fs"') && h.includes('value="her_tg"'), "an existing login populates both fields");
ok(h.includes("Leave blank to keep the saved one"), "an existing login says the password can stay blank");

/* ---- 2. the personality fields ---- */
h = api.fsPersonaFields({ tone: "flirty", emoji_level: "high", message_length: "short", system_prompt: "be her", pivot_message: "add me" });
ok(h.includes('id="fs-tone"') && h.includes('id="fs-emoji"') && h.includes('id="fs-len"'), "personality renders all three selects");
ok(h.includes('id="fs-prompt"') && h.includes('id="fs-pivot"'), "personality renders both text areas");
ok(/<option value="flirty" selected>/.test(h), "the saved tone is preselected");
ok(/<option value="high" selected>/.test(h), "the saved emoji level is preselected");
ok(h.includes("be her") && h.includes("add me"), "saved prompt and pivot text are shown");

/* ---- 3. the wizard steps ---- */
api.wizStep(2);
ok(el("wiz-body").innerHTML.includes('data-form="fs-login-wiz"'), "step 2 is the FabSwingers login form");
ok(el("wiz-body").innerHTML.includes('data-act="wiz-skip"'), "step 2 can be skipped");
ok(el("wiz-count").textContent === "Step 2 of 3", "step 2 says which step it is");
api.wizStep(3);
ok(el("wiz-body").innerHTML.includes('data-form="fs-persona-wiz"'), "step 3 is the personality form");
ok(el("wiz-body").innerHTML.includes('data-act="wiz-finish"'), "step 3 can be finished without saving");

/* ---- 4. the save paths build the right payloads ---- */
calls.length = 0;
el("fs-username").value = "her_fs";
el("fs-password").value = "pw123";
el("fs-tg").value = "@her_tg";
const savedLogin = await api.fsSaveLogin("acct-1", null);
const loginCall = calls.find((c) => c[0] === "fetch");
ok(!!savedLogin, "login save resolves");
ok(loginCall && loginCall[1].endsWith("/fabswingers"), "login save posts to /fabswingers");
ok(loginCall && loginCall[3].telegram_account_id === "acct-1", "login save carries the bot account id");
ok(loginCall && loginCall[3].telegram_username === "@her_tg", "login save sends the handle as typed");
ok(calls.some((c) => c[0] === "toast" && c[2] === "success"), "login save confirms with a toast");

calls.length = 0;
el("fs-tone").value = "sassy";
el("fs-emoji").value = "low";
el("fs-len").value = "long";
el("fs-prompt").value = "  her voice  ";
el("fs-pivot").value = "";
await api.fsSavePersona("acct-1", null);
const personaCall = calls.find((c) => c[0] === "fetch");
ok(personaCall && personaCall[1].endsWith("/fabswingers/persona"), "persona save posts to /fabswingers/persona");
ok(personaCall && personaCall[3].method === undefined, "persona save sends a body");
ok(personaCall && personaCall[3].tone === "sassy", "persona save sends the tone");
ok(personaCall && personaCall[3].system_prompt === "her voice", "persona save trims the instructions");
ok(personaCall && personaCall[3].pivot_message === null, "an empty pivot is sent as null");

/* ---- 5. the list renders a linked account with working actions ---- */
ctx.Data.list = async () => ({ rows: [{ id: "acct-1", username: "Michelle0161bot", first_name: "Michelle", creator_id: "owner" }] });
ctx.state.sb = { from: () => ({ select: async () => ({ data: [{ id: "fs-1", telegram_account_id: "acct-1", username: "her_fs", telegram_username: "her_tg", enabled: true, created_at: new Date().toISOString() }] }) }) };
elements.set("fs-list", { id: "fs-list", innerHTML: "", classList: { add() {}, remove() {} } });
await api.loadFabSwingers();
const listHtml = el("fs-list").innerHTML;
ok(listHtml.includes("her_fs"), "the list shows the FabSwingers username");
ok(listHtml.includes("@Michelle0161bot"), "the list shows which bot account owns it");
ok(listHtml.includes('data-act="fs-edit"') && listHtml.includes('data-act="fs-toggle"') && listHtml.includes('data-act="fs-remove"'),
  "every row carries edit, pause and remove");
ok(listHtml.includes('class="pill ok"'), "an enabled account reads as On");
ok(!/undefined/.test(listHtml), "no undefined leaks into the list");

/* ---- 6. guards ---- */
calls.length = 0;
el("fs-username").value = "";
el("fs-tg").value = "";
const guarded = await api.fsSaveLogin("acct-1", null);
ok(guarded === null, "login save refuses without a username");
ok(calls.some((c) => c[0] === "toast" && c[2] === "error"), "the refusal is explained to the operator");

const oldToken = ctx.state.session;
ctx.state.session = null;
let threw = "";
try { await api.fsCall("/fabswingers"); } catch (e) { threw = e.message; }
ctx.state.session = oldToken;
ok(/session/i.test(threw), "an expired session says so instead of failing silently");

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
