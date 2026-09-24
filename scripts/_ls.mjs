import { readFileSync } from "node:fs";
const j = JSON.parse(readFileSync("data/strings-i18n.json","utf8"));
const keys = Object.keys(j);
const a = Number(process.argv[2]||1), b = Number(process.argv[3]||100);
for (let i = a-1; i < Math.min(b, keys.length); i++) {
  const k = keys[i], e = j[k];
  console.log(`${k}|${e.zh.replace(/\s+/g," ").replace(/\|/g,"¦")}`);
}
