import { readFileSync } from "node:fs";
const j = JSON.parse(readFileSync("data/messages.json","utf8"));
console.log("=== messages.json counts ===");
console.log(JSON.stringify(j.counts, null, 2));
console.log("\n=== what the 9 undecodable ones are ===");
const raw = j.raw || j.txs || null;
if (raw) { console.log("raw entries:", raw.length); }
for (const k of Object.keys(j)) {
  if (Array.isArray(j[k])) console.log(`  ${k}: ${j[k].length}`);
}
console.log("\n=== messages by sender ===");
const dev = j.messages.filter(m=>m.isDev).length;
const comm = j.messages.filter(m=>!m.isDev).length;
console.log(`  dev: ${dev}  community: ${comm}  total: ${j.messages.length}`);
console.log("\n=== selfSend (dev announcements) ===");
console.log(`  selfSend: ${j.messages.filter(m=>m.selfSend).length}`);
console.log("\n=== first + last ===");
const s = [...j.messages].sort((a,b)=>a.block-b.block);
console.log(`  first block ${s[0].block} ${new Date(s[0].ts*1000).toISOString()}`);
console.log(`  last  block ${s[s.length-1].block} ${new Date(s[s.length-1].ts*1000).toISOString()}`);
