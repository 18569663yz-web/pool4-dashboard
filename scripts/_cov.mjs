import { readFileSync } from "node:fs";
const src = readFileSync("assets/app.js", "utf8");
const CJK = /[\u4e00-\u9fff]/;
const re = /`([^`\\]*(?:\\.[^`\\]*)*)`|'([^'\\\n]*(?:\\.[^'\\\n]*)*)'|"([^"\\\n]*(?:\\.[^"\\\n]*)*)"/g;
let m, total = 0, migrated = 0, remaining = [];
while ((m = re.exec(src)) !== null) {
  const lit = m[1] ?? m[2] ?? m[3] ?? "";
  if (!CJK.test(lit)) continue;
  total++;
  // a literal that is only a key reference (tr("x")) is not Chinese copy any more
  remaining.push({ line: src.slice(0, m.index).split("\n").length, lit: lit.replace(/\s+/g, " ").slice(0, 58) });
}
const zh = JSON.parse(readFileSync("locales/zh.json", "utf8"));
const keys = Object.keys(zh).filter(k => !k.startsWith("_"));
console.log(`locales/zh.json keys        : ${keys.length}`);
console.log(`Chinese literals in app.js  : ${total}`);
console.log(`=> still to migrate         : ~${total}  (${(total / (total + keys.length) * 100).toFixed(0)}% of total copy)`);
console.log(`\nfirst 12 still untranslated:`);
for (const r of remaining.slice(0, 12)) console.log(`  app.js:${r.line}  ${r.lit}`);
