import { readFileSync } from "node:fs";
const j = JSON.parse(readFileSync("data/messages.json","utf8"));
const m = j.messages.find(x => x.block === 25901450);
console.log("=== FULL TEXT of block 25901450 ===");
console.log(m.text);
console.log("\n=== length:", m.text.length, "chars ===");
