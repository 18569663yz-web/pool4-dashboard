// Merge every s.* entry into the locale files, then verify coverage before any code
// is rewritten — a missing translation would surface as a raw key on the page.
//
// Sources, all optional except the first skeleton:
//   data/strings-i18n*.json   the literal → key skeleton (one file per pass)
//   data/_en*.json            English translations for those keys
//   data/_extra.json          keys written by hand (nested template literals the
//                             scanner mis-matches, list separators, …)
//
//   node scripts/merge-i18n.mjs
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(ROOT + p, "utf8").replace(/^\uFEFF/, ""));
const list = (re) => readdirSync(ROOT + "data").filter((f) => re.test(f)).sort();

const skeletons = list(/^strings-i18n.*\.json$/).map((f) => ({ file: "data/" + f, dict: readJson("data/" + f) }));
skeletons.sort((a, b) => a.file.length - b.file.length); // strings-i18n.json before strings-i18n-2.json

const entries = new Map(); // key -> { zh, en }
const enSources = {};
for (const { file, dict } of skeletons) {
  for (const [key, entry] of Object.entries(dict)) {
    if (!entries.has(key)) entries.set(key, { zh: entry.zh, en: "", from: file });
  }
}
for (const f of list(/^_en.*\.json$/)) {
  const dict = readJson("data/" + f);
  enSources[f] = Object.keys(dict).length;
  for (const [key, t] of Object.entries(dict)) {
    if (!entries.has(key)) {
      console.log(`  WARN ${f} defines ${key}, which no skeleton claims — ignored`);
      continue;
    }
    entries.get(key).en = t;
  }
}
if (existsSync(ROOT + "data/_extra.json")) {
  const extra = readJson("data/_extra.json");
  enSources["_extra.json"] = Object.keys(extra).length;
  for (const [key, v] of Object.entries(extra)) {
    if (entries.has(key)) {
      entries.get(key).en = v.en;
      if (!entries.get(key).zh) entries.get(key).zh = v.zh;
    } else {
      entries.set(key, { zh: v.zh, en: v.en, from: "_extra.json" });
    }
  }
}

// Hand-written copy blocks shaped { zh: {…}, en: {…} } — the step-3 "second door" copy
// lives in data/_awaiting-copy.json so the wording can be reviewed on its own.
for (const f of list(/^_.*\.json$/)) {
  if (f === "_extra.json") continue;
  let dict;
  try {
    dict = readJson("data/" + f);
  } catch {
    continue;
  }
  if (!dict || typeof dict.zh !== "object" || typeof dict.en !== "object") continue;
  let fresh = 0;
  for (const key of Object.keys(dict.zh)) {
    if (entries.has(key)) {
      // A hand-written copy block is the source of truth for its keys: it may correct
      // wording after the first merge, and that correction has to reach the locale file
      // — in both languages.
      entries.get(key).en = dict.en[key] ?? entries.get(key).en;
      entries.get(key).zh = dict.zh[key] ?? entries.get(key).zh;
      entries.get(key).overwrite = true;
      continue;
    }
    entries.set(key, { zh: dict.zh[key], en: dict.en[key] ?? "", from: f, overwrite: true });
    fresh++;
  }
  console.log(`copy block ${f}: ${fresh} new keys`);
}

console.log(`skeletons : ${skeletons.map((s) => `${s.file} (${Object.keys(s.dict).length})`).join(", ")}`);
console.log(`english   : ${Object.entries(enSources).map(([f, n]) => `${f} (${n})`).join(", ")}`);
console.log(`entries   : ${entries.size}`);

const zh = readJson("locales/zh.json");
const enDict = readJson("locales/en.json");

let addedZh = 0;
let addedEn = 0;
let updatedEn = 0;
let updatedZh = 0;
const missingEn = [];
const mismatched = [];
for (const [key, entry] of entries) {
  if (!(key in zh)) {
    zh[key] = entry.zh;
    addedZh++;
  } else if (entry.overwrite && entry.zh && zh[key] !== entry.zh) {
    // A copy block is the authority for its own keys — including corrections to the
    // Chinese (e.g. a term that was wrong on the page and is now fixed there too).
    zh[key] = entry.zh;
    updatedZh++;
  }
  if (typeof entry.en === "string" && entry.en.length) {
    if (!(key in enDict)) {
      enDict[key] = entry.en;
      addedEn++;
    } else if (entry.overwrite && enDict[key] !== entry.en) {
      enDict[key] = entry.en;
      updatedEn++;
    }
  } else {
    missingEn.push(key);
  }
  // placeholder parity: a translation that drops {p1} would silently lose a number
  const want = (entry.zh.match(/\{p\d\}/g) || []).sort().join();
  const got = (entry.en.match(/\{p\d\}/g) || []).sort().join();
  if (want !== got) mismatched.push(`${key}: zh[${want}] en[${got}]`);
}

writeFileSync(ROOT + "locales/zh.json", JSON.stringify(zh, null, 2) + "\n");
writeFileSync(ROOT + "locales/en.json", JSON.stringify(enDict, null, 2) + "\n");

console.log(`added to zh.json : ${addedZh}${updatedZh ? ` (+${updatedZh} corrected)` : ""}`);
console.log(`added to en.json : ${addedEn}${updatedEn ? ` (+${updatedEn} corrected from a copy block)` : ""}`);
console.log(`missing English  : ${missingEn.length}${missingEn.length ? " -> " + missingEn.slice(0, 20).join(", ") : ""}`);
console.log(`placeholder mismatches: ${mismatched.length}`);
for (const m of mismatched.slice(0, 20)) console.log(`  ${m}`);

const zhKeys = Object.keys(zh).filter((k) => !k.startsWith("_"));
const enKeys = Object.keys(enDict).filter((k) => !k.startsWith("_"));
const onlyZh = zhKeys.filter((k) => !enKeys.includes(k));
const onlyEn = enKeys.filter((k) => !zhKeys.includes(k));
console.log(`\nzh.json ${zhKeys.length} keys | en.json ${enKeys.length} keys`);
console.log(`only in zh: ${onlyZh.length ? onlyZh.join(", ") : "none"}`);
console.log(`only in en: ${onlyEn.length ? onlyEn.join(", ") : "none"}`);
