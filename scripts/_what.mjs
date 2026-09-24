import { readFileSync } from "node:fs";
const h = JSON.parse(readFileSync("data/history.json","utf8"));
const E18 = 10n**18n;
const fmt = (v,d=4) => { const neg=v<0n; const a=neg?-v:v; const w=a/E18; const f=(a%E18).toString().padStart(18,"0").slice(0,d); return (neg?"-":"")+w.toString().replace(/\B(?=(\d{3})+(?!\d))/g,",")+(d?"."+f:""); };
console.log("=== CapFloorUpdated (all) ===");
for (const l of h.events.CapFloorUpdated.logs) {
  const d = l.data.replace(/^0x/,"");
  const prev = BigInt("0x"+d.slice(0,64)), next = BigInt("0x"+d.slice(64,128));
  console.log(`  block ${parseInt(l.blockNumber,16)}  ${fmt(prev)} -> ${fmt(next)}  tx ${l.transactionHash.slice(0,20)}…`);
}
console.log("\n=== CapDecayUpdated (all) ===");
for (const l of h.events.CapDecayUpdated.logs) {
  const d = l.data.replace(/^0x/,"");
  console.log(`  block ${parseInt(l.blockNumber,16)}  -> ${fmt(BigInt("0x"+d.slice(0,64)),0)} IMD/day`);
}
console.log("\n=== last 12 Trimmed ===");
const t = h.events.Trimmed.logs.slice(-12);
for (const l of t) {
  const d = l.data.replace(/^0x/,"");
  const w = i => BigInt("0x"+d.slice(i*64,(i+1)*64));
  console.log(`  block ${parseInt(l.blockNumber,16)}  burned=${fmt(w(1),4).padStart(12)}  rewarded=${fmt(w(2),4).padStart(10)}  eth=${fmt(w(3),6)}`);
}
console.log("\n=== trim count by era ===");
const all = h.events.Trimmed.logs.map(l=>parseInt(l.blockNumber,16));
const before = all.filter(b=>b<26037950).length;
const after = all.filter(b=>b>=26037950).length;
console.log(`  before capFloor change (block 26037950): ${before}`);
console.log(`  after:                                   ${after}`);
console.log(`  last trim block: ${all[all.length-1]}   head: ${h.head}   gap: ${h.head-all[all.length-1]} blocks`);
const sumBurn = h.events.Trimmed.logs.reduce((s,l)=>{const d=l.data.replace(/^0x/,"");return s+BigInt("0x"+d.slice(64,128));},0n);
const sumRew  = h.events.Trimmed.logs.reduce((s,l)=>{const d=l.data.replace(/^0x/,"");return s+BigInt("0x"+d.slice(128,192));},0n);
console.log(`\n  Σ Trimmed.burned   = ${fmt(sumBurn)}`);
console.log(`  Σ Trimmed.rewarded = ${fmt(sumRew)}`);
