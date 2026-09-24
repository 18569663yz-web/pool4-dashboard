import { readFileSync } from "node:fs";
import { scanChineseLiterals } from "../lib/scan-strings.js";

const src = readFileSync("assets/app.js", "utf8");
const rows = scanChineseLiterals(src);
const a = Number(process.argv[2] || 1);
const b = Number(process.argv[3] || rows.length);
console.log(`total ${rows.length}`);
for (let i = a - 1; i < Math.min(b, rows.length); i++) {
  const r = rows[i];
  console.log(`${i + 1}|${r.line}|${r.fn}|${r.literal.replace(/\s+/g, " ").replace(/\|/g, "¦").slice(0, 150)}`);
}
