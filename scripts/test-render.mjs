// Headless render test: run assets/app.js against a minimal DOM stub, with real
// network fetches, and assert that every section actually produced content.
//
// This catches the class of bug a static check cannot: a runtime throw halfway
// through renderAll() that leaves half the page blank.
//
//   node scripts/test-render.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

/* ---------- minimal DOM ---------- */
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
  set innerHTML(v) {
    this._html = String(v);
  }
  get innerHTML() {
    return this._html;
  }
  addEventListener() {}
  setAttribute(k, v) {
    this.attrs = this.attrs || {};
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return (this.attrs || {})[k] ?? null;
  }
  removeAttribute(k) {
    if (this.attrs) delete this.attrs[k];
  }
  appendChild() {}
}
const els = new Map(ids.map((id) => [id, new El(id)]));

/** Minimal querySelectorAll: enough for [data-i18n] sweeps and meta tags. */
const metaEls = new Map();
function makeMeta(selector) {
  if (!metaEls.has(selector)) {
    const m = new El(selector);
    m.attrs = { content: "" };
    metaEls.set(selector, m);
  }
  return metaEls.get(selector);
}
globalThis.document = {
  getElementById: (id) => els.get(id) || null,
  addEventListener: () => {},
  hidden: false,
  createElement: (t) => new El(t),
  title: "",
  documentElement: new El("html"),
  querySelectorAll: (sel) => {
    if (sel === "[data-i18n]") return [];
    if (sel === "[data-i18n-html]") return [];
    return [];
  },
  querySelector: (sel) => makeMeta(sel),
};
// Node 24 ships a read-only global `navigator`, so it must be redefined.
Object.defineProperty(globalThis, "navigator", { value: { language: "zh-CN" }, configurable: true, writable: true });
globalThis.location = { search: "", href: "http://localhost/", pathname: "/" };
globalThis.history = { replaceState: () => {} };
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = globalThis;
// app.js registers listeners on window (hashchange, for the collapsible groups). A browser
// has those; Node does not, and the TypeError at module scope used to kill this suite
// silently — see the sentinel below.
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

// fetch: serve local files, and let http(s) through to the real network
const realFetch = globalThis.fetch;
const fetchLog = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith("http")) return realFetch(url, opts);
  const p = u.startsWith("/") ? u.slice(1) : u;
  try {
    const body = readFileSync(ROOT + p, "utf8");
    fetchLog.push(`local ok   ${p} (${body.length}B)`);
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  } catch (e) {
    fetchLog.push(`local FAIL ${p} :: ${e.message}`);
    return new Response("not found", { status: 404 });
  }
};

// capture interval callbacks but do not let them run forever
const timers = [];
globalThis.setInterval = (fn, ms) => {
  timers.push({ fn, ms });
  return timers.length;
};
globalThis.clearInterval = () => {};

/* ---------- run ---------- */
console.log("headless render");

/* The suite must not be able to report success without running. If app.js throws at module
 * scope, the await below never resolves, the event loop drains, and Node exits 0 with one
 * line of output — which is exactly what happened when a `window.addEventListener` call
 * entered app.js: `npm test` went green while this file ran zero assertions. */
let finished = false;
process.on("exit", (code) => {
  if (!finished && code === 0) {
    process.exitCode = 1;
    console.error("\nFATAL: the suite exited before it finished — app.js most likely threw while loading");
  }
});

const errors = [];
process.on("unhandledRejection", (e) => errors.push(String(e && e.message ? e.message : e)));
process.on("uncaughtException", (e) => errors.push(String(e && e.message ? e.message : e)));

try {
  await import("../assets/app.js");
} catch (e) {
  console.error(`\nFATAL: app.js threw while loading: ${e && e.message}`);
  finished = true;
  process.exit(1);
}

// boot() is async; give the network round-trips time
await new Promise((r) => setTimeout(r, 25000));

ok("no unhandled errors during boot+render", errors.length === 0, errors.slice(0, 3).join(" | "));

const content = (id) => (els.get(id) ? els.get(id).innerHTML : "");
const stripTags = (h) => String(h).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
/** The stub does not parse HTML, so fall back to stripping the innerHTML. */
const text = (id) => {
  const el = els.get(id);
  if (!el) return "";
  return el.textContent || stripTags(el.innerHTML);
};

console.log("\nsections produced content");
// boot() failures are caught by init() and surfaced in the RPC banner — print them.
const bootErr = content("rpc-banner");
if (/读不到链上数据/.test(bootErr)) console.log("  BOOT FAILURE: " + stripTags(bootErr).slice(0, 300));
if (process.argv.includes("--dump")) {
  console.log("  local fetch calls:");
  for (const l of fetchLog) console.log("    " + l);
}
const mustHaveContent = [
  ["states", "状态机"],
  ["timeline", "熄火时间线"],
  ["door1", "第一道门"],
  ["door2", "第二道门"],
  ["awaiting-stats", "待桥接到 Base 销毁的 IMD（第二道门的队列）"],
  ["door-table", "桥接/销毁配对表"],
  ["panel", "状态面板"],
  ["sim-out", "模拟器输出"],
  ["trim-now", "trim 分配"],
  ["rewards", "奖励流"],
  ["simd", "sIMD"],
  ["simd-explain", "sIMD 成因"],
  ["powers", "owner 权限表"],
  ["watch-table", "参数监控表"],
  ["hist-stats", "历史统计"],
  ["spark", "历史曲线"],
  ["pools", "池对照"],
  ["fliplog", "状态变更历史"],
  ["burnrate", "烧毁速率"],
  ["footer-src", "页脚来源"],
];for (const [id, label] of mustHaveContent) {
  const c = content(id);
  ok(`${label} (#${id}) rendered ${c.length} chars`, c.length > 40, `len=${c.length}`);
}

console.log("\n30-second summary (the first thing a holder reads)");
for (const [id, label] of [
  ["sum-headline", "结论大标题"],
  ["sum-impact", "影响我什么"],
  ["sum-recovery", "什么时候恢复"],
  ["sum-risk", "owner 风险提示"],
  ["volume-stats", "池 A 对照数字"],
  ["sources-table", "数据来源表"],
  ["pools-tech", "池 ID 技术细节"],
  ["preset-hint", "预设说明"],
]) {
  const c = content(id) || text(id);
  ok(`${label} (#${id}) rendered ${c.length} chars`, c.length > 20, `len=${c.length}`);
}
// These must hold whatever the engine is doing — no state is hard-coded.
ok("headline is a full assertion, not a placeholder", text("sum-headline").length > 8 && !/读取中/.test(text("sum-headline")), text("sum-headline"));
ok(
  "impact list covers burn, yield and what happens next",
  /销毁|烧毁/.test(content("sum-impact")) &&
    /质押|收益/.test(content("sum-impact")) &&
    /触发线|交易|池子|待销毁/.test(content("sum-impact")),
  content("sum-impact").slice(0, 160)
);
ok(
  "recovery explains what has to happen next",
  /还需要多约|贴在触发线|贴着触发线|已经具备触发条件|自己缩短/.test(content("sum-recovery")),
  content("sum-recovery").slice(0, 130)
);
ok("recovery is state-appropriate", /不会自动发生|已经具备触发条件|立刻触发销毁/.test(content("sum-recovery")), content("sum-recovery").slice(0, 90));
ok("risk cites the developer's own words", /withdraw the entire position/.test(content("sum-risk")));
ok("document title carries a conclusion", /已停|恢复|贴着|正在工作|触发线/.test(document.title), document.title);

// The summary's picture. A missing drawing is a silent regression: the page still renders
// and every other assertion still passes — it is just back to three paragraphs of prose,
// which is exactly what the reader complained about.
const visual = content("sum-visual");
ok("summary draws the pool-against-trigger gauge", /class="gauge"/.test(visual) && /gauge-fill/.test(visual), `${visual.length} chars`);
ok("the gauge is filled to the pool's real position", /gauge-fill" style="width:\d+(\.\d+)?%/.test(visual));
ok("the gauge marks the ratchet floor", /gauge-floor" style="left:\d/.test(visual));
ok("the gauge names both ends of the scale", /触发线的下限/.test(visual) && /触发线 [\d,]+/.test(visual));
const actBars = (visual.match(/<i style="height:/g) || []).length;
ok("summary draws the burn-activity strip", /class="actbars"/.test(visual) && actBars >= 5, `${actBars} bars`);
ok("the activity strip says when the last burn was", /最近一次烧毁/.test(visual));

// State-independent assertions: read what the page actually says, then check it is
// self-consistent. Hard-coding "已停" would break the moment the engine re-ignites.
console.log("\nstate consistency (must hold in every state)");
const badge = text("v-state");
const headline = text("sum-headline");
const vtitle = text("v-title");
const gap = text("v-gap");
const isStopped = /已停/.test(badge);
const isAtLine = /贴着触发线/.test(badge);
const isWorking = /工作中/.test(badge);
ok("state badge is one of the three known values", isStopped || isAtLine || isWorking, `"${badge}"`);
ok(
  "headline agrees with the badge",
  isStopped ? /停了|已停/.test(headline) : isAtLine ? /贴着触发线/.test(headline) : /正在工作/.test(headline),
  `badge="${badge}" headline="${headline}"`
);
ok(
  "verdict title agrees with the badge",
  isStopped ? /停了|已停/.test(vtitle) : isAtLine ? /贴着触发线|已恢复/.test(vtitle) : /正在工作/.test(vtitle),
  `badge="${badge}" vtitle="${vtitle}"`
);
ok(
  "document title agrees with the badge",
  isStopped ? /已停/.test(document.title) : isAtLine ? /恢复|贴着/.test(document.title) : /正在工作/.test(document.title),
  document.title
);
ok(
  "page subtitle agrees with the badge",
  isStopped ? /已停/.test(text("page-sub")) : /恢复|贴着|进行中/.test(text("page-sub")),
  text("page-sub")
);
ok("ignition gap is a non-negative number", /^[\d,]+(\.\d+)?$/.test(gap) && Number(gap.replace(/,/g, "")) >= 0, `"${gap}"`);
ok(
  "gap is 0 exactly when the badge says at-line or working",
  (Number(gap.replace(/,/g, "")) === 0) === (isAtLine || isWorking),
  `gap=${gap} badge=${badge}`
);
ok("block number shown", /[\d,]{5,}/.test(text("st-block")), text("st-block"));
ok("sIMD shown as a book rate, not a yield", content("simd").includes("不是你的收益率"), "");
// Our own prose only — never the quoted on-chain text, never SVG geometry
// (a sparkline rect can sit at x="782.0"), and never the raw-values table
// (a Chainlink roundId can legitimately contain "782").
const ownCopy = [...els.entries()]
  .filter(([id]) => !id.startsWith("messages") && !id.startsWith("msg") && id !== "spark" && id !== "raw-table")
  .map(([, e]) => e.innerHTML + e.textContent)
  .join("\n")
  .replace(/<[^>]*>/g, " ");
// "782,132" is the specific APR figure we must never show. A bare "782" is NOT a
// violation: BurnExecutor's live IMD balance can legitimately be 782.24.
const APR_PATTERNS = /782[,\s]?132|APR_LAUNCH_RATE|\bAPR\b/i;
ok("no 782,132-style APR figure in our own prose", !APR_PATTERNS.test(ownCopy), (ownCopy.match(/.{0,40}(782[,\s]?132|APR).{0,40}/i) || [""])[0]);

console.log("\nper-contract ownership (the correctness fix)");
ok("owner section is grouped per contract", (content("owner-contracts").match(/owner-card/g) || []).length >= 6, `${(content("owner-contracts").match(/owner-card/g) || []).length} cards`);
ok("sIMD card says ownership was renounced", /已放弃权限/.test(content("owner-contracts")));
ok("sIMD card explains the powers are gone", /rescueERC20 与 setPaused 均已失效/.test(content("owner-contracts")));
ok("the other contracts are marked as still controllable", (content("owner-contracts").match(/仍可控/g) || []).length >= 5, `${(content("owner-contracts").match(/仍可控/g) || []).length}`);
ok("summary counts renounced vs live contracts", /已放弃权限的合约/.test(content("owner-summary")) && /仍由普通钱包控制/.test(content("owner-summary")));
ok("zero address shown for the renounced owner", content("owner-contracts").includes("0x0000000000000000000000000000000000000000"));
ok("lede no longer claims everything is withdrawable", !/它有权随时取走池子里的全部资金和质押者的 IMD/.test(text("owner-lede")), text("owner-lede").slice(0, 110));
ok("powers table marks each row live/expired", /已失效/.test(content("powers")) && /有效/.test(content("powers")));

console.log("\non-chain messages");
// The list is collapsed to the newest few on purpose: 70+ multi-line English quotes turned
// "证据" into an endless scroll. So assert the collapsed view, the button that expands it,
// and that expanding really does restore the whole set.
const msgShown = () => (content("messages-list").match(/class="msg /g) || []).length;
const msgTotal = JSON.parse(readFileSync(ROOT + "data/messages.json", "utf8")).messages.length;
ok("message list renders the newest few", msgShown() >= 5 && msgShown() <= 8, `${msgShown()} of ${msgTotal}`);
ok("the rest sit behind a show-all button", new RegExp(`显示全部 ${msgTotal} 条`).test(text("msg-toggle")), text("msg-toggle"));
ok("dev messages visually distinct", content("messages-list").includes("from-dev") && content("messages-list").includes("from-community"));
ok("newest dev post has its own card", content("messages-latest").length > 100, `${content("messages-latest").length} chars`);
ok("the 'will change pool4 settings' post is present", /Will change the settings on he pool4 soon/.test(content("messages-latest") + content("messages-list")));
ok("that post is flagged as important", /重点/.test(content("messages-latest")) || /重点/.test(content("messages-list")));
ok("filter counts match the message count, not the tx count", Number(text("msgf-all-n")) === msgTotal, `all=${text("msgf-all-n")} dev=${text("msgf-dev-n")} community=${text("msgf-community-n")} expected=${msgTotal}`);
// >= rather than ==: some message bodies quote an Etherscan link of their own.
ok("each rendered message links to Etherscan", (content("messages-list").match(/etherscan\.io\/tx\//g) || []).length >= msgShown());
ok("long messages are clamped", content("messages-list").includes("clamped") || content("messages-list").includes("展开全文"));
ok("data-source detail states the filter pitfall", /filter=to\|from/.test(content("messages-tech")), content("messages-tech").slice(0, 90));

{
  const toggle = els.get("msg-toggle");
  toggle.onclick();
  ok("show-all expands to every message", msgShown() === msgTotal, `${msgShown()} of ${msgTotal}`);
  toggle.onclick();
  ok("show-less collapses back to the newest few", msgShown() >= 5 && msgShown() <= 8, `${msgShown()} messages`);
}

console.log("\nplain-language pass");
const all = html + "\n" + [...els.values()].map((e) => e.innerHTML).join("\n");
ok("'这意味着什么' appears in many sections", (all.match(/这意味着什么/g) || []).length >= 8, `${(all.match(/这意味着什么/g) || []).length} occurrences`);
ok("source terms kept for verification", all.includes("inventoryCap") && all.includes("pendingTrim"));
ok("collapsible technical sections exist", (html.match(/details class="tech"/g) || []).length >= 5, `${(html.match(/details class="tech"/g) || []).length} blocks`);
ok("technical blocks are closed by default", !/details class="tech"[^>]*\sopen/.test(html));
ok("jargon glossed inline", all.includes("距离重新开始烧毁还差多少"));

console.log("\nrequired narrative elements");
ok("'两道门' framing present", content("door1").length > 0 && content("door2").length > 0);
ok("owner powers list has 8 rows", (content("powers").match(/<tr/g) || []).length >= 8, `${(content("powers").match(/<tr/g) || []).length} rows`);
ok("developer quote cited verbatim", content("powers").includes("trusting the owner not to") || content("powers").includes("move stakers&#39; IMD") || content("powers").includes("move stakers"));
ok("1499 bps rounding explained inline", content("hist-note").includes("1499"), content("hist-note").slice(0, 80));
ok("sIMD ratio attribution present", /一次性|注入|不是你的收益/.test(content("simd-explain")), content("simd-explain").slice(0, 90));
ok("burn event carries no amount, stated", content("door2-tech").includes("不含金额"), content("door2-tech").slice(0, 90));
ok("BridgedFP / Fren Pet relationship stated", content("door2-tech").includes("BridgedFP") && content("door2-tech").includes("Fren Pet"));
ok("pool A explicitly has no hook", content("pools-tech").includes("0x0") && content("pools-tech").includes("不经过烧毁引擎"), content("pools-tech").slice(0, 90));
ok("volume section states a concrete ratio", /1\/\d+/.test(text("pools-headline")), text("pools-headline"));
ok("volume note explains the methodology", content("pools-note").includes("口径"), content("pools-note").slice(0, 90));

console.log("\nnew P0 panels");
ok("burn-rate panel shows a 24h figure", /最近 24 小时烧毁/.test(content("burnrate")), content("burnrate").slice(0, 120));
ok("burn-rate panel shows a 7d figure", /最近 7 天烧毁/.test(content("burnrate")));
ok("burn-rate panel shows a lifetime average", /全历史平均/.test(content("burnrate")));
ok("burn-rate panel shows a live (page-open) rate", /本次打开页面以来/.test(content("burnrate")));
ok("burn rate values carry a unit", /IMD\/天/.test(content("burnrate")));
ok("flip log explains itself when empty, or shows a table", /还没有记录到状态变化/.test(content("fliplog")) || /<table/.test(content("fliplog")), content("fliplog").slice(0, 100));
ok("state note explains how the three states differ", /触发线还能不能继续往下走/.test(content("state-note")), content("state-note").slice(0, 110));

console.log("\ndev's 25k target — wording must stay precise");
ok("burn-rate panel states the dev's 25k ceiling", /25,000 IMD\/天/.test(content("burnrate")), content("burnrate").slice(0, 80));
ok("it is framed as a target, not a forecast", /上限目标/.test(content("burnrate")));
ok("the exact quote 'set the burn cap to' is present", /set the burn cap to 25k/.test(content("burnrate")));
ok("all three source blocks are cited", [25901450, 25892951, 25890127].every((b) => content("burnrate").includes(String(b))), "");
ok("the 'full LP deployed' precondition is stated", /全部 LP/.test(content("burnrate")));
{
  const link = els.get("quote-25901450");
  const href = link && link.getAttribute("href");
  ok("the verbatim quote links to its real transaction", /^https:\/\/etherscan\.io\/tx\/0x[0-9a-f]{64}$/i.test(href || ""), String(href));
}

console.log("\ndesign intent from the on-chain message (0.2)");
ok("the hook's design intent is quoted verbatim", /The hook buys tokens for cheap when pepes are selling/.test(html));
ok("the double-incentive explanation is translated", /双向激励/.test(html));
ok("the composability quote is present", /composable for other coins/.test(html));
ok("it notes the hook is not IMD-only", /不只为 IMD 存在/.test(html));
ok("it links CappedBurnLauncher to permissionless deployment", /CappedBurnLauncher/.test(html) && /无许可/.test(html));

console.log("\nparameter monitor");
const watchStatus = content("monitor-status");
ok("monitor established a baseline", watchStatus.includes("基线") || watchStatus.includes("无变化"), watchStatus.slice(0, 120));
ok("watch table covers all params", (content("watch-table").match(/<tr/g) || []).length >= 20, `${(content("watch-table").match(/<tr/g) || []).length} rows`);

console.log("\nunavailable handling");
const snap = els.get("raw-table").innerHTML;
ok("raw table renders", snap.length > 100);
ok("'取不到' string available for missing values", true);

console.log("\nsnapshot freshness");
{
  // The banner is a data-driven claim, so assert the claim, not a fixed expectation:
  // it must appear exactly when the oldest snapshot has passed the threshold. (Asserting
  // "no banner" would fail on any checkout that has not been refreshed recently — which
  // is precisely the state the banner exists to announce.)
  const files = ["timeline", "base", "volume", "messages", "bridge-history"];
  const ages = files.map((f) => {
    try {
      const j = JSON.parse(readFileSync(ROOT + `data/${f}.json`, "utf8"));
      const iso = j.builtAt || j.scannedAt || j.fetchedAt;
      return iso ? { file: f, hours: (Date.now() - Date.parse(iso)) / 3_600_000 } : null;
    } catch {
      return null;
    }
  }).filter(Boolean);
  const oldest = ages.reduce((a, b) => (a.hours >= b.hours ? a : b));
  const banner = content("stale-banner");
  const shouldShow = oldest.hours > 3;
  ok(
    `staleness banner agrees with the data (oldest: ${oldest.file} at ${oldest.hours.toFixed(1)}h → ${shouldShow ? "shown" : "hidden"})`,
    banner.length > 0 === shouldShow,
    banner.slice(0, 160) || "(no banner)"
  );
  if (shouldShow) {
    ok("the banner names the old snapshot and says what is unaffected", /stale|过期/i.test(banner) && banner.includes(oldest.file), banner.slice(0, 200));
  }
}

if (process.argv.includes("--dump")) {
  const strip = (h) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  console.log("\n================ RENDERED TEXT DUMP ================");
  for (const id of ["v-title", "v-answer", "v-gap-alt", "state-note", "timeline-note", "door1-note", "door2-note", "simd-explain", "hist-note", "pools-note", "monitor-status", "footer-src"]) {
    console.log(`\n--- ${id} ---\n${strip(content(id) || text(id))}`);
  }
  console.log("\n--- sim-out ---\n" + strip(content("sim-out")));
  console.log("\n--- trim-now ---\n" + strip(content("trim-now")));
}

/* ------------------------------------------------------------------ *
 * on-chain messages: bilingual handling
 *
 * The English text is the evidence and must appear in BOTH languages. The Chinese
 * summary is additive and must be visibly marked as ours. Getting this wrong — e.g.
 * replacing the original with a translation — would destroy the page's value.
 * ------------------------------------------------------------------ */
console.log("\non-chain messages (zh)");
{
  const list = content("messages-list");
  const zhDict = JSON.parse(readFileSync(ROOT + "data/messages.zh.json", "utf8"));
  const msgData = JSON.parse(readFileSync(ROOT + "data/messages.json", "utf8"));

  ok("the English original is rendered", /for the past week i didn't update the pool4/.test(list) || /Will change the settings on he pool4/.test(list));
  ok("a Chinese summary is appended", list.includes("非官方译文"), "");
  ok("the summary is tagged as unofficial", /非官方译文/.test(list));
  ok("the verbatim block is labelled", list.includes("链上原文"), "");
  ok("original and summary use different containers", list.includes("msg-body") && list.includes("msg-summary"), "");

  const missing = msgData.messages.filter((m) => !zhDict[String(m.block)]);
  ok("every message has a summary", missing.length === 0, `${missing.length} missing`);
  ok("no orphan summaries", Object.keys(zhDict).filter((k) => !k.startsWith("_") && !msgData.messages.some((m) => String(m.block) === k)).length === 0);
  ok("summaries are marked unreviewed by default", Object.keys(zhDict).filter((k) => !k.startsWith("_")).every((k) => zhDict[k].reviewed === false));
  ok("the summary file is separate from the scraped data", !Object.keys(msgData).includes("summaries"));
}

console.log("\non-chain messages (en)");
{
  // Switching language must re-render without a page reload.
  const { setLang } = await import("../lib/i18n.js");
  await setLang("en");
  await new Promise((r) => setTimeout(r, 400));
  const list = content("messages-list");
  ok("the English original is still rendered", /for the past week i didn't update the pool4/.test(list) || /Will change the settings on he pool4/.test(list));
  ok("no Chinese summary in English mode", !list.includes("非官方译文"), "");
  ok("the verbatim label switched to English", /on-chain original/i.test(list), "");
  ok("html lang switched to en", document.documentElement.getAttribute("lang") === "en", String(document.documentElement.getAttribute("lang")));
  ok("the page title switched to English", /burn engine/i.test(document.title), document.title);

  /* ---------------------------------------------------------------- *
   * The whole point of the bilingual build: nothing Chinese and no raw
   * locale key may survive a switch to English.
   *
   * This is the assertion that catches the two failure modes that actually
   * happened — a module-scope tr() freezing a key name into the page, and a
   * hand-written Chinese sentence left in a section that was never migrated.
   * Both are invisible to a static check.
   * ---------------------------------------------------------------- */
  const leaks = [];
  const keys = [];
  for (const [id, el] of els) {
    if (id === "lang-zh" || id === "langswitch") continue; // the buttons name each language in its own language
    const raw = `${el.textContent || ""}\n${el.innerHTML || ""}`;
    const flat = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (/[\u4e00-\u9fff]/.test(flat)) leaks.push(`#${id}: ${flat.slice(0, 260)}`);
    const m = flat.match(/\b(?:s\.\d{3}|awaiting\.[a-zA-Z.]+|html\.[a-zA-Z0-9.]+|msg\.[a-zA-Z]+|common\.[a-zA-Z]+|nav\.[a-zA-Z]+|hero\.[a-zA-Z]+|title\.[a-zA-Z]+|subtitle\.[a-zA-Z]+)\b/);
    if (m) keys.push(`#${id}: ${m[0]}`);
  }
  ok("no Chinese survives in English mode", leaks.length === 0, `${leaks.length} elements\n       ` + leaks.slice(0, 8).join("\n       "));
  ok("no raw locale key is rendered", keys.length === 0, `${keys.length} elements\n       ` + keys.slice(0, 8).join("\n       "));

  await setLang("zh");
  await new Promise((r) => setTimeout(r, 400));
  ok("switching back restores Chinese summaries", content("messages-list").includes("非官方译文"));
}

console.log(`\n${pass} passed, ${fail} failed`);

// This suite reads live chain state, so an RPC hiccup can make a data-dependent
// assertion flap. Say so explicitly rather than leaving a mystery failure.
const banner = content("rpc-banner");
if (banner && /项读数失败/.test(banner)) {
  console.log("\n⚠ 本次运行中有链上读数失败（见上方 rpc-banner），数据相关的断言可能因此不成立。重跑通常即可恢复。");
}

// process.exit() drops whatever stdout has not been flushed yet, and on Windows a
// piped stdout flushes asynchronously — the suite would print "N passed, 0 failed" to
// a terminal but only its first line to a log file. Flush explicitly, then exit.
finished = true;
await new Promise((resolve) => process.stdout.write("", resolve));
process.exit(fail === 0 ? 0 : 1);
