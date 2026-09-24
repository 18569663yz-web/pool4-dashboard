// Rewrite the remaining Chinese literals in app.js into tr("s.NNN", { p0: … }) calls.
//
// Works back-to-front by line number so earlier offsets stay valid as we edit.
// A literal that cannot be located is reported rather than silently skipped — a
// missed one would leave Chinese on the page.
//
// Two things differ from a naive search, both learned the hard way:
//   * the search starts at the literal's own line, never 2,000 characters before it.
//     Several rows in renderSources share the identical literal "以太坊" on consecutive
//     lines, and a backwards window made each replacement land on its neighbour.
//   * if the literal is not within a sane distance of its line, that is a failure, not
//     a hit. Otherwise a second run would happily rewrite some unrelated occurrence.
//
//   node scripts/apply-i18n.mjs [--dry] [--skeleton data/strings-i18n-2.json] [--keys s.1,s.2]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isBalanced } from "../lib/scan-strings.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(ROOT + p, "utf8").replace(/^\uFEFF/, ""));
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const dry = process.argv.includes("--dry");
const skeletonFile = argOf("--skeleton", "data/strings-i18n-2.json");
const only = argOf("--keys", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!existsSync(ROOT + skeletonFile)) {
  console.error(`no such skeleton: ${skeletonFile}`);
  process.exit(1);
}
const skeleton = readJson(skeletonFile);

const target = "assets/app.js";
let src = readFileSync(ROOT + target, "utf8");

const real = Object.entries(skeleton).filter(([k, e]) => e.raw && e.raw.length && (!only.length || only.includes(k)));
// newest line first, so replacing one does not shift the offsets of the ones before it
const entries = real.sort((a, b) => b[1].line - a[1].line);

const MAX_DISTANCE = 4000;
let done = 0;
const failed = [];
const moved = [];
const rejected = [];

for (const [key, e] of entries) {
  // Safety valve: a parameter that does not parse would be spliced into the call and
  // break app.js (this happened twice before the extractor learned about nested
  // template literals). Refuse it loudly instead of writing broken code.
  const bad = (e.params || []).find((p) => !isBalanced(p));
  if (bad) {
    rejected.push(`${key} (${e.fn}): ${bad.slice(0, 70)}`);
    continue;
  }

  const call = e.params.length
    ? `tr(${JSON.stringify(key)}, { ${e.params.map((p, i) => `p${i}: ${p}`).join(", ")} })`
    : `tr(${JSON.stringify(key)})`;

  const lines = src.split("\n");
  const before = lines.slice(0, Math.max(0, e.line - 1)).join("\n");
  const lineStart = e.line > 1 ? before.length + 1 : 0;

  let idx = -1;
  let len = 0;
  for (const q of ["`", '"', "'"]) {
    const marker = q + e.raw + q;
    const at = src.indexOf(marker, lineStart);
    if (at >= 0 && at - lineStart <= MAX_DISTANCE && (idx < 0 || at < idx)) {
      idx = at;
      len = marker.length;
    }
  }

  if (idx < 0) {
    failed.push({ key, line: e.line, fn: e.fn, zh: e.zh });
    continue;
  }
  const atLine = src.slice(0, idx).split("\n").length;
  if (atLine !== e.line) moved.push(`${key}: line ${e.line} -> ${atLine}`);
  src = src.slice(0, idx) + call + src.slice(idx + len);
  done++;
}

if (!dry) writeFileSync(ROOT + target, src);

console.log(`skeleton : ${skeletonFile}`);
console.log(`rewrote  : ${done} / ${entries.length}`);
console.log(`failed   : ${failed.length}`);
for (const f of failed) console.log(`  ${f.key} (line ${f.line}, ${f.fn})  ${f.zh.slice(0, 60)}`);
if (rejected.length) {
  console.log(`refused (needs a hand-written key): ${rejected.length}`);
  for (const r of rejected) console.log(`  ${r}`);
}
if (moved.length) {
  console.log(`line drift (found on a different line than recorded): ${moved.length}`);
  for (const m of moved.slice(0, 10)) console.log(`  ${m}`);
}
if (dry) console.log("\n(dry run — nothing written)");
