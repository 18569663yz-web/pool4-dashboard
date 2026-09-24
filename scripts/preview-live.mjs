// What does the page look like the moment the engine re-ignites?
//
// This runs the real app.js against a DOM stub, but intercepts the RPC calls for
// three view functions and returns a synthetic "engine is burning again" reading.
// Everything else (rendering, wording, state machine, headline) is the production code.
//
//   node scripts/preview-live.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { selector } from "../lib/evm.js";
import { ABI } from "../lib/contracts.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const html = readFileSync(ROOT + "index.html", "utf8");
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);

/* ---------- synthetic chain state: inventory pushed over the cap ---------- */
const E18 = 10n ** 18n;
const imd = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const word = (v) => "0x" + v.toString(16).padStart(64, "0");

const FAKE = {
  [selector(ABI.hook.capFloor.sig)]: word(imd(15000)),
  [selector(ABI.hook.inventoryCap.sig)]: word(imd(15000)),
  [selector(ABI.hook.tokensInPool.sig)]: word(imd(16321.5)),
  [selector(ABI.hook.pendingTrim.sig)]: word(imd(1321.5)),
};
console.log("injecting synthetic readings:");
console.log(`  capFloor()      -> 15,000 IMD`);
console.log(`  inventoryCap()  -> 15,000 IMD`);
console.log(`  tokensInPool()  -> 16,321.5 IMD`);
console.log(`  pendingTrim()   ->  1,321.5 IMD\n`);

/* ---------- DOM stub (same shape as test-render.mjs) ---------- */
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
globalThis.document = {
  getElementById: (id) => els.get(id) || null,
  addEventListener: () => {},
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

const realFetch = globalThis.fetch;
let injected = 0;
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
  // intercept JSON-RPC eth_call for the three view functions we override
  if (opts && opts.body && typeof opts.body === "string" && opts.body.includes("eth_call")) {
    const req = JSON.parse(opts.body);
    const list = Array.isArray(req) ? req : [req];
    for (const r of list) {
      const data = r.params && r.params[0] && r.params[0].data;
      if (data && FAKE[data.slice(0, 10)]) {
        r.result = FAKE[data.slice(0, 10)];
        injected++;
      }
    }
    const payload = Array.isArray(req) ? list : list[0];
    // serve everything else for real, then patch in our values
    const res = await realFetch(url, { ...opts, body: JSON.stringify(payload) });
    const j = await res.json();
    const arr = Array.isArray(j) ? j : [j];
    for (const r of arr) {
      const orig = list.find((x) => x.id === r.id);
      if (!orig) continue;
      const data = orig.params && orig.params[0] && orig.params[0].data;
      if (data && FAKE[data.slice(0, 10)]) {
        delete r.error;
        r.result = FAKE[data.slice(0, 10)];
      }
    }
    return new Response(JSON.stringify(Array.isArray(j) ? arr : arr[0]), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(url, opts);
};

/* ---------- run ---------- */
const errors = [];
process.on("unhandledRejection", (e) => errors.push(String(e && e.message ? e.message : e)));
await import("../assets/app.js");
await new Promise((r) => setTimeout(r, 34000));

const strip = (h) => String(h).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const txt = (id) => {
  const el = els.get(id);
  if (!el) return "(missing)";
  return strip(el.innerHTML) || el.textContent;
};

console.log(`injected ${injected} synthetic readings\n`);
if (errors.length) console.log("errors:", errors.slice(0, 3).join(" | "), "\n");

console.log("=============== WHAT CHANGES WHEN IT RE-IGNITES ===============\n");
console.log(`浏览器标题 : ${document.title}`);
console.log(`顶部小字   : ${txt("page-sub")}`);
console.log(`\n摘要大标题 : ${txt("sum-headline")}`);
console.log(`\n【这意味着什么】`);
for (const li of (els.get("sum-impact").innerHTML.match(/<li>(.*?)<\/li>/g) || [])) {
  console.log(`  · ${strip(li)}`);
}
console.log(`\n【什么时候会恢复】\n  ${txt("sum-recovery")}`);
console.log(`\n【还有一件你应该知道的事】\n  ${txt("sum-risk")}`);
console.log(`\n结论条标题 : ${txt("v-title")}`);
console.log(`结论条徽章 : ${txt("v-state")}`);
console.log(`结论条正文 : ${txt("v-answer")}`);
console.log(`点火距离   : ${txt("v-gap")} IMD   (${txt("v-gap-alt")})`);
console.log(`待烧毁量   : ${txt("v-pending")}`);
console.log(`\n状态机当前 : ${(els.get("states").innerHTML.match(/class="state on [a-z]+"/) || ["?"])[0]}`);
console.log(`状态机说明 : ${txt("state-note")}`);
console.log(`\n【如果现在触发，会烧掉多少】`);
console.log(`  ${txt("trim-now").slice(0, 260)}`);
console.log(`\n【烧毁历史】\n  ${txt("history-lede")}`);
console.log(`\n状态切换横幅: ${txt("state-flip") || "(无 —— 首次加载没有上一状态可比对)"}`);
console.log(`\n结论条 class: ${els.get("verdict").className}`);
console.log(`摘要区 class: ${els.get("summary").className}`);

/* ---------- assertions: nothing may still say "stopped" ---------- */
console.log("\n=============== ASSERTIONS ===============");
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

const title = document.title;
const sub = txt("page-sub");
const headline = txt("sum-headline");
const badge = txt("v-state");
const vtitle = txt("v-title");

ok("document title no longer says 已停", !/已停/.test(title), title);
ok("page subtitle no longer says 已停", !/已停/.test(sub), sub);
ok("subtitle says burning is in progress", /进行中|工作/.test(sub), sub);
ok("headline says it is working", /正在工作/.test(headline), headline);
ok("headline shows the pending amount", /1,321/.test(headline), headline);
ok("state badge says 工作中", /工作中/.test(badge), badge);
ok("verdict title says 烧毁正在工作", /正在工作/.test(vtitle), vtitle);
ok("ignition gap reads 0", txt("v-gap") === "0", txt("v-gap"));
ok("gap line says it is already triggerable", /已经具备触发条件/.test(txt("v-gap-alt")), txt("v-gap-alt"));
ok(
  "impact list switched to the burn branch",
  /正在被抽走销毁|会被抽走销毁/.test(strip(els.get("sum-impact").innerHTML)),
  strip(els.get("sum-impact").innerHTML).slice(0, 110)
);
ok("recovery says it will fire on the next swap", /下一笔/.test(txt("sum-recovery")));
ok("state machine highlights LIVE", /state on live/.test(els.get("states").innerHTML));
ok("verdict block uses the live palette", /live/.test(els.get("verdict").className), els.get("verdict").className);
ok("summary block uses the calm palette", /calm/.test(els.get("summary").className), els.get("summary").className);
ok("pending-amount section is non-zero", /1,321/.test(txt("trim-now")), txt("trim-now").slice(0, 60));
ok("split is 85/15 of the pending amount", /1,123\.275/.test(txt("trim-now")) && /198\.225/.test(txt("trim-now")));

console.log(`\n${pass} passed, ${fail} failed`);
console.log("==========================================");
process.exit(fail === 0 ? 0 : 1);
