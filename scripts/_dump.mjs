import { readFileSync } from "node:fs";
const j = JSON.parse(readFileSync("data/strings-todo.json","utf8"));
j.rows.forEach((r,i) => {
  const lit = r.literal.replace(/\s+/g," ").replace(/\|/g,"¦").trim();
  console.log(`${i+1}|${r.fn}|${lit}`);
});
