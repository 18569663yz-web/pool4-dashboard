// Why 70 decoded messages and not some other number?
//
// Re-fetches the message board and classifies every transaction, so the count can be
// explained rather than asserted. Read-only.
//
//   node scripts/diagnose-messages.mjs
import { decodeMessage } from "./fetch-messages.mjs";
import { ADDR } from "../lib/contracts.js";

const BASE = `https://eth.blockscout.com/api/v2/addresses/${ADDR.messages}/transactions`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const items = [];
let url = BASE;
let page = 0;
while (url && page < 20) {
  let j = null;
  for (let attempt = 0; attempt < 5 && !j; attempt++) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" } });
      if (r.status === 429) {
        await sleep(3000 * (attempt + 1));
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      j = await r.json();
    } catch (e) {
      console.log(`  page ${page + 1} attempt ${attempt + 1} failed: ${e.message}`);
      if (attempt === 4) throw e;
      await sleep(2500 * (attempt + 1));
    }
  }
  const batch = j.items || [];
  items.push(...batch);
  page++;
  if (!j.next_page_params || batch.length === 0) break;
  url = BASE + "?" + new URLSearchParams(j.next_page_params).toString();
  await sleep(700);
}

console.log(`fetched ${items.length} transactions across ${page} page(s)\n`);

const ok = [];
const bad = [];
for (const it of items) {
  const t = decodeMessage(it.raw_input);
  if (t === null) bad.push(it);
  else ok.push({ it, t });
}

console.log(`decoded    : ${ok.length}`);
console.log(`undecodable: ${bad.length}\n`);

console.log("=== the undecodable ones, in full ===");
for (const it of bad) {
  const raw = it.raw_input || "0x";
  console.log(`\nblock ${parseInt(it.block_number, 10)}  ${it.timestamp}`);
  console.log(`  from   : ${it.from && it.from.hash}`);
  console.log(`  to     : ${it.to && it.to.hash}`);
  console.log(`  method : ${it.method || "(none)"}`);
  console.log(`  calldata length: ${(raw.length - 2) / 2} bytes`);
  console.log(`  calldata head  : ${raw.slice(0, 74)}`);
  const hex = raw.slice(2);
  const printable = hex.replace(/[^0-9a-f]/gi, "").length;
  const ascii = hex.match(/../g)?.map((b) => {
    const n = parseInt(b, 16);
    return n >= 32 && n < 127 ? String.fromCharCode(n) : ".";
  }).join("") || "";
  console.log(`  as ascii: ${ascii.slice(0, 90)}`);
}

// duplicates?
const byText = new Map();
for (const { it, t } of ok) {
  const k = t.trim();
  if (!byText.has(k)) byText.set(k, []);
  byText.get(k).push(parseInt(it.block_number, 10));
}
const dupes = [...byText.entries()].filter(([, v]) => v.length > 1);
console.log(`\n=== duplicates ===`);
console.log(`distinct texts: ${byText.size}  (from ${ok.length} decoded txs)`);
console.log(`texts appearing more than once: ${dupes.length}`);
for (const [text, blocks] of dupes.slice(0, 10)) {
  console.log(`  x${blocks.length} @ ${blocks.join(", ")}  "${text.slice(0, 60).replace(/\n/g, " ")}"`);
}

const DEV = new Set(["0x200e710acaa6a93bbc77146026328c40f1d60fb1", "0x047f606fd5b2baa5f5c6c4ab8958e45cb6b054b7"]);
const dev = ok.filter(({ it }) => DEV.has(String(it.from?.hash || "").toLowerCase()));
console.log(`\nfrom dev  : ${dev.length}`);
console.log(`from others: ${ok.length - dev.length}`);
console.log(`\nblock range: ${Math.min(...ok.map(({ it }) => parseInt(it.block_number, 10)))} .. ${Math.max(...ok.map(({ it }) => parseInt(it.block_number, 10)))}`);
