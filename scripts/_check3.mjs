import { readFileSync } from "node:fs";
const j = JSON.parse(readFileSync("data/messages.json","utf8"));
const want = [25901450, 25892951, 25890127];
console.log("total messages:", j.messages.length, "| counts:", JSON.stringify(j.counts));
const blocks = new Set(j.messages.map(m => m.block));
for (const b of want) {
  const m = j.messages.find(x => x.block === b);
  console.log(`\n--- block ${b}: ${m ? "FOUND" : "*** MISSING ***"}`);
  if (m) { console.log(`    dev=${m.isDev} self=${m.selfSend} ts=${new Date(m.ts*1000).toISOString()}`); console.log("    " + m.text.replace(/\n/g,"\n    ").slice(0,700)); }
}
console.log("\n=== block range present ===");
const sorted = [...blocks].sort((a,b)=>a-b);
console.log("  min:", sorted[0], " max:", sorted[sorted.length-1]);
console.log("  count in [25890000, 25902000]:", sorted.filter(b=>b>=25890000&&b<=25902000).length);
console.log("\n=== all blocks in that window ===");
for (const b of sorted.filter(b=>b>=25890000&&b<=25902000)) {
  const m = j.messages.find(x=>x.block===b);
  console.log(`  ${b}  ${new Date(m.ts*1000).toISOString()}  ${m.text.slice(0,70).replace(/\n/g," ")}`);
}
