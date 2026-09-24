import { readFileSync } from "node:fs";
const j = JSON.parse(readFileSync("data/messages.json","utf8"));
const ms = [...j.messages].sort((a,b)=>a.block-b.block);
const lens = ms.map(m=>m.text.length);
console.log(`count ${ms.length} | total chars ${lens.reduce((a,b)=>a+b,0)} | median ${lens.sort((a,b)=>a-b)[Math.floor(lens.length/2)]} | max ${Math.max(...lens)}`);
console.log("\n#   block      dev  len  head");
ms.forEach((m,i) => {
  const head = m.text.replace(/\s+/g," ").slice(0,68);
  console.log(`${String(i+1).padStart(2)} ${m.block} ${m.isDev?"D":"c"} ${String(m.text.length).padStart(4)}  ${head}`);
});
