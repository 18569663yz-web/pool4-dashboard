// Coverage guard: every Chinese string a user can see in the static page must be
// wired to the i18n layer, because the English build shares this same index.html.
//
// Anything reported here is Chinese that survives a switch to English — exactly the
// "half-translated page" state this check exists to prevent. check.mjs runs the same
// predicate as part of the main suite; this script exists for the readable listing.
//
//   node scripts/check-html-i18n.mjs          # summary + exit code
//   node scripts/check-html-i18n.mjs --list   # print every surviving string
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { scanHtml, dynamicIds, findI18nLeaks } from "../lib/html-scan.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const html = readFileSync(ROOT + "index.html", "utf8");
const app = readFileSync(ROOT + "assets/app.js", "utf8");
const list = process.argv.includes("--list");

const { texts } = scanHtml(html);
const { replaced, text } = dynamicIds(app);
const leaks = findI18nLeaks(html, app);

const isDynamic = (id) => !!id && (replaced.has(id) || text.has(id));
const wired = texts.filter((t) => t.covered).length;
const dynamic = texts.filter((t) => !t.covered && isDynamic(t.containerId)).length;

console.log(`index.html Chinese text nodes : ${texts.length}`);
console.log(`  wired by data-i18n          : ${wired}`);
console.log(`  inside a runtime block      : ${dynamic}`);
console.log(`  SURVIVE into English        : ${leaks.length}`);
if (leaks.length) {
  console.log("");
  for (const l of leaks) {
    console.log(`  ${String(l.line).padStart(4)}  ${l.kind.padEnd(12)} ${l.where.padEnd(26)} ${l.value.slice(0, 80)}`);
  }
}
if (list) {
  console.log(`\nruntime-replaced ids: ${[...replaced].sort().join(", ")}`);
  console.log(`runtime-text ids    : ${[...text].sort().join(", ")}`);
}
process.exit(leaks.length === 0 ? 0 : 1);
