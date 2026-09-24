// Side-by-side review sheet for the on-chain message summaries.
//
// The Chinese summary is our own text; the English original is evidence. The point of
// this script is to make the pair reviewable by a human in one screen — the checks that
// can be automated (coverage, the reviewed flag, the file split) live in test-render.mjs.
//
//   node scripts/check-summaries.mjs            # 5 samples
//   node scripts/check-summaries.mjs --all      # every message
//   node scripts/check-summaries.mjs --n 12     # how many
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => JSON.parse(readFileSync(ROOT + p, "utf8").replace(/^\uFEFF/, ""));
const data = read("data/messages.json");
const zh = read("data/messages.zh.json");
const messages = data.messages || [];

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const all = process.argv.includes("--all");
const n = all ? messages.length : Number(argOf("--n", "5"));

const covered = messages.filter((m) => zh[String(m.block)]);
console.log(`messages: ${messages.length}  summaries: ${Object.keys(zh).filter((k) => !k.startsWith("_")).length}  covered: ${covered.length}`);
console.log(`reviewed=true: ${Object.values(zh).filter((v) => v && v.reviewed === true).length} (待人工校对时保持 false)\n`);

// One from each interesting category first, then fill up.
const picks = [];
const seen = new Set();
const take = (m) => {
  if (m && !seen.has(m.block)) {
    seen.add(m.block);
    picks.push(m);
  }
};
take(messages.find((m) => m.isDev));
take(messages.find((m) => m.important));
take(messages.find((m) => !m.isDev && !m.important));
take(messages.find((m) => /bot|burnExecutor/i.test(m.text)));
for (const m of messages) if (picks.length < n) take(m);

for (const m of picks.slice(0, n)) {
  const s = zh[String(m.block)];
  const tags = [m.isDev ? "团队" : "社区", m.important ? "重点" : ""].filter(Boolean).join(" · ");
  console.log(`── block ${m.block}  [${tags}]  ${new Date(m.ts * 1000).toISOString().slice(0, 16)}Z`);
  console.log(`   EN  ${String(m.text).replace(/\s+/g, " ").trim().slice(0, 220)}`);
  console.log(`   ZH  ${s ? s.summary : "(缺失)"}${s ? `   reviewed=${s.reviewed}` : ""}`);
  console.log("");
}

const missing = messages.filter((m) => !zh[String(m.block)]);
if (missing.length) {
  console.log(`缺摘要：${missing.map((m) => m.block).join(", ")}`);
  process.exitCode = 1;
}
