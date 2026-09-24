import { readFileSync } from "node:fs";
const j = JSON.parse(readFileSync("data/strings-todo.json", "utf8").replace(/^\uFEFF/, ""));
console.log("total:", j.rows.length);
let real = 0;
for (const r of j.rows) {
  const runaway = r.literal.length > 400 || /\bfunction\b/.test(r.literal) || /\bconst \w+ =/.test(r.literal);
  if (!runaway) real++;
  const tag = runaway ? "RUNAWAY" : "REAL   ";
  console.log(`${tag} len=${String(r.literal.length).padStart(5)} line ${r.line}  ${r.literal.replace(/\s+/g, " ").slice(0, 70)}`);
}
console.log(`\nreal remaining: ${real}`);
