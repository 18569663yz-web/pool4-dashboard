// Step 1 of clearing the Chinese literals out of app.js.
//
// Scans for Chinese string literals (NOT comments) and writes a reviewable worklist
// to data/strings-todo.json. Review it before touching code — translating while
// editing always misses some.
//
//   node scripts/extract-strings.mjs            # summary
//   node scripts/extract-strings.mjs --write    # write data/strings-todo.json
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { scanChineseLiterals } from "../lib/scan-strings.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FILES = ["assets/app.js", "index.html"];

const rows = [];
for (const file of FILES) {
  const src = readFileSync(ROOT + file, "utf8");
  for (const r of scanChineseLiterals(src)) {
    rows.push({
      file,
      line: r.line,
      fn: r.fn,
      literal: r.literal,
      interpolated: /\$\{/.test(r.literal),
      html: /<[a-z][^>]*>/i.test(r.literal),
      runaway: false,
      translate: !r.runaway,
    });
  }
}

const real = rows.filter((r) => !r.runaway);
const byFn = real.reduce((a, r) => ((a[r.fn] = (a[r.fn] || 0) + 1), a), {});

console.log(`Chinese literals outside comments : ${rows.length}`);
console.log(`  real (needs migrating)           : ${real.length}`);
console.log(`  runaway regex matches (ignore)   : ${rows.length - real.length}`);
if (real.length) {
  console.log(`\nby function:`);
  for (const [fn, n] of Object.entries(byFn).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${fn}`);
  }
}

if (process.argv.includes("--write")) {
  mkdirSync(ROOT + "data", { recursive: true });
  writeFileSync(ROOT + "data/strings-todo.json", JSON.stringify({ generatedAt: new Date().toISOString(), total: rows.length, real: real.length, rows }, null, 2));
  console.log(`\nwrote data/strings-todo.json (${rows.length} rows)`);
} else if (real.length) {
  console.log(`\nfirst 12:`);
  for (const r of real.slice(0, 12)) {
    console.log(`  ${r.file}:${r.line} [${r.fn}] ${r.literal.replace(/\s+/g, " ").slice(0, 56)}`);
  }
}