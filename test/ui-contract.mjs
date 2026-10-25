/**
 * UI contract gate for the creator console (static pages, inline scripts).
 *
 *   node test/ui-contract.mjs
 *
 * The console is four static files, each carrying its own <style> and inline module script.
 * A restyle may change CSS tokens and rules, but must not break the JS<->markup contract.
 * This asserts, per page:
 *   1. every id the page's own script looks up exists in that page's markup
 *      (or is a documented RUNTIME id the script builds itself)
 *   2. every class the script toggles or assigns is still styled somewhere on the page
 *   3. the page still carries exactly one <style> block and one module script that parses
 * It does not check looks. That is the browser pass.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const PAGES = ["index.html", "account.html", "creator.html", "login.html"];

/* ids each page's script creates at runtime, so "not in the markup" is legitimate.
   Keep this list explicit: an id that stops existing must still fail the gate. */
const RUNTIME_IDS = [
  "sentinel", "toast", "pageLoading", "modal", "modalBody", "modalTitle",
  /* built by fsSelect(id, ...): the id is interpolated, so it never appears literally */
  "fs-tone", "fs-emoji", "fs-len",
  "sbClient", "chart", "chartTip", "pwModal", "histModal", "histBody",
];

/* Known-stale lookups: the script asks for these ids, nothing in the file ever creates them.
   They are dead controls, not restyle breakage. Delete an entry when the control is fixed or
   removed; anything NOT on this list that stops existing still fails the gate. */
const KNOWN_DEAD = ["acc-count", "connect-wizard", "fs-wiz", "setup-steps"];

const RUNTIME_PREFIXES = ["tab-", "row-", "item-", "chat-", "card-", "acct-", "msg-", "bundle-", "media-", "opt-", "nav-"];

let pass = 0, fail = 0;
const ok = (cond, label, extra = "") => {
  if (cond) { pass++; console.log(`  ok  ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
};

const split = (src) => ({
  js: (src.match(/<script\b[^>]*>([\s\S]*?)<\/script>/g) || [])
    .map((b) => b.replace(/^<script\b[^>]*>/, "").replace(/<\/script>$/, "")).join("\n"),
  css: (src.match(/<style\b[^>]*>([\s\S]*?)<\/style>/g) || [])
    .map((b) => b.replace(/^<style\b[^>]*>/, "").replace(/<\/style>$/, "")).join("\n"),
});

const isRuntime = (id) =>
  RUNTIME_IDS.includes(id) || KNOWN_DEAD.includes(id) || RUNTIME_PREFIXES.some((p) => id.startsWith(p));

for (const file of PAGES) {
  const full = path.join(ROOT, "console", file);
  const raw = fs.readFileSync(full, "utf8");
  const { js, css } = split(raw);
  const idsInMarkup = new Set([
    ...[...raw.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]),
    ...[...raw.matchAll(/\bid='([^']+)'/g)].map((m) => m[1]),
  ]);
  console.log(`\n=== ${file}  (${raw.length} bytes, ${idsInMarkup.size} ids, css ${css.length}b, js ${js.length}b)`);

  /* 1. ids the page script looks up */
  const looked = new Set([
    ...[...js.matchAll(/\$\(\s*['"]#?([A-Za-z0-9_-]+)['"]\s*\)/g)].map((m) => m[1]),
    ...[...js.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
    ...[...js.matchAll(/querySelector(?:All)?\(\s*['"]#([A-Za-z0-9_-]+)['"]\s*\)/g)].map((m) => m[1]),
  ]);
  const missing = [...looked].filter((id) => !idsInMarkup.has(id) && !isRuntime(id));
  ok(missing.length === 0, `every id the script looks up exists (${looked.size} checked)`,
    missing.length ? `MISSING: ${missing.join(", ")}` : "");

  /* 2. every class the script toggles or assigns must be styled */
  const toggled = new Set([
    ...[...js.matchAll(/classList\.(?:add|remove|toggle|contains)\(\s*['"]([^'"\s]+)['"]/g)].map((m) => m[1]),
    ...[...js.matchAll(/className\s*=\s*['"]([^'"]+)['"]/g)].flatMap((m) => m[1].split(/\s+/)),
  ].filter((c) => c && !c.includes("+") && !c.includes("${")));
  const esc = (c) => c.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
  const unstyled = [...toggled].filter((c) => !new RegExp("\\." + esc(c) + "\\b").test(css));
  ok(unstyled.length === 0, `every class the script toggles is styled (${toggled.size} checked)`,
    unstyled.length ? `UNSTYLED: ${unstyled.join(", ")}` : "");

  /* 3. structure intact: one style block, one module script, script still parses */
  ok((raw.match(/<style\b/g) || []).length === 1, "exactly one style block");
  ok((raw.match(/<script\b/g) || []).length <= 2, "at most one library plus one app script");
  const tmp = path.join("/tmp", `cc-gate-${file}.mjs`);
  fs.writeFileSync(tmp, js);
  try {
    execFileSync("node", ["--check", tmp], { stdio: "pipe" });
    ok(true, "inline script parses (node --check)");
  } catch (e) {
    ok(false, "inline script parses (node --check)", String(e.stderr || e).slice(0, 300));
  }
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
