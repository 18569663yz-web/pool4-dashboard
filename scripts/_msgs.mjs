import { readFileSync } from "node:fs";
const j = JSON.parse(readFileSync("data/messages.json", "utf8"));
console.log("address:", j.address);
console.log("counts:", JSON.stringify(j.counts));
const self = j.messages.filter(m => m.selfSend);
const other = j.messages.filter(m => !m.selfSend);
console.log(`\nselfSend=${self.length}  other=${other.length}`);
console.log("\n--- distinct senders (non-self) ---");
const byFrom = new Map();
for (const m of other) byFrom.set(m.from, (byFrom.get(m.from)||0)+1);
for (const [a,n] of [...byFrom.entries()].sort((x,y)=>y[1]-x[1])) console.log(`  ${a}  ${n}`);
console.log("\n--- self-send: from/to values ---");
const pairs = new Map();
for (const m of self) pairs.set(m.from+" -> "+m.to, (pairs.get(m.from+" -> "+m.to)||0)+1);
for (const [k,n] of pairs) console.log(`  ${k}  ${n}`);
console.log("\n--- newest 6 (any) ---");
for (const m of j.messages.slice(0,6)) {
  console.log(`\n#${m.block} ${new Date(m.ts*1000).toISOString()} self=${m.selfSend} from=${m.from.slice(0,10)}`);
  console.log("  " + m.text.replace(/\n/g,"\n  ").slice(0,400));
}
console.log("\n--- the 26026706 one ---");
const t = j.messages.find(m => m.block === 26026706);
console.log(t ? JSON.stringify({block:t.block,self:t.selfSend,from:t.from,text:t.text.slice(0,500)},null,1) : "NOT FOUND");
