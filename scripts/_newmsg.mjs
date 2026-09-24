import { readFileSync } from "node:fs";
const j = JSON.parse(readFileSync("data/messages.json","utf8"));
console.log("counts:", JSON.stringify(j.counts));
console.log("\n=== newest 4 ===");
for (const m of j.messages.slice(0,4)) {
  console.log(`\n#${m.block} ${new Date(m.ts*1000).toISOString()}  dev=${m.isDev} self=${m.selfSend} important=${m.important||"-"}`);
  console.log("  " + m.text.replace(/\n/g,"\n  ").slice(0,700));
}
