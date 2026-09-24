import { readFileSync } from "node:fs";
const j = JSON.parse(readFileSync("data/messages.json","utf8"));
const ms = [...j.messages].sort((a,b)=>a.block-b.block);
const a = Number(process.argv[2] || 1), b = Number(process.argv[3] || 25);
for (let i = a - 1; i < Math.min(b, ms.length); i++) {
  const m = ms[i];
  console.log(`\n[${i+1}] block ${m.block} ${m.isDev?"DEV":"community"} ${new Date(m.ts*1000).toISOString().slice(0,16)}`);
  console.log(m.text.replace(/\n{2,}/g,"\n").trim());
}
