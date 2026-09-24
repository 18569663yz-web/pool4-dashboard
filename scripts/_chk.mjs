import { readFileSync } from "node:fs";
const t = readFileSync("scripts/test-render.mjs","utf8");
console.log(t.includes('burnrate') ? "already asserted" : "NOT asserted");
