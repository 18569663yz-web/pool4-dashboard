import { readFileSync } from "node:fs";
import { decodeMessage, explainUndecodable } from "../lib/decode-message.js";
const raw = readFileSync("data/_txs.json", "utf8").replace(/^\uFEFF/, "");
const txs = JSON.parse(raw);
const DEV = new Set(["0x200e710acaa6a93bbc77146026328c40f1d60fb1", "0x047f606fd5b2baa5f5c6c4ab8958e45cb6b054b7"]);
const ok = [], bad = [];
for (const it of txs) { const t = decodeMessage(it.raw_input); (t === null ? bad : ok).push({ it, t }); }
console.log(`total txs  : ${txs.length}`);
console.log(`decoded    : ${ok.length}`);
console.log(`undecodable: ${bad.length}`);
console.log("\n=== the undecodable ones ===");
for (const { it } of bad) {
  const r = it.raw_input || "0x";
  console.log(`block ${it.block_number} ${String(it.timestamp).slice(0,10)} | ${explainUndecodable(r)} | to=${it.to?.hash === it.from?.hash ? "self" : "external"} method=${it.method || "none"}`);
}
const dev = ok.filter(({it}) => DEV.has(String(it.from?.hash||"").toLowerCase()));
console.log(`\nfrom dev  : ${dev.length}`);
console.log(`community : ${ok.length - dev.length}`);
const byText = new Map();
for (const { it, t } of ok) { const k = t.trim(); if (!byText.has(k)) byText.set(k, []); byText.get(k).push(+it.block_number); }
console.log(`distinct texts: ${byText.size} (from ${ok.length} txs) -> ${ok.length - byText.size} exact duplicates`);
const dupes = [...byText.entries()].filter(([,v]) => v.length > 1);
for (const [text, blocks] of dupes.slice(0,8)) console.log(`  x${blocks.length} "${text.slice(0,55).replace(/\n/g," ")}"`);
