// Terminology check: the same key must use the same term in both languages.
//
// A bilingual dashboard drifts in a specific way — one paragraph calls it a "waypoint
// contract", the next calls it a "relay", and the Chinese side quietly says 中转合约 in
// both. This walks an agreed glossary across every locale entry and reports entries
// where the Chinese uses a term and the English does not use its counterpart.
//
//   node scripts/check-terminology.mjs            # summary + exit code
//   node scripts/check-terminology.mjs --sample   # 10 side-by-side examples
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => JSON.parse(readFileSync(ROOT + p, "utf8").replace(/^\uFEFF/, ""));
const zh = read("locales/zh.json");
const en = read("locales/en.json");

/** [Chinese, English, note?] — the agreed table, kept next to the check that enforces it.
 *  The English side is a pattern: inflections and hyphenation differ legitimately
 *  ("trigger line" / "Trigger-line floor"), but the term itself must be there. */
export const GLOSSARY = [
  ["烧毁引擎", "burn engine"],
  ["点火距离", "ignition distance"],
  ["烧毁触发线", "burn trigger line"],
  ["当前待烧毁量", "pending trim"],
  ["触发线只降不升", "ratchet"],
  ["价格下限保护", "backstop"],
  ["抽走并烧毁", "trim[ -]and[ -]burn|pulled out and burned"],
  ["两道门", "two doors"],
  ["质押金库", "staking vault"],
  ["席位", "seat"],
  ["节点", "daemon|node"],
  ["链上留言", "on-chain message"],
  ["owner 权限", "owner power|powers"],
  ["账面兑换率", "redemption rate"],
  ["触发线", "trigger[ -]?line|\\bthe line\\b"],
  ["中转合约", "waypoint contract"],
  ["待桥接", "awaiting (a )?bridge|waiting to be bridged|queued for (the )?bridg"],
  ["销毁", "burn|destr"],
  ["适配器", "adapter"],
];

const entries = Object.entries(zh).filter(([k]) => !k.startsWith("_"));
const rows = [];
for (const [zhTerm, enPattern] of GLOSSARY) {
  const re = new RegExp(enPattern, "i");
  const zhHits = entries.filter(([, v]) => String(v).includes(zhTerm));
  const unpaired = zhHits.filter(([k]) => !re.test(String(en[k] || "")));
  rows.push({ zhTerm, enPattern, zhHits, unpaired });
}

const used = rows.filter((r) => r.zhHits.length);
const broken = rows.filter((r) => r.unpaired.length);

console.log(`glossary terms in use : ${used.length} / ${GLOSSARY.length}`);
for (const r of rows) {
  const status = r.zhHits.length === 0 ? "not used" : r.unpaired.length ? `MISMATCH x${r.unpaired.length}` : `ok x${r.zhHits.length}`;
  console.log(`  ${r.zhTerm.padEnd(12)} -> ${r.enPattern.padEnd(28)} ${status}`);
}

if (broken.length) {
  const all = process.argv.includes("--all");
  console.log("\nentries where the term does not carry across:");
  for (const r of broken) {
    console.log(`\n  [${r.zhTerm} -> ${r.enPattern}]  ${r.unpaired.length} entries`);
    for (const [k, v] of r.unpaired.slice(0, all ? 200 : 3)) {
      console.log(`    ${k}`);
      console.log(`      zh: ${String(v).replace(/<[^>]+>/g, "").slice(0, 110)}`);
      console.log(`      en: ${String(en[k] || "").replace(/<[^>]+>/g, "").slice(0, 110)}`);
    }
  }
}

if (process.argv.includes("--sample")) {
  console.log("\n10 side-by-side samples");
  let n = 0;
  for (const r of used) {
    const [k, v] = r.zhHits[0];
    if (n++ >= 10) break;
    console.log(`\n[${r.zhTerm} = ${r.enPattern}]  key ${k}`);
    console.log(`  zh: ${String(v).replace(/<[^>]+>/g, "").slice(0, 150)}`);
    console.log(`  en: ${String(en[k] || "").replace(/<[^>]+>/g, "").slice(0, 150)}`);
  }
}

process.exit(broken.length ? 1 : 0);
