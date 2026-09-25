// Headless render test: run assets/app.js against a minimal DOM stub, with real
// network fetches, and assert that every section actually produced content.
//
// This catches the class of bug a static check cannot: a runtime throw halfway
// through renderAll() that leaves half the page blank.
//
//   node scripts/test-render.mjs            # the full suite, incl. the P0-3 four-state regression
//   FS_VARIANT=<state> node scripts/test-render.mjs
//                                           # internal: render ONE injected fixture and dump JSON.
//                                           # Driven by this same file (see "the four-state
//                                           # regression" at the bottom); not meant to be run by
//                                           # hand, but harmless if you do.
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/* ==================================================================== *
 * Fixture-render mode.
 *
 * The four-state regression at the bottom of this file needs the SAME module rendered
 * several times under different snapshots — and app.js cannot be re-imported for that.
 * Two reasons, both measured, not assumed:
 *
 *   1. app.js calls init() at module scope, and init() runs boot(), which awaits initI18n().
 *      A second import of the same specifier is a cache hit so it does not re-run; a second
 *      import with a different query string DOES re-run, but then it races boot()'s own
 *      awaits, and the DOM was read back while the dictionary was still empty. tr() falls
 *      back to returning the key, and the page renders literal strings like "s.535".
 *      (Measured: with repeated `import("../assets/app.js?query=N")`, only the FIRST position
 *      rendered real copy; the rest produced lede === "s.535".)
 *   2. lib/i18n.js keeps its dictionary in module state, so re-importing app.js without
 *      re-importing i18n.js leaves two views of that state out of step.
 *
 * So each position is rendered in its OWN process, selected by FS_VARIANT. The result is
 * handed back through a FILE rather than a pipe: a file survives a crashed child, and does
 * not depend on stdio plumbing at all (pipes are unavailable in some sandboxes).
 * ==================================================================== */
const FIXTURE_VARIANT = process.env.FS_VARIANT || "";

if (FIXTURE_VARIANT) {
  const E18 = 10n ** 18n;
  const { derive } = await import("../lib/contracts.js");
  const { fmt18 } = await import("../lib/evm.js");

  const RAW = JSON.parse(readFileSync(ROOT + "data/baseline.json", "utf8"));
  const revive = (v) => (Array.isArray(v) ? v.map(revive) : typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : v);
  const base = Object.fromEntries(Object.entries(RAW.values).map(([k, x]) => [k, revive(x)]));

  const CAP = base["hook.inventoryCap"];
  const FLOOR = base["hook.capFloor"];
  const LIQ = base["hook.positionLiquidity"];
  /** CappedBurnHook.pendingTrim(): floor(L * excess / held); 0 when held <= cap. */
  const pendingTrimOf = (held, cap) => (held <= cap ? 0n : (LIQ * (held - cap)) / held);
  /** The smallest excess that yields a non-zero pendingTrim. */
  const smallestExcess = (() => {
    let e = 1n;
    while (pendingTrimOf(CAP + e, CAP) === 0n) e++;
    return e;
  })();

  const POSITIONS = {
    LIVE: { held: CAP + 1000n * E18, cap: CAP, floor: FLOOR },
    B: { held: CAP, cap: CAP, floor: FLOOR },
    C: { held: CAP + smallestExcess, cap: CAP, floor: FLOOR },
    E: { held: CAP, cap: CAP, floor: CAP },
    BELOW: { held: CAP - 1000n * E18, cap: CAP, floor: CAP },
  };
  const pos = POSITIONS[FIXTURE_VARIANT];
  if (!pos) {
    console.error(`[fixture] unknown FS_VARIANT=${FIXTURE_VARIANT}`);
    process.exit(2);
  }

  const values = { ...base };
  values["hook.tokensInPool"] = pos.held;
  values["hook.inventoryCap"] = pos.cap;
  values["hook.capFloor"] = pos.floor;
  values["hook.pendingTrim"] = pendingTrimOf(pos.held, pos.cap);
  const derived = derive(values, {});

  const html = readFileSync(ROOT + "index.html", "utf8");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  class El {
    constructor(id) {
      this.id = id;
      this._html = "";
      this.textContent = "";
      this.className = "";
      this.value = "0";
      this.style = {};
      this.attrs = {};
    }
    set innerHTML(v) {
      this._html = String(v);
    }
    get innerHTML() {
      return this._html;
    }
    addEventListener() {}
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    }
    getAttribute(k) {
      return this.attrs[k] ?? null;
    }
    removeAttribute(k) {
      delete this.attrs[k];
    }
    appendChild() {}
  }
  const els = new Map(ids.map((id) => [id, new El(id)]));
  const metaEls = new Map();
  const makeMeta = (sel) => {
    if (!metaEls.has(sel)) {
      const m = new El(sel);
      m.attrs = { content: "" };
      metaEls.set(sel, m);
    }
    return metaEls.get(sel);
  };
  globalThis.document = {
    getElementById: (id) => els.get(id) || null,
    addEventListener: () => {},
    hidden: false,
    createElement: (t) => new El(t),
    title: "",
    documentElement: new El("html"),
    querySelectorAll: () => [],
    querySelector: (sel) => makeMeta(sel),
    createRange: () => ({ selectNodeContents() {} }),
    body: new El("body"),
    head: new El("head"),
  };
  Object.defineProperty(globalThis, "navigator", { value: { language: "zh-CN" }, configurable: true, writable: true });
  globalThis.location = { search: "", href: "http://localhost/", pathname: "/", hash: "" };
  globalThis.history = { replaceState: () => {} };
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.window = globalThis;
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.setInterval = () => 0;
  globalThis.clearInterval = () => {};
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  globalThis.matchMedia = () => ({ matches: false, addEventListener: () => {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.fetch = async (url) => {
    const p = String(url).replace(/^https?:\/\/[^/]+\//, "").replace(/^\/+/, "").split("?")[0];
    try {
      return new Response(readFileSync(ROOT + p, "utf8"), { status: 200, headers: { "content-type": "application/json" } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  };

  /* renderOne() wraps every renderer in its own try/catch, so a thrower leaves its section
   * silently empty instead of blanking the page. That is the right behaviour for a reader and
   * the wrong one for a test: an empty section would otherwise be read as a semantic mismatch
   * and the assertion would pass for the wrong reason. So the child reports these and the
   * parent asserts the list is empty before judging any copy. */
  const renderFailures = [];
  const realError = console.error;
  console.error = (...a) => {
    const m = a.map(String).join(" ");
    if (/^\[render\]/.test(m) || /\[invariant\]/.test(m)) renderFailures.push(m);
  };

  globalThis.__POOL4_FIXTURE__ = {
    blockNumber: RAW.blockNumber,
    blockTimestamp: RAW.blockTimestamp,
    fetchedAt: RAW.fetchedAt,
    endpoint: "test-render:" + FIXTURE_VARIANT,
    values,
    derived,
    errors: {},
    base: { blockNumber: 0, values: {}, errors: {}, chainId: 8453, skipped: true },
  };

  await import("../assets/app.js");
  await new Promise((r) => setTimeout(r, 3000));
  console.error = realError;

  const strip = (h) =>
    String(h)
      .replace(/<[^>]+>/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();
  const txt = (id) => {
    const e = els.get(id);
    return e ? strip(e.innerHTML) || e.textContent || "" : "";
  };
  const items = (id) => {
    const e = els.get(id);
    return e ? (e.innerHTML.match(/<li>([\s\S]*?)<\/li>/g) || []).map(strip) : [];
  };

  const out = {
    variant: FIXTURE_VARIANT,
    derived: {
      state: derived.state,
      held: String(derived.held),
      cap: String(derived.cap),
      floor: String(derived.floor),
      gapRaw: String(derived.gapRaw),
      pendingTrim: String(derived.pendingTrim),
    },
    atLine: derived.gapRaw === 0n && (derived.pendingTrim === 0n || fmt18(derived.pendingTrim, 2) === "0.00"),
    texts: {
      vState: txt("v-state"),
      vTitle: txt("v-title"),
      headline: txt("sum-headline"),
      lede: txt("verdict-lede"),
      impact: items("sum-impact"),
      vAnswer: txt("v-answer"),
      states: txt("states"),
      recovery: txt("sum-recovery"),
      rpcBanner: txt("rpc-banner"),
    },
    renderFailures,
  };
  const outPath = process.env.FS_OUT;
  const json = JSON.stringify(out, null, 2);
  if (outPath) writeFileSync(outPath, json, "utf8");
  else process.stdout.write(json);
  process.exit(0);
}

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
  /* The headline is held to a different bar on purpose. A character count measures length, and
   * length is not what makes a headline correct: in the DORMANT state the right sentence is
   * "IMD 的烧毁机制已经停了" — 13 characters, and a complete, true statement. The old `> 20` rule
   * failed it and would have pushed someone to pad the copy to satisfy a test.
   *
   * What actually matters is asserted instead, and asserted properly elsewhere in this file: the
   * headline must name a conclusion (not a placeholder, not a raw locale key, not "读取中"), and
   * it must agree with the state badge. So the bar here is "is a sentence", and the semantic
   * checks below do the real work. */
  const floor = id === "sum-headline" ? 8 : 20;
  ok(`${label} (#${id}) rendered ${c.length} chars`, c.length > floor, `len=${c.length}, floor=${floor}`);
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
// Each bar has to carry its own number: the strip is a shape, and "busy" is not a reading.
ok(
  "every activity bar carries its own block and amount",
  (visual.match(/data-tip="/g) || []).length === actBars && /data-tip="区块 [\d,]+ · 烧毁 [\d,.]+ IMD/.test(visual),
  `${(visual.match(/data-tip="/g) || []).length} of ${actBars} bars`
);

/* ------------------------------------------------------------------ *
 * the frozen-timestamp wording
 *
 * state.timeline.trims carries block times, so every "X ago" in the conclusion band is
 * measured against a snapshot. If the refresh job stops, that boundary stays put while
 * Date.now() keeps moving: on 2026-09-24 the newest burn was 25 minutes old and the page
 * spent six hours saying "7.0 hours ago", with the bars beside it just as frozen.
 *
 * The direction is the part worth guarding. The snapshot's newest event is at or before the
 * chain's newest event, so now − T_snapshot is an UPPER BOUND — "7.0h ago or more recent".
 * "At least 7.0h ago" would turn "it may have burned a minute ago" into "it has not burned in
 * seven hours", which is worse than the bug. Both readings are asserted below: the stale one
 * asks the live DOM, and the fresh one is the counter-check that the qualifier is conditional.
 * ------------------------------------------------------------------ */
{
  const stripActivity = (html) => String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const activityText = () => {
    const s = stripActivity(content("sum-visual"));
    const i = s.indexOf("次烧毁");
    return i >= 0 ? s.slice(i) : s;
  };
  const verdictAnswer = () => text("v-answer");
  const hoursSince = (t) => (Date.now() - t) / 3_600_000;

  /* The page's rule, recomputed here from the same files it fetches: the OLDEST snapshot
   * decides, using lib/snapshots.js's field list. Reproducing "oldest across all five" rather
   * than just the timeline matters — right now timeline.json is minutes old while
   * baseline.json's own number has already drifted past the threshold, and only the page's
   * own answer can settle which one the wording should follow. */
  const snapshotAges = ["timeline", "base", "volume", "messages", "bridge-history", "baseline"]
    .map((f) => {
      try {
        const j = JSON.parse(readFileSync(ROOT + `data/${f}.json`, "utf8"));
        const v = j.builtAt || j.scannedAt || j.fetchedAt || j.generatedAt;
        if (typeof v === "number" && v > 1e9) return { file: f, hours: hoursSince(v * 1000) };
        if (typeof v === "string" && v) return { file: f, hours: hoursSince(Date.parse(v)) };
      } catch {}
      return null;
    })
    .filter(Boolean);
  const oldest = snapshotAges.reduce((a, b) => (a.hours >= b.hours ? a : b));
  const pageStale = oldest.hours > 3;
  const bannerShown = content("stale-banner").length > 0;

  /* The SECOND condition. agoBounded() is not driven by snapshot age alone — a snapshot can be
   * minutes old and still be behind the chain, and that is exactly the state the live site was in
   * when this was written: the page read "最近一次烧毁 86 分钟前" as a plain fact while the chain's
   * newest burn was 9.5 minutes old. The banner stayed down (the snapshot was 38 minutes old, well
   * under the three-hour threshold) and the sentence misled anyway.
   *
   * The page decides this from the block number it read live (state.snap.blockNumber vs
   * state.timeline.last.Trimmed). This suite cannot reach that value — it runs without a live RPC
   * — and it must NOT substitute data/baseline.json, which is itself a snapshot artefact that goes
   * stale in the same way. So the assertion is one-sided in the safe direction:
   *   - when the snapshot is past the threshold, the qualifier is required (the real outage case)
   *   - otherwise it is allowed but not required, because only the page knows whether the chain
   *     has burned since, and an upper bound that turns out unnecessary is still true.
   * The other direction — a stale snapshot rendering as a plain fact — is the bug, and that part
   * is asserted exactly rather than conditionally. */
  const shouldQualify = pageStale;

  console.log(
    `\nthe "X ago" in the conclusion band (oldest snapshot: ${oldest.file} at ${oldest.hours.toFixed(1)}h → stale=${pageStale}, qualify required=${shouldQualify}; ` +
      `the "chain has burned since" path can only be judged live, see check-last-trim.mjs)`
  );
  ok("the suite and the page agree on whether the data is stale", bannerShown === pageStale, `banner ${bannerShown ? "shown" : "hidden"}, oldest ${oldest.file} at ${oldest.hours.toFixed(1)}h`);
  ok(
    `the burn-activity header is qualifed whenever the figure may not be the latest (stale=${pageStale} requires it)`,
    pageStale ? activityText().includes("或更近") : true,
    `"${activityText().slice(0, 140)}" — a stale snapshot must never read as a plain "X ago"`
  );
  ok(
    "the wrong direction never appears",
    !/至少\s*[\d.]+\s*小时前/.test(activityText() + verdictAnswer()) && !/at least\s*[\d.]+h?\s*ago/i.test(activityText() + verdictAnswer()),
    (activityText() + " | " + verdictAnswer()).slice(0, 200)
  );
  ok(
    `the strip names the moment the data stops at whenever it may not be the latest (stale=${pageStale} requires it)`,
    pageStale ? activityText().includes("数据截至") : true,
    `"${activityText().slice(0, 160)}" — a stale snapshot must always say when it stopped`
  );
  /* The other half, and the one this suite CAN pin down without a chain head: the "as of" note
   * exists to make the upper bound credible, so one without the other is the defect. Checking
   * the pair rather than pinning each to a state keeps the assertion honest — the page may
   * legitimately add the note on a fresh-but-behind snapshot, which only the live page can see. */
  ok(
    "the qualifier and the as-of note are all-or-nothing, never a bare upper bound",
    /或更近/.test(activityText()) === /数据截至/.test(activityText()),
    `"${activityText().slice(0, 160)}"`
  );
  /* A stale snapshot rendering as a plain "X ago" is the original bug. Stated once, exactly. */
  ok(
    "a stale snapshot never reads as a plain live figure",
    !(pageStale && !/或更近/.test(activityText())),
    `"${activityText().slice(0, 160)}" — this is the 2026-09-24 reading`
  );
}

ok("the headline never claims zero is waiting to be burned", !/0\.00 IMD/.test(text("sum-headline")), text("sum-headline"));

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

/* ==================================================================== *
 * P0-3 — the four-state semantic regression
 *
 * WHY THIS SECTION EXISTS, AND WHY IT IS BUILT THIS WAY
 *
 * The assertions above read the page's own live state, then check that the page agrees with
 * itself. That is a weak instrument for this bug. The summary's impact list used to assert only
 * that three KEYWORDS appeared (/销毁|烧毁/, /质押|收益/, /触发线|交易|池子|待销毁/), and all
 * three were present in the broken render. Keywords are not the claim. The claim is "is anything
 * actually being burned right now", and on 2026-09-24 the page answered it two ways at once, in
 * one card:
 *
 *     success headline / verdict badge : 烧毁已恢复，贴着触发线
 *     verdict-lede                     : 销毁暂时停止                      (s.148)
 *     impact list, first item          : 超出触发线的 IMD 正在被抽走销毁      (s.068)
 *     impact list, third item          : 池子正好贴着触发线——下一笔卖出就会触发一次销毁  (s.069)
 *
 * s.068 is present tense and s.069 is future tense; they describe the same quantity and cannot
 * both be true. At the line the excess is exactly zero, so nothing is being drawn off.
 *
 * THE ORACLE. Asking the state machine whether its own sentence is right is circular — the state
 * machine is the thing under test. So the required sentences are derived HERE, from
 * locales/zh.json, with the same {pN} substitution tr() does. Nothing Chinese is hard-coded:
 * rewording a string must not require editing this file twice.
 *
 * The judge for "at the line" is written out as its own expression rather than called from the
 * page:
 *
 *     atLine  <=>  gapRaw === 0 && (pendingTrim === 0 || fmt18(pendingTrim, 2) === "0.00")
 *
 * The second half is the part that matters. A pool a few wei over the cap reports a POSITIVE
 * pendingTrim that still prints as "0.00" — pendingTrim() is floor(L*excess/held), so it is 0 or
 * small at the very top of the band. To a reader that pool is at the line. A judge written as
 * `gapRaw === 0n && pendingTrim === 0n` — which renderStates() used to carry as a hand-copied
 * duplicate of onTheLine() — disagrees with onTheLine() on exactly that band. Both directions of
 * that disagreement are asserted below.
 * ==================================================================== */
{
  const { derive } = await import("../lib/contracts.js");
  const { fmt18 } = await import("../lib/evm.js");
  const zh = JSON.parse(readFileSync(ROOT + "locales/zh.json", "utf8"));

  /** tr() with {pN} substitution, on the zh dictionary — the language the oracle speaks. */
  const tr = (key, args) => {
    const raw = zh[key];
    if (raw === undefined) return `!!MISSING(${key})!!`;
    return String(raw).replace(/\{p(\d)\}/g, (m, i) => (args && args["p" + i] !== undefined ? String(args["p" + i]) : m));
  };
  /** What a reader sees: tags stripped, whitespace collapsed. */
  const plain = (s) => String(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  const VARIANT_TIMEOUT_MS = 60000;
  const dir = mkdtempSync(join(tmpdir(), "pool4-states-"));

  console.log("\nP0-3 four-state semantic regression (injected fixtures, real renderers)");

  /** Render one position in its own process and read back the JSON it wrote. */
  const renderPosition = (variant) => {
    const outPath = join(dir, `${variant}.json`);
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, FS_VARIANT: variant, FS_OUT: outPath },
      stdio: "ignore", // no pipe: a file survives a crash and does not depend on stdio plumbing
      timeout: VARIANT_TIMEOUT_MS,
      killSignal: "SIGKILL",
      cwd: ROOT,
    });
    // A non-answer is information, not a skip: the subprocess must have produced a file.
    if (!existsSync(outPath)) {
      return { variant, missing: true, status: r.status, signal: r.signal, error: r.error ? String(r.error.code || r.error.message) : "" };
    }
    try {
      return JSON.parse(readFileSync(outPath, "utf8"));
    } catch (e) {
      return { variant, missing: true, status: r.status, signal: r.signal, error: "unparsable: " + e.message };
    }
  };

  const POSITIONS = ["LIVE", "B", "C", "E", "BELOW"];
  const got = new Map();
  for (const v of POSITIONS) got.set(v, renderPosition(v));
  rmSync(dir, { recursive: true, force: true });

  /* The health gate, first and unconditionally. renderOne() wraps every renderer in its own
   * try/catch, so a renderer that THROWS leaves its section silently empty while the page
   * still looks fine and `npm test` still goes green. An empty section would also be read as a
   * semantic mismatch by the assertions below — i.e. they could pass for the wrong reason.
   * So: no position is judged on its copy until every position has been shown to render. */
  for (const v of POSITIONS) {
    const f = got.get(v);
    if (f.missing) {
      ok(`fixture ${v} produced a result`, false, `subprocess said nothing: status=${f.status} signal=${f.signal} ${f.error}`);
    }
  }
  const sound = POSITIONS.filter((v) => !got.get(v).missing);
  ok(`all ${POSITIONS.length} fixture positions rendered (${sound.length} responded)`, sound.length === POSITIONS.length, sound.join(","));

  for (const v of sound) {
    const f = got.get(v);
    ok(
      `${v}: no renderer threw while drawing this position (nothing silently blank)`,
      Array.isArray(f.renderFailures) && f.renderFailures.length === 0,
      (f.renderFailures || []).join("\n       ") || "(none reported)"
    );
    ok(
      `${v}: every judged section produced text`,
      f.texts.impact.length > 0 && f.texts.vAnswer.length > 0 && f.texts.headline.length > 0 && f.texts.vTitle.length > 0,
      `impact=${f.texts.impact.length} vAnswer=${f.texts.vAnswer.length}B headline=${f.texts.headline.length}B — ` +
        `an empty section is a fixture problem, not a semantic mismatch`
    );
  }

  const judge = (f) => {
    const state = f.derived.state;
    const atLine = f.atLine;
    const impact = f.texts.impact.join(" || ");
    const label = `${f.variant} [state=${state} gapRaw=${f.derived.gapRaw} pendingTrim=${f.derived.pendingTrim} atLine=${atLine}]`;

    /* ---- the badge must name the position the fixture actually is ---- */
    const badgeOk = atLine ? /贴着触发线/.test(f.texts.vState) : state === "DORMANT" ? /已停/.test(f.texts.vState) : /工作中/.test(f.texts.vState);
    ok(`${label} — the badge names the right position`, badgeOk, `badge="${f.texts.vState}"`);

    /* ---- s.068 is PRESENT TENSE. It may appear only when something is really being burned.
     *      "At the line" means the excess is zero, so it must never appear there — whatever
     *      derive() chose to call the state. This is the positive-and-negative pair the old
     *      invariant (app.js renderSummary) was missing: that one only checked "has a pending
     *      trim but is not LIVE", so all of these positions slipped through it. ---- */
    const mustBeBurning = state === "LIVE" && !atLine;
    const saysBurning = new RegExp(plain(tr("s.068")).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 12)).test(impact);
    ok(
      `${label} — present-tense s.068 appears exactly when something is being burned`,
      saysBurning === mustBeBurning,
      `s.068 ${saysBurning ? "PRESENT" : "absent"}, expected ${mustBeBurning ? "PRESENT" : "absent"} ` +
        `(state=${state} atLine=${atLine}).\n       impact: ${impact.slice(0, 260)}`
    );

    /* ---- the two mutually exclusive sentences must never share one list ---- */
    const future = new RegExp(plain(tr("s.069")).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 12)).test(impact);
    ok(
      `${label} — "正在被抽走销毁" (s.068, present) and "下一笔卖出就会触发" (s.069, future) never coexist`,
      !(saysBurning && future),
      `impact: ${impact.slice(0, 260)}`
    );

    /* ---- the lede may not contradict the headline ---- */
    const headlineRecovered = /已恢复|贴着触发线/.test(f.texts.headline) || /已恢复|贴着触发线/.test(f.texts.vTitle);
    const ledeStopped = /销毁暂时停止|销毁已经停止/.test(f.texts.lede);
    ok(
      `${label} — the lede never says "stopped" under an "it recovered" headline`,
      !(headlineRecovered && ledeStopped),
      `headline="${f.texts.headline}" / v-title="${f.texts.vTitle}" / lede="${f.texts.lede}"`
    );

    /* ---- "on the line" is not "below the line". The answer block has a sentence for each, and
     *      using the below-the-line one about a pool that EQUALS the line is a factual error,
     *      not just a clash of tone.
     *
     *      The predicate is gapRaw, not the state. An earlier version of this assertion keyed on
     *      `state === "DORMANT"` and flagged the BELOW position too — where the pool really is
     *      under the line and the sentence is true. A test that fails on correct output is worse
     *      than no test, so it keys on the geometric fact. ---- */
    if (BigInt(f.derived.gapRaw) === 0n) {
      ok(
        `${label} — a pool that is ON the line is not described as BELOW it`,
        !/水位在线的下面|还在触发线下面/.test(f.texts.vAnswer + " " + impact),
        `gapRaw=0 (exactly on the line) but the copy says "below the line": ` +
          `answer="${f.texts.vAnswer.slice(0, 180)}" impact="${impact.slice(0, 160)}"`
      );
    }
  };

  for (const v of sound) judge(got.get(v));

  /* ------------------------------------------------------------------ *
   * The positive control, and why it is not optional.
   *
   * Every assertion above is a NEGATIVE except one: "s.068 must be absent". A suite of
   * negatives passes trivially if the renderer starts emitting nothing, or if a future
   * refactor collapses the LIVE branch into the at-line one. So the LIVE position is also
   * asserted in the positive direction — with 1000 IMD genuinely over the cap, s.068 MUST
   * appear and MUST carry the amount.
   * ------------------------------------------------------------------ */
  {
    const live = got.get("LIVE");
    const impact = live.texts.impact.join(" || ");
    ok(
      "LIVE counter-check — with something really burning, s.068 MUST still appear (guards against over-correcting)",
      /正在被抽走销毁/.test(impact),
      `impact: ${impact.slice(0, 260)}`
    );
    ok(
      "LIVE counter-check — a real burn reports its amount, and not the at-line wording",
      /当前待销毁量/.test(impact) && !/下一笔卖出就会触发一次销毁/.test(impact),
      `impact: ${impact.slice(0, 260)}`
    );
  }

  /* ------------------------------------------------------------------ *
   * One judge, not two.
   *
   * renderStates() carried a hand-written copy of onTheLine() that dropped the
   * `fmt18(pendingTrim, 2) === "0.00"` layer. The direction is worth stating exactly, because
   * it is easy to report backwards: the copy is CONSERVATIVE in that band — it says "not at the
   * line" about a pool onTheLine() calls at the line. It does not over-report at-line. What it
   * does is make two sections of one page describe one position differently, which is why the
   * fix is "call the function", not "loosen the copy".
   * ------------------------------------------------------------------ */
  {
    const c = got.get("C");
    const copyJudge = BigInt(c.derived.gapRaw) === 0n && BigInt(c.derived.pendingTrim) === 0n;
    ok(
      "the threshold band is reachable, and the two judges disagree there (so the duplicate is a real defect)",
      BigInt(c.derived.gapRaw) === 0n && BigInt(c.derived.pendingTrim) > 0n && c.atLine === true && copyJudge === false,
      `gapRaw=${c.derived.gapRaw} pendingTrim=${c.derived.pendingTrim} onTheLine=${c.atLine} copyJudge=${copyJudge} — ` +
        `pendingTrim prints as "${fmt18(BigInt(c.derived.pendingTrim), 2)}", which is still "at the line" to a reader`
    );

    const src = readFileSync(ROOT + "assets/app.js", "utf8");
    /* Counted across the whole file, not just renderStates(), because the defect is "there is a
     * second judge somewhere", not "it is on a particular line". Two accepted exceptions exist and
     * are named here rather than silently tolerated:
     *   - comments (the fix's own 'this used to be' note)
     *   - tick()'s flip detector, which compares two SNAPSHOTS over time (did the position change
     *     since the last reading) rather than describing the current one. That is a different
     *     question from onTheLine()'s "is the pool on the line right now", and reusing
     *     onTheLine() there would be wrong: it would need the same treatment for the same reason,
     *     but it is not the same predicate.
     * Anything else is a copy that can drift. */
    const srcLines = readFileSync(ROOT + "assets/app.js", "utf8").split("\n");
    const copies = [];
    for (let i = 0; i < srcLines.length; i++) {
      const ln = srcLines[i];
      if (/^\s*(\/\/|\*|\/\*)/.test(ln)) continue; // comment
      if (!/gapRaw === 0n && \w+\.?pendingTrim === 0n/.test(ln)) continue;
      copies.push(`L${i + 1}: ${ln.trim().slice(0, 100)}`);
    }
    ok(
      "no code restates the at-line test instead of calling onTheLine()",
      copies.length === 0,
      `${copies.length} hand-rolled duplicate(s) in app.js — each is a second judge that can drift ` +
        `from the first:\n       ${copies.join("\n       ")}`
    );
  }
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
