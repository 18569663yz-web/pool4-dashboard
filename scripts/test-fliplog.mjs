// Does the state-change log actually record a flip?
//
// The dashboard polls every 60 s, so a test cannot wait for it. But init() wires a
// visibilitychange handler that resets the throttle and calls tick() — so the stub
// captures that handler and fires it to force a second poll on demand.
//
// Run 1: real chain state (whatever it is right now).
// Run 2: the same, but with inventoryCap/tokensInPool overridden so the engine is
//        over its trigger line. The log must gain exactly one entry, and that entry
//        must name the cause.
//
//   node scripts/test-fliplog.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { selector } from "../lib/evm.js";
import { ABI } from "../lib/contracts.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const html = readFileSync(ROOT + "index.html", "utf8");
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);

let pass = 0;
let fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}${detail ? "\n       " + detail : ""}`);
  }
};

/* ---------- DOM stub with a capturable visibilitychange handler ---------- */
class El {
  constructor(id) {
    this.id = id;
    this._html = "";
    this.textContent = "";
    this.className = "";
    this.value = "0";
    this.style = {};
    this.children = [];
  }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  addEventListener() {}
  setAttribute() {}
  appendChild() {}
}
const els = new Map(ids.map((id) => [id, new El(id)]));
const docHandlers = {};
globalThis.document = {
  getElementById: (id) => els.get(id) || null,
  addEventListener: (type, fn) => {
    (docHandlers[type] = docHandlers[type] || []).push(fn);
  },
  hidden: false,
  createElement: (t) => new El(t),
  documentElement: new El("html"),
  querySelectorAll: () => [],
  querySelector: (sel) => { const m = new El(sel); m.attrs = { content: "" }; return m; },
  title: "",
};
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = globalThis;
Object.defineProperty(globalThis, "navigator", { value: { language: "zh-CN" }, configurable: true, writable: true });
globalThis.location = { search: "", href: "http://localhost/", pathname: "/" };
globalThis.history = { replaceState: () => {} };
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

/* ---------- RPC interception: both phases are synthetic ---------- */
const E18 = 10n ** 18n;
const imd = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const word = (v) => "0x" + v.toString(16).padStart(64, "0");

// Both phases are synthetic: reading the real chain would make the flip depend on
// whatever the engine happens to be doing when the suite runs.
//   A = LIVE  (pool above its line)      B = DORMANT (pool below, line at floor)
let phase = 0;
const FAKE_SETS = [
  {
    [selector(ABI.hook.capFloor.sig)]: word(imd(9000)),
    [selector(ABI.hook.inventoryCap.sig)]: word(imd(9000)),
    [selector(ABI.hook.tokensInPool.sig)]: word(imd(9500)),
    [selector(ABI.hook.pendingTrim.sig)]: word(imd(500)),
  },
  {
    [selector(ABI.hook.capFloor.sig)]: word(imd(20000)),
    [selector(ABI.hook.inventoryCap.sig)]: word(imd(20000)),
    [selector(ABI.hook.tokensInPool.sig)]: word(imd(15000)),
    [selector(ABI.hook.pendingTrim.sig)]: word(imd(0)),
  },
];
const FAKE = FAKE_SETS[0];

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (!u.startsWith("http")) {
    const p = u.startsWith("/") ? u.slice(1) : u;
    try {
      return new Response(readFileSync(ROOT + p, "utf8"), { status: 200 });
    } catch {
      return new Response("not found", { status: 404 });
    }
  }
  const res = await realFetch(url, opts);
  if (!opts || typeof opts.body !== "string" || !opts.body.includes("eth_call")) return res;
  const j = await res.json();
  const arr = Array.isArray(j) ? j : [j];
  let reqs;
  try {
    reqs = JSON.parse(opts.body);
  } catch {
    return new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json" } });
  }
  const list = Array.isArray(reqs) ? reqs : [reqs];
  const set = FAKE_SETS[phase];
  for (const r of arr) {
    const orig = list.find((x) => x.id === r.id);
    const data = orig && orig.params && orig.params[0] && orig.params[0].data;
    const hit = data && set[data.slice(0, 10)];
    if (hit) {
      delete r.error;
      r.result = hit;
    }
  }
  return new Response(JSON.stringify(Array.isArray(j) ? arr : arr[0]), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

/* ---------- run ---------- */
const errors = [];
process.on("unhandledRejection", (e) => errors.push(String(e && e.message ? e.message : e)));
await import("../assets/app.js");

console.log("phase 1 — synthetic LIVE state");
await new Promise((r) => setTimeout(r, 34000));
const strip = (h) => String(h).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const badge1 = els.get("v-state").textContent || strip(els.get("v-state").innerHTML);
const log1 = JSON.parse(store.get("pool4.fliplog.v1") || "[]");
console.log(`  badge="${badge1}"  fliplog entries=${log1.length}`);
console.log(`  fliplog rendered: ${els.get("fliplog").innerHTML.length} chars`);

ok("first poll establishes a baseline without logging a flip", log1.length === 0, `${log1.length} entries`);
ok("fliplog panel explains the empty state", /还没有记录到状态变化/.test(els.get("fliplog").innerHTML));

console.log("\nphase 2 — force a poll with the engine pushed back below its line");
phase = 1;
for (const fn of docHandlers.visibilitychange || []) fn();
await new Promise((r) => setTimeout(r, 34000));

const badge2 = els.get("v-state").textContent || strip(els.get("v-state").innerHTML);
const log2 = JSON.parse(store.get("pool4.fliplog.v1") || "[]");
console.log(`  badge="${badge2}"  fliplog entries=${log2.length}`);
if (log2[0]) {
  console.log(`  entry: ${log2[0].fromState}/${log2[0].fromAtLine} -> ${log2[0].toState}/${log2[0].toAtLine}`);
  console.log(`  block: ${log2[0].block}`);
  for (const r of log2[0].reasons || []) console.log(`  reason: [${r.kind}] ${r.label}${r.note ? " " + r.note : ""} ${r.from ? r.from + " -> " + r.to : ""}`);
}
const rendered = els.get("fliplog").innerHTML;
console.log(`  fliplog rendered: ${rendered.length} chars`);

ok("the flip was recorded", log2.length >= 1, `${log2.length} entries`);
ok("the recorded entry names the new state", log2[0] && /LIVE|CRITICAL|DORMANT/.test(log2[0].toState || ""), JSON.stringify(log2[0] && log2[0].toState));
ok("the entry records a block number", log2[0] && Number(log2[0].block) > 0, String(log2[0] && log2[0].block));
ok("the entry explains WHY (at least one reason)", log2[0] && (log2[0].reasons || []).length > 0, JSON.stringify(log2[0] && log2[0].reasons));
ok("the reason names a parameter or the inventory", log2[0] && (log2[0].reasons || []).some((r) => r.kind === "param" || r.kind === "inventory"), JSON.stringify((log2[0] && log2[0].reasons || []).map((r) => r.kind)));
ok("the badge flipped away from its phase-1 value", badge1 !== badge2, `${badge1} -> ${badge2}`);
ok("the log is now rendered as a table", /<table/.test(rendered) && /触发原因/.test(rendered), rendered.slice(0, 100));
ok("no unhandled errors", errors.length === 0, errors.slice(0, 2).join(" | "));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
