// Step 1 of the bilingual work: extract every Chinese literal so it can be reviewed
// BEFORE any code is rewritten. Editing and translating at the same time always
// leaves gaps.
//
//   node scripts/extract-i18n.mjs [--json]
//
// Output: a table of (file, line, suggested key, literal) plus a summary of how many
// are UI copy vs. things that must NEVER be translated (addresses, function names,
// identifiers embedded in otherwise-Chinese strings).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CJK = /[\u4e00-\u9fff]/;

/** Strings that must never be translated, even inside Chinese copy. */
const NEVER_TRANSLATE = [
  /\b0x[0-9a-fA-F]{6,}\b/g, // addresses / hashes
  /\b[A-Za-z_][A-Za-z0-9_]*\(\)/g, // function calls
  /\bL\d+(-\d+)?\b/g, // source line refs
  /\b(?:inventoryCap|capFloor|capDecayTokensPerDay|ratchetBps|rewardShareBps|minTrimTokens|pendingTrim|tokensInPool|burnClaims|rewardClaims|retainedEth|backstopEthPrincipal|drippable|canDrip|totalBurned|totalRewarded|marketOpen|closeMarket|rescueERC20|setPaused|emergencyWithdraw|rescueToken|setPeer|setBaseBurnReceiver|setBridgeConfig|inventoryCap|originalRequest|launchesLive)\b/g,
  /\b(?:IMD|ETH|bps|sIMD|USDC|UTC|APR|NFT|LP|ERC-?\d+|hook|owner|keeper|backstop|trim|ratchet|cap|tick|floor|daemon|seat)\b/g,
  /\b[0-9][0-9,]*(?:\.[0-9]+)?\b/g,
  /https?:\/\/\S+/g,
];

const files = ["assets/app.js", "index.html"];
const rows = [];

/** Collect every string/template literal that contains CJK. */
function scan(file) {
  const text = readFileSync(ROOT + file, "utf8");
  const lines = text.split("\n");
  const out = [];
  // naive but effective: pull anything between backticks, single or double quotes
  const re = /`([^`\\]*(?:\\.[^`\\]*)*)`|'([^'\\\n]*(?:\\.[^'\\\n]*)*)'|"([^"\\\n]*(?:\\.[^"\\\n]*)*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const lit = m[1] ?? m[2] ?? m[3] ?? "";
    if (!CJK.test(lit)) continue;
    const line = text.slice(0, m.index).split("\n").length;
    out.push({ file, line, literal: lit.replace(/\\n/g, " ").trim() });
  }
  return out;
}

for (const f of files) rows.push(...scan(f));

/** Suggest a flat key from the surrounding code. */
function suggestKey(row, idx) {
  const src = readFileSync(ROOT + row.file, "utf8").split("\n");
  // look upward for a function name
  let fn = "";
  for (let i = row.line - 1; i >= 0 && i > row.line - 60; i--) {
    const m = src[i].match(/function\s+([A-Za-z0-9_]+)/);
    if (m) {
      fn = m[1].replace(/^render/, "").replace(/^build/, "").toLowerCase();
      break;
    }
  }
  const scope = fn || (row.file === "index.html" ? "html" : "misc");
  return `${scope}.${String(idx).padStart(3, "0")}`;
}

const seen = new Map();
for (const r of rows) {
  const key = suggestKey(r, seen.size + 1);
  r.key = key;
  r.neverTranslate = [];
  for (const re of NEVER_TRANSLATE) {
    const hits = r.literal.match(re);
    if (hits) r.neverTranslate.push(...hits);
  }
  r.neverTranslate = [...new Set(r.neverTranslate)];
  seen.set(key, r);
}

const byFile = rows.reduce((a, r) => ((a[r.file] = (a[r.file] || 0) + 1), a), {});
console.log("=== Chinese literals found ===");
for (const [f, n] of Object.entries(byFile)) console.log(`  ${f.padEnd(18)} ${n}`);
console.log(`  ${"TOTAL".padEnd(18)} ${rows.length}`);

const withIds = rows.filter((r) => r.neverTranslate.length);
console.log(`\n  of which embed untranslatable identifiers: ${withIds.length}`);

if (process.argv.includes("--json")) {
  writeFileSync(ROOT + "locales/_extracted.json", JSON.stringify(rows, null, 2));
  console.log("\nwrote locales/_extracted.json");
} else {
  console.log("\n=== first 60 (file:line · suggested key · literal) ===");
  for (const r of rows.slice(0, 60)) {
    const ids = r.neverTranslate.length ? `   [keep: ${r.neverTranslate.slice(0, 3).join(" ")}]` : "";
    console.log(`  ${r.file}:${r.line}  ${r.key.padEnd(22)} ${r.literal.slice(0, 62)}${ids}`);
  }
  console.log(`\n… ${rows.length - 60} more. Run with --json to dump all.`);
}
