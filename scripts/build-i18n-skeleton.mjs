// Build the i18n skeleton for the remaining Chinese literals.
//
// Numbered keys (s.001 …) are deliberate: the literals repeat themselves across
// functions and a slug-based key collides constantly. Traceability comes from the
// recorded fn/line, not from the key name.
//
// For each literal this extracts the ${...} expressions into ordered parameters, so
//   `池子 ${fmt18(d.held, 2)} ≤ 触发线 ${fmt18(d.cap, 0)}`
// becomes
//   zh: "池子 {p0} ≤ 触发线 {p1}"   params: ["fmt18(d.held, 2)", "fmt18(d.cap, 0)"]
// and the rewriter can emit tr("s.123", { p0: fmt18(d.held, 2), p1: fmt18(d.cap, 0) }).
//
//   node scripts/build-i18n-skeleton.mjs
//
// Second pass (after the first batch of keys was already applied to app.js) must NOT
// renumber from s.001 — those keys are live in the source. Pass --start/--out to write
// a separate skeleton for the leftovers:
//
//   node scripts/build-i18n-skeleton.mjs --start 393 --out data/strings-i18n-2.json --list
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { templateToZh, isBalanced } from "../lib/scan-strings.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const todo = JSON.parse(readFileSync(ROOT + "data/strings-todo.json", "utf8"));

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const START = Number(argOf("--start", "1"));
const OUT = argOf("--out", "data/strings-i18n.json");

/** The scanner's regex swallowed a few huge code blocks — skip them. */
const isRunaway = (lit) => lit.length > 400 || /\bfunction\b/.test(lit) || /\bconst \w+ =/.test(lit);

const out = {};
let n = 0;
let skipped = 0;
for (const row of todo.rows) {
  if (isRunaway(row.literal)) {
    skipped++;
    continue;
  }
  n++;
  const key = "s." + String(START + n - 1).padStart(3, "0");
  const { zh, params } = templateToZh(row.literal);
  // A parameter that does not parse is worse than an untranslated string: it would be
  // spliced into a tr() call and break the page. Flag it for a hand-written key instead.
  const broken = params.filter((p) => !isBalanced(p));
  out[key] = {
    fn: row.fn,
    line: row.line,
    file: row.file,
    params,
    raw: row.literal,
    zh,
    en: "",
    ...(broken.length ? { needsHandWrittenKey: true } : {}),
  };
}

writeFileSync(ROOT + OUT, JSON.stringify(out, null, 2));
console.log(`wrote ${OUT} (keys s.${String(START).padStart(3, "0")} … s.${String(START + n - 1).padStart(3, "0")})`);
console.log(`  entries : ${Object.keys(out).length}`);
console.log(`  skipped : ${skipped} (runaway regex matches)`);
console.log(`  with params: ${Object.values(out).filter((e) => e.params.length).length}`);
console.log(`  with HTML  : ${Object.values(out).filter((e) => /<[a-z][^>]*>/i.test(e.zh)).length}`);
console.log(`  max params : ${Math.max(...Object.values(out).map((e) => e.params.length))}`);
const handwritten = Object.entries(out).filter(([, e]) => e.needsHandWrittenKey);
console.log(`  need a hand-written key: ${handwritten.length}${handwritten.length ? " -> " + handwritten.map(([k]) => k).join(", ") : ""}`);
for (const [k, e] of handwritten) console.log(`     ${k} [${e.fn}]: ${e.raw.slice(0, 90)}`);

// print in a compact form so the translations can be written in one pass
if (process.argv.includes("--list")) {
  for (const [k, e] of Object.entries(out)) {
    console.log(`${k}|${e.zh.replace(/\s+/g, " ").replace(/\|/g, "¦")}`);
  }
}
