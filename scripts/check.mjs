// Static consistency checks — catches the class of bug that only shows up in a browser.
//
//   node scripts/check.mjs
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { scanChineseLiterals } from "../lib/scan-strings.js";
import { findI18nLeaks } from "../lib/html-scan.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(ROOT + p, "utf8");

let fail = 0;
let pass = 0;
const ok = (label, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}${detail ? "\n       " + detail : ""}`);
  }
};

const html = read("index.html");
const app = read("assets/app.js");
const css = read("assets/style.css");

console.log("html ↔ js id wiring");
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const jsIds = new Set([...app.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
const missing = [...jsIds].filter((id) => !htmlIds.has(id));
ok(`every $("…") in app.js exists in index.html (${jsIds.size} refs)`, missing.length === 0, missing.join(", "));

const setHtmlIds = new Set([...app.matchAll(/setHtml\("([^"]+)"/g)].map((m) => m[1]));
const missing2 = [...setHtmlIds].filter((id) => !htmlIds.has(id));
ok(`every setHtml("…") target exists (${setHtmlIds.size} refs)`, missing2.length === 0, missing2.join(", "));

console.log("\nassets");
ok("assets/style.css linked", html.includes("assets/style.css"));
ok("assets/app.js linked as module", html.includes('type="module"') && html.includes("assets/app.js"));
ok("style.css non-trivial", css.length > 3000, `${css.length} bytes`);

console.log("\nstatic data");
for (const f of ["data/baseline.json", "data/timeline.json", "data/base.json"]) {
  ok(`${f} exists`, existsSync(ROOT + f));
}
try {
  const t = JSON.parse(read("data/timeline.json"));
  ok("timeline has trims", Array.isArray(t.trims) && t.trims.length > 0, `${t.trims.length} trims`);
  ok("timeline has last.*", t.last && t.last.Trimmed && t.last.FeeCollected);
} catch (e) {
  ok("timeline parses", false, e.message);
}
try {
  const b = JSON.parse(read("data/base.json"));
  ok("base.json has burns + bridges", b.burns.length > 0 && b.bridges.length > 0, `${b.burns.length} burns / ${b.bridges.length} bridges`);
} catch (e) {
  ok("base.json parses", false, e.message);
}

console.log("\nprohibited content");
const banned = [
  [/782[,\s]?132/, "the 782,132% APR figure"],
  [/APR_LAUNCH_RATE/, "the launch-rate APR constant"],
  [/connectWallet|eth_requestAccounts|window\.ethereum/i, "wallet connection code"],
  [/writeContract|sendTransaction|eth_sendTransaction|privateKey|mnemonic/i, "any write/signing path"],
];
for (const [re, label] of banned) {
  const hits = [];
  for (const [name, text] of [["index.html", html], ["app.js", app], ["style.css", css]]) {
    if (re.test(text)) hits.push(name);
  }
  ok(`no ${label}`, hits.length === 0, hits.join(", "));
}

console.log("\nread-only guarantee (all scripts)");
const fs = await import("node:fs");
const scriptFiles = fs.readdirSync(ROOT + "scripts").filter((f) => f.endsWith(".mjs") && !f.startsWith("_"));
const METHODS = /"(eth_[a-zA-Z]+)"/g;
const allowed = new Set([
  "eth_call",
  "eth_getLogs",
  "eth_getBlockByNumber",
  "eth_getTransactionCount",
  "eth_getBalance",
  "eth_getCode",
  "eth_blockNumber",
  "eth_chainId",
  // read-only; used by verify-ownership.mjs to inspect the renounce transaction
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
]);
const used = new Set();
for (const f of scriptFiles) {
  const text = read("scripts/" + f);
  for (const m of text.matchAll(METHODS)) used.add(m[1]);
}
const illegal = [...used].filter((m) => !allowed.has(m));
ok(`only read-only RPC methods used: ${[...used].sort().join(", ")}`, illegal.length === 0, illegal.join(", "));

console.log("\nnotes / readme");
ok("NOTES.md exists", existsSync(ROOT + "NOTES.md"));
ok("README.md exists", existsSync(ROOT + "README.md"));

/* ------------------------------------------------------------------ *
 * regression guard: no Chinese in app.js string literals
 *
 * Every user-facing string lives in locales/*.json now. If someone hard-codes a
 * Chinese sentence back into app.js — this author, or whoever picks the project up
 * next — the English page would silently show Chinese. This fails the build instead.
 * Comments are exempt: they are documentation and stay Chinese.
 * ------------------------------------------------------------------ */
console.log("\ni18n regression guard");
{
  const src = readFileSync(ROOT + "assets/app.js", "utf8");
  const found = scanChineseLiterals(src).filter((r) => !r.runaway);
  ok(
    "app.js string literals contain no Chinese",
    found.length === 0,
    found.length ? `${found.length} found, e.g. line ${found[0].line} in ${found[0].fn}: ${found[0].literal.slice(0, 60)}` : ""
  );

  const zh = JSON.parse(readFileSync(ROOT + "locales/zh.json", "utf8"));
  const en = JSON.parse(readFileSync(ROOT + "locales/en.json", "utf8"));
  const zhKeys = Object.keys(zh).filter((k) => !k.startsWith("_"));
  const enKeys = Object.keys(en).filter((k) => !k.startsWith("_"));
  ok("both locales define the same keys", zhKeys.sort().join() === enKeys.sort().join(), `zh=${zhKeys.length} en=${enKeys.length}`);
  ok("no locale entry is empty", zhKeys.every((k) => String(zh[k]).length > 0) && enKeys.every((k) => String(en[k]).length > 0));
  ok("placeholder counts match across locales", zhKeys.every((k) => {
    const a = (String(zh[k]).match(/\{p\d\}/g) || []).length;
    const b = (String(en[k]).match(/\{p\d\}/g) || []).length;
    return a === b;
  }), zhKeys.filter((k) => (String(zh[k]).match(/\{p\d\}/g) || []).length !== (String(en[k]).match(/\{p\d\}/g) || []).length).slice(0, 5).join(", "));
  ok("i18n runtime is wired into app.js", /from "\.\.\/lib\/i18n\.js"/.test(src) && /\btr\(/.test(src));
}

/* ------------------------------------------------------------------ *
 * regression guard: no Chinese in index.html that English mode would keep showing
 *
 * app.js is covered above, but the page's static copy — headings, ledes, table
 * captions — lives in index.html. Anything there without a data-i18n attribute stays
 * Chinese after the language switch, which is precisely the failure the bilingual
 * build exists to avoid.
 * ------------------------------------------------------------------ */
console.log("\nstatic copy is wired to i18n");
{
  const leaks = findI18nLeaks(html, app);
  ok(
    "every Chinese string in index.html is localised or runtime-replaced",
    leaks.length === 0,
    leaks.length
      ? `${leaks.length} survive into English, e.g. ${leaks
          .slice(0, 3)
          .map((l) => `line ${l.line} ${l.where} ${l.value.slice(0, 40)}`)
          .join(" | ")}`
      : ""
  );

  const wiredKeys = new Set([...html.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)].map((m) => m[1]));
  const zhDict = JSON.parse(read("locales/zh.json"));
  const enDict = JSON.parse(read("locales/en.json"));
  const missing = [...wiredKeys].filter((k) => !(k in zhDict) || !(k in enDict));
  ok(`every data-i18n key exists in both locales (${wiredKeys.size} keys)`, missing.length === 0, missing.slice(0, 6).join(", "));

  // `lang.zh` is "中文" in both locales on purpose: a language button names its own
  // language, so an English reader can find their way back.
  const zhInEn = Object.entries(enDict).filter(([k, v]) => !k.startsWith("_") && k !== "lang.zh" && /[\u4e00-\u9fff]/.test(v));
  ok("no English value still contains Chinese", zhInEn.length === 0, zhInEn.slice(0, 5).map(([k]) => k).join(", "));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
