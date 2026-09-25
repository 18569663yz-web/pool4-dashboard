/**
 * pool4-dashboard — read-only client.
 *
 * Reads live state from Ethereum mainnet (and Base) with eth_call, renders it,
 * and re-polls every 60 s. No wallet, no signing, no writes, no backend.
 */

import { Rpc, DEFAULT_RPCS, fmt18, fmtUnits } from "../lib/evm.js";
import { collect, ADDR, BASE, OWNER_POWERS, OWNER_CONTRACTS, SOURCES, POOL_IDS, POOLS, WATCHED, readBridgeTrend } from "../lib/contracts.js";
import { simulate as simulatePure, simulateHorizon, imdToWei } from "../lib/simulate.js";
import { initI18n, setLang, getLang, t as tr, has as hasKey, onLangChange, applyStatic, applyDocumentLang, fmtDateTime, fmtIdentifier } from "../lib/i18n.js";
import { oldestSnapshot } from "../lib/snapshots.js";

/* ------------------------------------------------------------------ *
 * config
 * ------------------------------------------------------------------ */

const REFRESH_MS = 60_000;
/** Base state changes slowly and the public Base RPCs rate-limit hard: read it every N cycles. */
const BASE_EVERY = 5;
/** Past this age, the historical sections are labelled as possibly out of date. */
const STALE_AFTER_HOURS = 3;
const LS_WATCH = "pool4.watch.v1";
const LS_LOG = "pool4.watchlog.v1";
const LS_FLIP = "pool4.stateflip.v1";
const LS_FLIPLOG = "pool4.fliplog.v1";
const LS_BURN = "pool4.burnlog.v1";

const rpc = new Rpc(DEFAULT_RPCS, { timeoutMs: 20000 });

const state = {
  snap: null,
  timeline: null,
  baseData: null,
  volume: null,
  messages: null,
  messagesZh: null,
  msgFilter: "all",
  /** The message list is 70+ entries long; "证据" is unreadable if all of them are open. */
  msgShowAll: false,
  /** BurnExecutor's queue history, pre-generated from Transfer logs (see scripts/fetch-bridge-history.mjs) */
  bridgeSnapshot: null,
  baseCache: null,
  tickCount: 0,
  booted: false,
  lastError: null,
  nextAt: 0,
  busy: false,
  firstBlock: null,
  preset: "calm",
  /** the previous engine state, so a DORMANT -> LIVE flip can be announced */
  lastState: null,
  lastAtLine: null,
  stateFlip: null,
};

/* ------------------------------------------------------------------ *
 * tiny helpers
 * ------------------------------------------------------------------ */

/** Hex-helper handle. Declared here — not beside initHexTool() at the bottom — because boot()
 * calls it once the locale dictionary has loaded, and boot() runs before any code at the bottom
 * of this file is reached. A `let` there would be in its temporal dead zone at that moment and
 * the call would throw. It starts as a no-op so that boot() is safe even if initHexTool() never
 * ran (no #hex-input on the page). */
let hexRender = () => {};

const $ = (id) => document.getElementById(id);
const setHtml = (id, html) => {
  const el = $(id);
  if (el) el.innerHTML = html;
};
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * Translate a value that comes from the data layer (lib/contracts.js).
 *
 * Those fields hold a locale key when the text is user-visible ("owner.role.simd")
 * and a plain identifier when it is not ("capFloor"). td() returns the translation
 * when one exists and the raw value otherwise, so data can stay language-free without
 * every call site having to know which kind it is holding.
 */
const td = (v) => (typeof v === "string" && hasKey(v) ? tr(v) : v);

/** A number we could not read must never render as 0 — 0 is a claim. */
let UNAVAILABLE = "unavailable"; // replaced with the localised string once locales load (see boot)

function srcTag(key) {
  const s = SOURCES[key];
  if (!s) return "";
  const chain = s.chain === "base" ? " · Base" : "";
  return (
    tr("s.002") +
    `<span class="tip"><b>${esc(s.c)}${s.l ? " · " + esc(s.l) : ""}${chain}</b>` +
    `${esc(s.f)}<br><span class="addr">${esc(s.a)}</span></span></span>`
  );
}

function statTile(label, value, opts = {}) {
  const { sub = "", tone = "", srcKey = null, small = false } = opts;
  return (
    `<div class="stat ${tone}">` +
    `<div class="k">${esc(label)} ${srcKey ? srcTag(srcKey) : ""}</div>` +
    `<div class="v ${small ? "sm" : ""}">${value}</div>` +
    (sub ? `<div class="n">${sub}</div>` : "") +
    `</div>`
  );
}

/** "N 秒前" — and it must never print a number that cannot be true.
 *
 * Three inputs used to produce readings that are not readings:
 *
 *  1. A timestamp in the FUTURE (a node whose clock leads ours, or a block time read from a
 *     different chain). `d` went negative, fell into the first branch, and the page said
 *     "-60 秒前". Negative elapsed time is the one thing a clock can never report, so it is
 *     clamped to zero: "刚刚" / "just now" is the true statement about a boundary that has not
 *     happened yet.
 *  2. A MISSING timestamp (`m.ts` absent, a block with no resolved time). `d` was NaN, every
 *     `<` comparison was false, and the page rendered the literal string "NaN" — through both
 *     the "days" branch and the interpolation. NaN is now rejected before any branch runs.
 *  3. The 172799s / 172800s boundary switched from "48.0 小时" to "2.0 天" for one second of
 *     change. Not a bug, but it is the kind of jump a reader notices; the hour branch now ends
 *     at a round "48.0 小时" and the day branch starts there, which is where the two already
 *     met — `s.005` and `s.006` are unchanged. */
const ago = (tsSec) => {
  if (typeof tsSec !== "number" || !Number.isFinite(tsSec)) return tr("s.001");
  const d = Math.max(0, Date.now() / 1000 - tsSec);
  if (d < 90) return tr("s.003", { p0: Math.round(d) });
  if (d < 5400) return tr("s.004", { p0: (d / 60).toFixed(0) });
  if (d < 172800) return tr("s.005", { p0: (d / 3600).toFixed(1) });
  return tr("s.006", { p0: (d / 86400).toFixed(1) });
};

/** `ago()`, but for a timestamp that stopped moving.
 *
 * Every "X ago" in the conclusion band is computed from a block time inside a snapshot. While
 * the refresh job is running, that timestamp is minutes old and `ago()` is honest. When the
 * job stops — which is what happened for six hours on 2026-09-24 — the boundary stays put
 * while Date.now() keeps moving, so the number grows and grows: the last real burn was 25
 * minutes old and the page said "7.0 hours ago".
 *
 * The direction matters and is easy to get backwards. The snapshot's newest event is always at
 * or before the chain's newest event (the chain only grows forward), so `now − T_snapshot` is
 * an UPPER BOUND on the true elapsed time — the real gap is that, or smaller. Hence
 * "7.0h ago or more recent", never "at least 7.0h ago". Written the wrong way round it would
 * turn "it may have burned a minute ago" into "it has not burned in 7 hours", which is a worse
 * lie than the one being fixed.
 *
 * WHEN it applies is two conditions, not one, and the difference is not academic. A snapshot
 * can be minutes old and still be behind the chain: measured live, the page showed "最近一次
 * 烧毁 86 分钟前" while the chain's newest burn was 9.5 minutes old, and it said so as a plain
 * reading, because the snapshot age (38 min) was under the banner threshold. The banner's
 * "is the data stale" question and this line's "is this burn the latest one" question are not
 * the same question, and only the second one is about this sentence.
 *
 * So the qualifier appears when EITHER the snapshot is past its threshold OR the chain has
 * burned since the snapshot was built. The second condition is what the 90-minute guard in
 * scripts/check-last-trim.mjs watches for, one level up.
 */
const snapshotExpired = () => state.snapshotAgeHours !== null && state.snapshotAgeHours > STALE_AFTER_HOURS;
/** Has the chain produced a trim the snapshot does not contain? Read from the live block. */
const snapshotBehindChain = () =>
  state.timeline && state.timeline.last && state.snap
    ? Number(state.snap.blockNumber) > Number(state.timeline.last.Trimmed)
    : false;
const mayNotBeLatest = () => snapshotExpired() || snapshotBehindChain();
const agoBounded = (tsSec) => (mayNotBeLatest() ? tr("stale.orMoreRecent", { p0: ago(tsSec) }) : ago(tsSec));
/** "data as of 2026-09-24 09:44 UTC" — attached to a frozen figure while it may not be latest. */
const asOf = () =>
  mayNotBeLatest() && state.timeline && state.timeline.builtAt
    ? tr("stale.asOf", { p0: fmtDateTime(Date.parse(state.timeline.builtAt) / 1000) })
    : "";
/** "2026-09-24 09:44 UTC" — every timestamp on this page is UTC, and labelled as such.
 *
 * `new Date(NaN).toISOString()` throws `RangeError: Invalid time value`, and this formatter is
 * called on values straight out of snapshots and events — several of which are legitimately
 * absent. data/timeline.json carries milestones with `"t": null` where the block time could not
 * be resolved, and `iso(Number(x))` at the dripper's lastDripAt turns any unparseable string
 * into NaN. Each of those used to take out the whole renderer, which is the same failure shape
 * as the unread-view crash: one missing field, one blank section, an exception the reader never
 * sees. A timestamp that is not a timestamp returns the page's existing "unavailable" string
 * instead, so the caller keeps rendering and the reader is told the truth. */
const iso = (tsSec) => {
  if (typeof tsSec !== "number" || !Number.isFinite(tsSec)) return UNAVAILABLE;
  try {
    return new Date(tsSec * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  } catch {
    return UNAVAILABLE;
  }
};
const blocksToDays = (n) => (n * 12) / 86400;

/**
 * Is the pool sitting on the trigger line with nothing burnable yet?
 *
 * Two different readings mean the same thing to a reader: exactly on the line (excess 0), and
 * a few wei over it — pendingTrim() is floor(L * excess / held), so a pool just over the line
 * reports a positive value that still prints as "0.00". The headline, the state badge and the
 * verdict answer all have to agree on which one this is, or the page contradicts itself: the
 * badge said "工作中" while the headline said "贴着触发线".
 */
function onTheLine(d) {
  if (d.gapRaw !== 0n) return false;
  if (d.pendingTrim === 0n) return true;
  return fmt18(d.pendingTrim, 2) === "0.00";
}

/* ------------------------------------------------------------------ *
 * boot
 * ------------------------------------------------------------------ */

async function boot() {
  // i18n first: the very first paint should already be in the right language.
  await initI18n();
  UNAVAILABLE = tr("s.001");
  const [timeline, baseData, volume, messages, messagesZh, bridgeSnapshot] = await Promise.all([
    fetch("data/timeline.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch("data/base.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch("data/volume.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch("data/messages.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch("data/messages.zh.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch("data/bridge-history.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  state.timeline = timeline;
  state.baseData = baseData;
  state.volume = volume;
  state.messages = messages;
  state.messagesZh = messagesZh;
  state.bridgeSnapshot = bridgeSnapshot;
  state.booted = true;
  applyStatic();
  markLangButtons();
  syncThemeButton();
  initPresets();
  initMessageFilters();
  initLangSwitch();
  /* The hex helper renders text into "0x…" plus a size line, and that size line is a locale
   * string (s.513: "共 {p0} 字节 · 十六进制 {p1} 个字符"). It used to be built at the end of
   * initHexTool(), which init() calls synchronously — long before this function has awaited the
   * locale files. tr() falls back to returning the key when the dictionary is empty, so a
   * #hex-input that already had content on load showed the literal text "s.513".
   *
   * That is not a rare path: the browser restores a textarea's value on a soft refresh, on a
   * back navigation, and on form restore, so the reader sees the raw key without ever having
   * typed into the box. Moving the first call here — after initI18n() has resolved — fixes it;
   * onLangChange() below already re-renders it when the language changes. */
  hexRender();
  onLangChange(() => {
    // UNAVAILABLE is read all over the render code, so it has to follow the language:
    // it is a module-level variable captured once at boot, not a tr() call per use.
    UNAVAILABLE = tr("s.001");
    applyStatic();
    markLangButtons();
    // applyStatic() has just rewritten #theme-label from its static key; the button has to
    // name the theme it switches TO, which depends on the stored choice, not on the markup.
    syncThemeButton();
    hexRender();
    // The preset hint is not part of renderAll(), so it needs its own refresh —
    // otherwise it keeps the language it was written in when the page loaded.
    applyPreset(state.preset);
    if (state.snap) renderAll();
  });
  /* ---- test-only fixture injection (never set by the page itself) ----
   *
   * scripts/test-render.mjs sets globalThis.__POOL4_FIXTURE__ before importing this module, so
   * the REAL renderVerdict()/renderStates()/renderSummary() run against a synthetic snapshot.
   *
   * Why injection instead of asserting the live state: the page's own reading of the chain is
   * the thing under test. If the state machine mislabels a position, a test that asks the state
   * machine whether it is right agrees with the bug. The fixture supplies `values` and derives
   * everything through the real derive(); the expectations live in the test file, written out
   * as the sentences each position must produce.
   *
   * The injection point sits at the very END of boot(), after the real tick() has already run, so
   * a plain page load — where both globals are undefined — takes the identical path it always
   * did. Production never assigns either global, so this block is dead code in the browser.
   *
   * The `return` is load-bearing, not defensive padding. `setInterval(tick, 1000)` sits below it,
   * and tick() overwrites state.snap with a fresh chain reading. Leaving the timer registered
   * would mean the fixture is on screen only until the first tick — an assertion that passes or
   * fails depending on how fast the RPC answers. No timer is started for a fixture session. */
  if (globalThis.__POOL4_FIXTURE__) {
    state.snap = globalThis.__POOL4_FIXTURE__;
    if (globalThis.__POOL4_TIMELINE__ !== undefined) state.timeline = globalThis.__POOL4_TIMELINE__;
    renderAll();
    return;
  }
  /* The first paint must already carry the conclusion, so this reads the chain once before
   * handing over to the timer. It is NOT optional: the test suite stubs setInterval into a
   * recorder that never fires, so without this call nothing renders at all and every assertion
   * in test-render.mjs fails at zero characters — silently, since no exception is raised. */
  await tick();
  setInterval(tick, 1000);
}

/* ------------------------------------------------------------------ *
 * language switch
 * ------------------------------------------------------------------ */

function markLangButtons() {
  const cur = getLang();
  for (const l of ["zh", "en"]) {
    const b = $("lang-" + l);
    if (b) b.className = "langbtn" + (l === cur ? " active" : "");
  }
}

function initLangSwitch() {
  for (const l of ["zh", "en"]) {
    const b = $("lang-" + l);
    if (b && b.addEventListener) b.addEventListener("click", () => setLang(l));
  }
}

async function tick() {
  const now = Date.now();
  if (!state.busy && now >= state.nextAt) {
    state.busy = true;
    state.nextAt = now + REFRESH_MS;
    try {
      const wantBase = !state.baseCache || state.tickCount % BASE_EVERY === 0;
      const snap = await collect(rpc, { includeBase: wantBase });
      if (wantBase) {
        const b = snap.base || {};
        const baseOk = Object.keys(b.errors || {}).length === 0 && Object.keys(b.values || {}).length > 0;
        if (baseOk) state.baseCache = b;
        else if (state.baseCache) snap.base = state.baseCache; // keep the last good Base reading
      } else if (state.baseCache) {
        snap.base = state.baseCache;
      }
      state.tickCount++;
      const prevSnap = state.snap; // keep the previous reading: the flip log diffs against it
      state.snap = snap;
      state.lastError = null;
      if (state.firstBlock === null) state.firstBlock = snap.blockNumber;

      // A state flip is a headline event, not just a number change.
      const newState = snap.derived.state;
      const newAtLine = snap.derived.gapRaw === 0n && snap.derived.pendingTrim === 0n;
      if (state.lastState !== null && (state.lastState !== newState || state.lastAtLine !== newAtLine)) {
        const entry = buildFlipEntry(prevSnap, snap, state.lastState, newState, state.lastAtLine, newAtLine);
        state.stateFlip = entry;
        saveJson(LS_FLIP, entry);
        const log = loadJson(LS_FLIPLOG, []);
        log.unshift(entry);
        saveJson(LS_FLIPLOG, log.slice(0, 200));
      } else if (state.lastState === null) {
        const stored = loadJson(LS_FLIP, null);
        if (stored) state.stateFlip = stored;
      }
      state.lastState = newState;
      state.lastAtLine = newAtLine;

      // Burn-rate samples: totalBurned is monotonic, so a local time series gives
      // the real rate since the page has been open.
      const tb = snap.values["hook.totalBurned"];
      if (tb !== undefined) {
        const log = loadJson(LS_BURN, []);
        const last = log[log.length - 1];
        if (!last || last.b !== snap.blockNumber) {
          log.push({ t: Math.floor(snap.blockTimestamp), b: snap.blockNumber, v: tb.toString() });
          saveJson(LS_BURN, log.slice(-500));
        }
      }

      // Second door: the queue history comes from data/bridge-history.json, rebuilt from
      // Transfer logs by scripts/fetch-bridge-history.mjs. It used to be sampled with
      // eth_call at past blocks, which needs an archive node — the public fleet serves
      // those calls only sometimes, and when it did, the answers disagreed with the logs
      // by thousands of IMD. Only the live "now" value is read from the chain here.

      renderAll();
    } catch (e) {
      state.lastError = String(e.message || e);
      renderRpcBanner();
    } finally {
      state.busy = false;
    }
  }
  // countdown
  const left = Math.max(0, Math.ceil((state.nextAt - Date.now()) / 1000));
  const el = $("st-next");
  if (el) el.textContent = state.busy ? tr("s.007") : left + "s";
}

/* ------------------------------------------------------------------ *
 * render
 * ------------------------------------------------------------------ */

/** Renderers that failed on this pass, in call order. Read by renderRpcBanner(). */
let renderFailures = [];

/**
 * Run one renderer, and let it fail alone.
 *
 * renderAll() used to be a bare sequence of 25 calls, so a throw anywhere inside one of them
 * cancelled all the calls after it. That is not a theoretical failure mode: a single unread
 * view (pendingTrim, inventoryCap, capFloor, tokensInPool) used to throw out of renderVerdict()
 * via fmt18(), and the page then left fourteen renderers unrun — states, timeline, doors,
 * awaiting, volume, panel, sim-out, trim-now, rewards, simd, owner, watch, hist, burnrate,
 * pools, sources, footer all rendered nothing. Half a blank page, from one field.
 *
 * A renderer that breaks must therefore cost exactly its own section. The failure is recorded
 * by name so the banner can say WHICH one — "one view could not be read" is a true statement,
 * "all configured RPC endpoints are down" is not, and this page's whole selling point is that
 * it does not say things like that. */
function renderOne(name, fn) {
  try {
    fn();
  } catch (e) {
    const msg = String((e && e.message) || e);
    renderFailures.push({ name, msg });
    console.error("[render] " + name + " threw:", msg, e);
  }
}

function renderAll() {
  /* Freshness first, and NOT through renderOne(). renderStaleBanner() is what sets
   * state.snapshotAgeHours, and the conclusion's "X ago or more recent" wording and its
   * "data as of" note are chosen from that value — so it has to be known before the renderers
   * that read it run. Listed again at the end of this function to paint the DOM element itself.
   *
   * Routing it through renderOne() would be a downgrade: if it failed, snapshotAgeHours would
   * keep its previous value or stay null, and the staleness banner would silently disappear.
   * Hiding stale data is worse than the bug this file is fixing — so it stays outside, and a
   * failure here is loud rather than absorbed. */
  renderFailures = [];
  renderStaleBanner();

  renderOne("renderStatus", renderStatus);
  renderOne("renderSummary", renderSummary);
  renderOne("renderMessages", renderMessages);
  renderOne("renderVerdict", renderVerdict);
  renderOne("renderStates", renderStates);
  renderOne("renderFlipLog", renderFlipLog);
  renderOne("renderTimeline", renderTimeline);
  renderOne("renderDoors", renderDoors);
  renderOne("renderAwaiting", renderAwaiting);
  renderOne("renderVolume", renderVolume);
  renderOne("renderPanel", renderPanel);
  renderOne("renderSimulator", renderSimulator);
  renderOne("renderTrimNow", renderTrimNow);
  renderOne("renderRewards", renderRewards);
  renderOne("renderSimd", renderSimd);
  renderOne("renderOwner", renderOwner);
  renderOne("renderMonitor", renderMonitor);
  renderOne("renderHistory", renderHistory);
  renderOne("renderBurnRate", renderBurnRate);
  renderOne("wireQuoteLinks", wireQuoteLinks);
  renderOne("renderPools", renderPools);
  renderOne("renderSources", renderSources);
  renderOne("renderFooter", renderFooter);
  // The banner reports what the rest did, so it has to run before the freshness banner
  // repaints and after every failure has been collected.
  renderOne("renderRpcBanner", renderRpcBanner);
  renderStaleBanner();
}

/* ------------------------------------------------------------------ *
 * state-change log — the page's most unique artefact
 *
 * "It flipped at block N" is far less useful than "it flipped because the owner
 * lowered capFloor". So each entry diffs the two snapshots and records why.
 * ------------------------------------------------------------------ */

const FLIP_REASON_FIELDS = [
  ["hook.capFloor", "s.008"],
  ["hook.inventoryCap", "s.009"],
  ["hook.capDecayTokensPerDay", "s.010"],
  ["hook.ratchetBps", "s.011"],
  ["hook.rewardShareBps", "s.012"],
  ["hook.minTrimTokens", "s.013"],
  ["hook.marketOpen", "s.014"],
];

function buildFlipEntry(prev, next, fromState, toState, fromAtLine, toAtLine) {
  const pv = prev ? prev.values : {};
  const nv = next.values;
  const reasons = [];
  for (const [key, label] of FLIP_REASON_FIELDS) {
    const a = pv[key];
    const b = nv[key];
    if (a === undefined || b === undefined || a === b) continue;
    reasons.push({ kind: "param", key, label: tr(label), from: String(a), to: String(b) });
  }
  const ph = pv["hook.tokensInPool"];
  const nh = nv["hook.tokensInPool"];
  if (ph !== undefined && nh !== undefined && ph !== nh) {
    const d = nh - ph;
    reasons.push({
      kind: "inventory",
      label: tr("s.015"),
      from: String(ph),
      to: String(nh),
      note: d > 0n ? tr("s.016", { p0: fmt18(d, 4) }) : tr("s.017", { p0: fmt18(-d, 4) }),
    });
  }
  const pb = pv["hook.totalBurned"];
  const nb = nv["hook.totalBurned"];
  if (pb !== undefined && nb !== undefined && nb > pb) {
    reasons.push({ kind: "burn", label: tr("s.018"), from: String(pb), to: String(nb), note: fmt18(nb - pb, 4) + " IMD" });
  }
  return {
    at: Date.now(),
    block: next.blockNumber,
    blockTimestamp: next.blockTimestamp,
    fromState,
    toState,
    fromAtLine: !!fromAtLine,
    toAtLine: !!toAtLine,
    held: nv["hook.tokensInPool"] !== undefined ? String(nv["hook.tokensInPool"]) : null,
    cap: nv["hook.inventoryCap"] !== undefined ? String(nv["hook.inventoryCap"]) : null,
    floor: nv["hook.capFloor"] !== undefined ? String(nv["hook.capFloor"]) : null,
    gap: next.derived.gapRaw.toString(),
    reasons,
  };
}

const FLIP_LABEL = (e) => {
  const names = { DORMANT: tr("s.019"), CRITICAL: tr("s.020"), LIVE: tr("s.021") };
  const from = e.fromAtLine ? tr("s.023") : names[e.fromState] || e.fromState;
  const to = e.toAtLine ? tr("s.022") : names[e.toState] || e.toState;
  return `${from} → ${to}`;
};

function renderFlipLog() {
  const el = $("fliplog");
  if (!el) return;
  const log = loadJson(LS_FLIPLOG, []);
  if (!log.length) {
    el.innerHTML =
      tr("s.024") +
      tr("s.025") +
      tr("s.026") +
      tr("s.027");
    return;
  }
  const rows = log
    .slice(0, 30)
    .map((e) => {
      const why = (e.reasons || [])
        .map((r) => {
          if (r.kind === "param") return tr("s.028", { p0: esc(r.label) });
          if (r.kind === "inventory") return tr("s.029", { p0: esc(r.note || "") });
          if (r.kind === "burn") return tr("s.030", { p0: esc(r.note || "") });
          return esc(r.label || "");
        })
        .join("；");
      return (
        `<tr>` +
        `<td class="tiny">${new Date(e.at).toISOString().replace("T", " ").slice(0, 19)}</td>` +
        `<td class="num">${e.block.toLocaleString()}</td>` +
        `<td><b>${esc(FLIP_LABEL(e))}</b></td>` +
        `<td class="tiny">${why}</td>` +
        `<td class="num tiny">${e.gap !== undefined ? fmt18(BigInt(e.gap), 4) : "—"}</td>` +
        `</tr>`
      );
    })
    .join("");
  el.innerHTML =
    `<div class="scroll-x"><table class="tbl">` +
    tr("s.031") +
    `<tbody>${rows}</tbody></table></div>`;
}

/* ------------------------------------------------------------------ *
 * burn rate — how fast IMD is actually being destroyed
 * ------------------------------------------------------------------ */

function renderBurnRate() {
  const el = $("burnrate");
  if (!el) return;
  const t = state.timeline;
  const s = state.snap;
  if (!t || !s || !t.trims) {
    el.innerHTML = tr("s.032");
    return;
  }
  const nowSec = s.blockTimestamp;
  const window = (hours) => {
    const cutoff = nowSec - hours * 3600;
    const rows = t.trims.filter((x) => x.t && x.t >= cutoff);
    const total = rows.reduce((a, x) => a + BigInt(x.burned), 0n);
    const rewards = rows.reduce((a, x) => a + BigInt(x.rewarded), 0n);
    return { count: rows.length, total, rewards, perDay: rows.length ? (total * 86400n) / BigInt(hours * 3600) : 0n };
  };
  const h24 = window(24);
  const h168 = window(168);
  const all = t.trims.reduce((a, x) => a + BigInt(x.burned), 0n);
  const firstT = t.trims.find((x) => x.t);
  const spanDays = firstT && firstT.t ? (nowSec - firstT.t) / 86400 : 0;
  const lifetimePerDay = spanDays > 0 ? (all * 10n ** 6n) / BigInt(Math.round(spanDays * 1e6)) : 0n;

  // local samples (since the page has been open) — the only true "right now" rate
  const samples = loadJson(LS_BURN, []);
  let liveRate = null;
  if (samples.length >= 2) {
    const a = samples[0];
    const b = samples[samples.length - 1];
    const dt = b.t - a.t;
    const dv = BigInt(b.v) - BigInt(a.v);
    if (dt > 60 && dv >= 0n) liveRate = (dv * 86400n) / BigInt(dt);
  }

  const row = (label, w, sub) =>
    statTile(label, w.count === 0 ? "0 IMD" : fmt18(w.total, 3) + " IMD", {
      small: true,
      tone: w.count ? "live" : "",
      sub: tr("s.033", { p0: w.count, p1: sub ? " · " + sub : "" }),
    });

  el.innerHTML =
    `<div class="grid g4">` +
    row(tr("s.034"), h24, tr("s.035", { p0: fmt18(h24.perDay, 0) })) +
    row(tr("s.036"), h168, tr("s.037", { p0: fmt18(h168.perDay, 0) })) +
    statTile(tr("s.038"), fmt18(lifetimePerDay, 0) + tr("s.043"), {
      small: true,
      sub: tr("s.040", { p0: firstT ? firstT.b.toLocaleString() : "—", p1: fmt18(all, 0) }),
    }) +
    statTile(
      tr("s.041"),
      liveRate === null ? tr("s.042") : fmt18(liveRate, 0) + tr("s.039"),
      { small: true, sub: liveRate === null ? tr("s.044", { p0: samples.length }) : tr("s.045", { p0: samples.length }) }
    ) +
    `</div>` +
    devTargetBlock(h24, h168);
}

/**
 * The dev's stated ceiling, quoted exactly.
 *
 * Block 25901450 says "set the burn cap to 25k IMD per day" — a DESIGN TARGET, not a
 * forecast. Two earlier posts (25892951, 25890127) phrase it as an expectation. The
 * wording must not conflate the two: one is intent, the other is a promise reality
 * can break. Getting this wrong would undermine trust in the whole tool.
 */
function devTargetBlock(h24, h168) {
  const TARGET = imdToWei(25000);
  const rows = [
    [
      25901450,
      "2026-09-04",
      "The goal when the full lp is deployed to the hook is to <b>set the burn cap to 25k IMD per day</b> and this when the stakers should start seeing way more rewards.",
      tr("s.046"),
    ],
    [
      25892951,
      "2026-09-02",
      "if the hook works/all lp is deployed and no exploits (please god) we will be burning around 25k tokens per day",
      tr("s.047"),
    ],
    [
      25890127,
      "2026-09-02",
      "i think we can expect to burn over 25k imd a day and over 2700 imd of rewards when the full lp is deplpoyed",
      tr("s.048"),
    ],
  ];
  const actual = h24.perDay > 0n ? h24.perDay : h168.perDay;
  const pct = actual > 0n ? Number((actual * 10000n) / TARGET) / 100 : 0;
  return (
    `<div class="devtarget">` +
    `<div class="devtarget-head">` +
    tr("s.049") +
    tr("s.050", { p0: pct >= 50 ? "warn" : "", p1: pct.toFixed(1) }) +
    `</div>` +
    `<p class="tiny muted" style="margin:6px 0 8px">` +
    tr("s.051") +
    tr("s.052") +
    tr("s.053") +
    `</p>` +
    `<ul class="devtarget-quotes">` +
    rows
      .map(
        ([block, date, text, kind]) =>
          `<li><span class="chip">${kind}</span> ` +
          tr("s.054", { p0: block, p1: block, p2: block.toLocaleString(), p3: date }) +
          `<div class="verbatim tiny">${text}</div></li>`
      )
      .join("") +
    `</ul>` +
    `</div>`
  );
}

/**
 * Point every verbatim-quote link at its real transaction. Uses getElementById on a
 * known set of block numbers so it works in the headless test stub too.
 */
function wireQuoteLinks() {
  const msgs = state.messages && state.messages.messages;
  if (!msgs) return;
  for (const block of [25901450, 25892951, 25890127]) {
    const a = $("quote-" + block);
    if (!a || !a.setAttribute) continue;
    const m = msgs.find((x) => x.block === block);
    if (m && m.tx) a.setAttribute("href", `https://etherscan.io/tx/${m.tx}`);
  }
}

/* ------------------------------------------------------------------ *
 * the 30-second summary — the first thing a holder reads
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * the summary's one picture
 *
 * The 30-second summary is the only block every reader sees, and it used to be three
 * paragraphs of prose — accurate, and completely unreadable at a glance. Two drawings
 * answer the two questions it exists for: "how close is the pool to firing?" (the gauge,
 * with the ratchet floor marked) and "is the engine doing anything at all?" (the burn
 * activity strip, which is flat the moment the engine stops).
 * ------------------------------------------------------------------ */

function renderSummaryVisual() {
  const s = state.snap;
  const el = $("sum-visual");
  if (!s || !el) return;
  const d = s.derived;
  const v = s.values;
  const held = v["hook.tokensInPool"];
  const cap = v["hook.inventoryCap"];
  if (held === undefined || cap === undefined || cap === 0n) {
    el.innerHTML = "";
    return;
  }

  /* onTheLine(d), not a restatement of it. This was
   * `d.gapRaw === 0n && d.pendingTrim === 0n` — the same threshold-less copy renderStates()
   * carried, and with the same effect: in the band where gapRaw is 0 and pendingTrim is positive
   * but prints as "0.00", this said "not at the line" while the headline above the gauge said
   * the pool was on it. The gauge's tone is a verdict about the position, so it has to come from
   * the one function that owns that verdict. */
  const atLine = onTheLine(d);
  const tone = d.state === "LIVE" || atLine ? "live" : d.state === "CRITICAL" ? "warn" : "dead";
  const pct = Math.max(0, Math.min(100, Number((held * 10000n) / cap) / 100));
  const floorPct = Math.max(0, Math.min(100, Number((d.floor * 10000n) / cap) / 100));

  // Only worth a line when there is a real distance left to cover. "The pool sits exactly on
  // the line" is already the headline directly above the gauge — printing it twice adds noise.
  const gapLine = d.gapRaw > 0n ? tr("s.518", { p0: fmt18(d.gapRaw, 2) }) : "";

  const gauge =
    `<div class="gauge">` +
    `<div class="gauge-head">` +
    `<span class="gauge-title">${tr("s.519")}</span>` +
    `<span class="gauge-read"><b>${fmt18(held, 2)}</b> / ${fmt18(cap, 2)} IMD</span>` +
    `</div>` +
    `<div class="gauge-track ${tone}">` +
    `<div class="gauge-fill" style="width:${pct.toFixed(2)}%"></div>` +
    `<div class="gauge-floor" style="left:${floorPct.toFixed(2)}%"></div>` +
    `</div>` +
    `<div class="gauge-scale">` +
    `<span>0</span>` +
    `<span>${tr("s.520", { p0: fmt18(d.floor, 0) })}</span>` +
    `<span>${tr("s.521", { p0: fmt18(cap, 2) })}</span>` +
    `</div>` +
    (gapLine ? `<div class="gauge-gap ${tone}">${gapLine}</div>` : "") +
    `</div>`;

  // Burn activity: the last N trims, drawn to scale. A flat strip is the whole point —
  // it is what "the engine stopped" looks like before you read a single number.
  const trims = (state.timeline && state.timeline.trims) || [];
  const N = 24;
  const recent = trims.slice(-N);
  let activity = "";
  if (recent.length) {
    const vals = recent.map((x) => Number(x.burned) / 1e18);
    const maxV = Math.max(...vals, 1e-9);
    // Each bar carries its own reading. Without it the strip says "the engine has been busy"
    // and nothing else — the reader asked for the actual amounts.
    const bars = recent
      .map((x, i) => {
        const h = Math.max(3, (Math.sqrt(vals[i]) / Math.sqrt(maxV)) * 100).toFixed(1);
        const tip =
          tr("s.524", { p0: x.b.toLocaleString() }) +
          " · " +
          tr("s.525", { p0: fmt18(BigInt(x.burned), 2) }) +
          (x.t ? " · " + ago(x.t) : "");
        return `<i style="height:${h}%" data-tip="${esc(tip)}"></i>`;
      })
      .join("");
    const lastTs = recent[recent.length - 1].t;
    /* Both the sentence and the bars come from state.timeline.trims, so both are frozen at
     * the same moment. Making one live and leaving the other behind would put "last burn 5
     * minutes ago" directly above a bar chart ending seven hours earlier — a worse
     * contradiction than two honest stale readings. The "as of" note covers the pair. */
    const asOfTxt = asOf();
    activity =
      `<div class="activity">` +
      `<div class="act-head"><span>${tr("s.522", { p0: recent.length })}</span>` +
      `<span class="muted">${lastTs ? tr("s.523", { p0: agoBounded(lastTs) }) : ""}` +
      `${asOfTxt ? ` · ${esc(asOfTxt)}` : ""}</span></div>` +
      `<div class="actbars" role="img" aria-label="${esc(tr("s.522", { p0: recent.length }))}">${bars}</div>` +
      `</div>`;
  }

  el.innerHTML = gauge + activity;
}

function renderSummary() {
  const s = state.snap;
  if (!s) return;
  const d = s.derived;
  const v = s.values;
  const t = state.timeline;

  const lastTrimBlock = t && t.last ? t.last.Trimmed : null;
  const lastTrimTs = lastTrimBlock && t.blockTime[lastTrimBlock] ? t.blockTime[lastTrimBlock] : null;
  const days = lastTrimTs ? Math.floor((Date.now() / 1000 - lastTrimTs) / 86400) : null;
  const gap = d.gapRaw;
  const gapNum = fmt18(gap, 0);

  // headline + document title
  // The interesting case is gap == 0: `held == cap` means _applyCap() does nothing
  // this block (L991 excess == 0), yet ANY sell pushes held over the cap and fires
  // immediately. Calling that "stopped" would be wrong.
  //
  // `held > cap` is not enough to promise something to burn — see onTheLine(). Below the
  // display threshold the headline says where the pool is instead of naming a zero amount.
  const atLine = onTheLine(d);
  const pendingTxt = d.pendingTrim > 0n ? fmt18(d.pendingTrim, 2) : "";
  /* atLine outranks the raw state for every piece of this header, including at E — DORMANT with
   * held == cap == floor. At E the pool really is flush against the line, and "贴着触发线" is the
   * accurate description of where it is; DORMANT describes what the state machine expects to
   * happen next, which belongs in the lede and the state card, not in the one-line headline.
   *
   * So the wording stays atLine here in all three of headline / title / subtitle, and the E
   * nuance is carried by verdict-lede (s.539). Keying the headline on the state as well would
   * make it say "停止" at E while the badge two blocks away said "贴着触发线" — the same
   * contradiction, moved rather than removed. One predicate, one wording, everywhere. */
  let headline;
  let title;
  if (d.state === "LIVE" && !atLine && pendingTxt) {
    headline = tr("hero.live", { amount: pendingTxt });
  } else if (atLine || d.state === "LIVE") {
    headline = tr("hero.atLine");
  } else if (d.state === "CRITICAL") {
    headline = tr("hero.critical");
  } else {
    headline = days !== null && days >= 1 ? tr("hero.stopped", { count: days }) : tr("hero.stoppedNoDays");
  }
  setHtml("sum-headline", headline);
  // <title> must carry BOTH the conclusion (P0) and the active language (i18n).
  // Same three-way split as the headline, for the same reason: the tab, the sticky subtitle
  // and the state badge are read side by side, and any of them claiming "正在工作" while the
  // others say "贴着触发线" makes the page look like it disagrees with itself.
  const showsLive = d.state === "LIVE" && !atLine && !!pendingTxt;
  /* The tab title must land on the SAME arm the headline did. The old fall-through ended in
   * title.critical, so DORMANT — the state where nothing is burnable AND the line cannot fall any
   * further — was announced in the tab as "触发线仍在下降" ("the trigger line is still falling").
   * That is the one thing DORMANT means it is NOT: cap == floor means the line has bottomed out,
   * which is precisely why nothing will happen without the pool rising on its own.
   *
   * The headline never had this bug — it falls through to hero.stopped — so the tab and the
   * headline disagreed on the same state, visible side by side on a phone. Read against the live
   * chain on 2026-09-25 (held 7,262.91, cap == floor == 9,000, DORMANT) the tab said the line was
   * still falling while the headline said the mechanism had stopped. */
  title = showsLive
    ? tr("title.live")
    : atLine || d.state === "LIVE"
      ? tr("title.atLine")
      : d.state === "CRITICAL"
        ? tr("title.critical")
        : days !== null && days >= 1
          ? tr("title.stopped", { count: days })
          : tr("title.stoppedNoDays");
  if (document.title !== title) document.title = title;
  const pt = $("page-title");
  if (pt) pt.textContent = tr("meta.title");
  const ps = $("page-sub");
  if (ps) {
    ps.textContent = showsLive
      ? tr("subtitle.live")
      : atLine || d.state === "LIVE"
        ? tr("subtitle.atLine")
        : d.state === "CRITICAL"
          ? tr("subtitle.critical")
          : days !== null && days >= 1
            ? tr("subtitle.stopped", { count: days })
            : tr("subtitle.stoppedNoDays");
  }
  const sum = $("summary");
  if (sum) sum.className = "summary" + (d.state === "LIVE" || atLine ? " calm" : "");
  applyDocumentLang();

  // ---- state flip: this is an event, not a number change ----
  const flipEl = $("state-flip");
  if (flipEl) {
    const flip = state.stateFlip;
    const fresh = flip && Date.now() - flip.at < 7 * 86400000;
    const paramChanged = (loadJson(LS_LOG, []) || []).some(
      (c) => Date.now() - c.firstSeen < 7 * 86400000 && /capFloor|capDecayTokensPerDay|ratchetBps|rewardShareBps/.test(c.id)
    );
    if (fresh && flip.to !== flip.from) {
      const names = { DORMANT: tr("s.055"), CRITICAL: tr("s.056"), LIVE: tr("s.057") };
      const toLive = flip.to === "LIVE";
      flipEl.innerHTML =
        `<div class="banner ${toLive ? "ok" : "warn"}" style="margin-bottom:14px"><span class="ic">${toLive ? "●" : "○"}</span><div>` +
        tr("s.058", { p0: esc(names[flip.from] || flip.from), p1: esc(names[flip.to] || flip.to) }) +
        tr("s.059", { p0: flip.block.toLocaleString() }) +
        (toLive
          ? tr("s.060")
          : tr("s.061")) +
        (paramChanged ? tr("s.062") : "") +
        `</div></div>`;
    } else if (paramChanged) {
      flipEl.innerHTML =
        `<div class="banner warn" style="margin-bottom:14px"><span class="ic">!</span><div>` +
        tr("s.063") +
        tr("s.064") +
        `</div></div>`;
    } else {
      flipEl.innerHTML = "";
    }
  }

  /* Hard assertions, in PAIRS. A one-directional assertion is worse than none, because it reads
   * like the property is guarded when only half of it is.
   *
   * The original checked only "there IS something to burn, so we must not say stopped":
   *     (pendingTrim > 0 || held > cap) && state !== "LIVE"
   *
   * Every one of the three self-contradictions this round fixed slipped through that: they were
   * all the OPPOSITE shape — claiming a burn while nothing was burnable (atLine with held == cap,
   * or with a few wei of excess that prints as 0.00). So the second half is asserted here:
   * if the page describes the pool as STILL BURNING, something must actually be burnable.
   *
   * `pendingTrim > 0n` is the contract's own authoritative reading, so it is the right test on
   * the other side too — but note that a positive pendingTrim smaller than the display threshold
   * is legitimately described as "on the line" rather than "burning", which is why the check is
   * against the printed reading and not against the state alone. */
  if ((v["hook.pendingTrim"] > 0n || d.held > d.cap) && d.state !== "LIVE") {
    console.error("[invariant] there is something to burn but state is not LIVE", {
      pendingTrim: String(v["hook.pendingTrim"]),
      held: String(d.held),
      cap: String(d.cap),
      state: d.state,
    });
  }
  if (d.state === "LIVE" && d.pendingTrim === 0n && !onTheLine(d)) {
    console.error("[invariant] state is LIVE but nothing is burnable and the pool is not on the line", {
      pendingTrim: String(d.pendingTrim),
      gapRaw: String(d.gapRaw),
      held: String(d.held),
      cap: String(d.cap),
      state: d.state,
    });
  }

  // impact
  const impact = [];
  const drippableNow = v["dripper.drippable"];
  const yieldLine =
    drippableNow === undefined
      ? tr("s.065")
      : drippableNow === 0n
        ? tr("s.066")
        : tr("s.067", { p0: fmt18(drippableNow, 4) });
  /* d.state is the only source of truth for which impact sentence prints.
   *
   * This read `if (d.state === "LIVE" || atLine)`, which let atLine override the state machine
   * and pull CRITICAL and DORMANT into the LIVE branch. s.068 is present tense — "超出触发线的
   * IMD 正在被抽走销毁" / "IMD above the line is being withdrawn and burned" — and it printed
   * in states where nothing is being withdrawn at all:
   *
   *   B (held == cap, pendingTrim == 0 → CRITICAL + atLine, the live state right now):
   *       s.068 present tense AND s.069 future tense in the same list —
   *       "正在被抽走销毁" directly above "下一笔卖出就会触发一次销毁". One list, two tenses,
   *       one position. They cannot both be true.
   *   E (held == cap == floor → DORMANT, a cell derive() never documents): s.068 said a burn was
   *       in progress while the answer block on the same screen said 现在水位在线的下面，所以没有
   *       东西可烧 / "the level is below the line, so there is nothing to burn".
   *   C (a few wei over → LIVE + atLine): genuinely burning, so s.068 is right here — and this is
   *       the case the `|| atLine` was originally written to serve.
   *
   * So the fix keeps atLine where it belongs — selecting wording *within* LIVE — and stops it
   * from choosing the branch. Outside LIVE, atLine is irrelevant to this list: a pool sitting on
   * the line is not having anything withdrawn from it, whatever the state machine calls it. That
   * is why the C case keeps working, B falls into the CRITICAL copy, and E into the DORMANT copy.
   *
   * Note the invariant above (l838) only ever checked the opposite direction — "has a pending
   * trim but is not LIVE". All three cases here are "has NO pending trim yet was treated as
   * LIVE", so the assertion could not have caught any of them. */
  if (d.state === "LIVE") {
    /* Three lines, as before, and s.068 only where a burn is genuinely in flight.
     *
     * atLine inside LIVE is the C band: over the line by a few wei, so excess is real but prints
     * as 0.00 and there is effectively nothing to withdraw. There the present-tense s.068 is
     * dropped for the future-tense s.069 carried in the amount slot — s.068 and s.069 must never
     * both appear, which is exactly the B-case contradiction being fixed here. Keeping the list
     * at three items in every state preserves the layout the rest of the section assumes. */
    impact.push(atLine ? tr("s.069") : tr("s.068"));
    impact.push(yieldLine);
    if (!atLine) impact.push(tr("s.070", { p0: fmt18(d.pendingTrim, 4) }));
  } else if (d.state === "CRITICAL") {
    /* CRITICAL is not one position, it is a band, and the copy has to name the right one.
     *
     * s.071 says "池子里的 IMD 还在触发线下面 … 此刻没有东西可烧" / "the pool's IMD is still
     * below the line … nothing can burn right now". That is true for the whole band below the
     * line (held < cap, which is also every `cap == floor` case) and it is the reason this arm
     * exists. It is FALSE at the top edge of the band: the B point, held == cap, where the level
     * is not under the line but exactly on it.
     *
     * That edge is not hypothetical — it is the state this site is serving as this is written.
     * Before the fix at l877, B printed the present-tense s.068 and the mistake was a tense; with
     * only that fix, B would land here and the mistake becomes a direction. Swapping one wrong
     * sentence for another is not a repair, so B gets its own wording: on the line, nothing to
     * burn yet, the next sell fires it. That is s.516's meaning, already written for the gap line,
     * so it is reused rather than duplicated.
     *
     * The splitting predicate is `held === cap`, not atLine. atLine is also true at C and at
     * cap+1 wei (states LIVE, handled above), so within this arm the two coincide — but keying on
     * the geometric fact is what makes the sentence correct, and it keeps holding if the atLine
     * threshold is ever retuned. */
    impact.push(d.held === d.cap ? tr("s.516") : tr("s.071"));
    impact.push(yieldLine);
    impact.push(tr("s.072"));
  } else {
    impact.push(tr("s.073"));
    impact.push(yieldLine);
    impact.push(tr("s.074"));
  }
  setHtml("sum-impact", impact.map((x) => `<li>${x}</li>`).join(""));

  // recovery — atLine first, for the same reason as the headline: "已经具备触发条件" and
  // "贴着触发线" describe one situation, and the block should not switch wording based on
  // which of the two equivalent readings the contract happened to report.
  let recovery;
  if (atLine) {
    recovery =
      tr("s.076", { p0: fmt18(d.held, 2), p1: fmt18(d.cap, 2) }) +
      tr("s.077") +
      tr("s.078") +
      tr("s.079");
  } else if (d.state === "LIVE") {
    recovery = tr("s.075");
  } else {
    const parts = [];
    parts.push(
      tr("s.080", { p0: gapNum, p1: fmt18(d.held, 0), p2: fmt18(d.cap, 0) })
    );
    if (d.gapUsd > 0n) parts.push(tr("s.081", { p0: fmt18(d.gapUsd, 0) }));
    parts.push(tr("s.082"));
    if (d.state === "DORMANT") {
      parts.push(tr("s.083", { p0: fmt18(d.floor, 0) }));
    } else {
      parts.push(tr("s.084", { p0: fmt18(d.cap, 2), p1: fmt18(d.floor, 0) }));
    }
    recovery = parts.join(" ");
  }
  setHtml("sum-recovery", recovery);

  // the risk nobody was told about — stated per contract, because ownership differs
  const ZERO = "0x0000000000000000000000000000000000000000";
  const ownerStatus = OWNER_CONTRACTS.map((c) => {
    const o = v[c.ownerKey];
    return { ...c, owner: o === undefined ? null : String(o).toLowerCase() };
  });
  const renounced = ownerStatus.filter((c) => c.owner === ZERO);
  const live = ownerStatus.filter((c) => c.owner !== null && c.owner !== ZERO);
  const livePowers = live.reduce((n, c) => n + c.powerIds.length, 0);
  setHtml(
    "sum-risk",
    tr("s.085", { p0: ownerStatus.length }) +
      (renounced.length
        ? tr("s.086", { p0: renounced.map((c) => c.contract).join(tr("s.512")) }) +
          tr("s.087")
        : "") +
      (live.length
        ? tr("s.088", { p0: live.length }) +
          tr("s.089", { p0: livePowers }) +
          tr("s.090")
        : "") +
      tr("s.091")
  );
  renderSummaryVisual();
}

/* ------------------------------------------------------------------ *
 * pool A vs pool B — where the volume actually goes
 * ------------------------------------------------------------------ */

function renderVolume() {
  const vol = state.volume;
  const s = state.snap;
  const el = $("volume-stats");
  if (!el) return;
  if (!vol) {
    el.innerHTML = tr("s.092");
    return;
  }
  const A = vol.pools.find((p) => p.label === "A");
  const B = vol.pools.find((p) => p.label === "B");
  const ethA = A ? BigInt(A.ethAbs) : 0n;
  const ethB = B ? BigInt(B.ethAbs) : 0n;
  const share = vol.hookShareEthPct;
  const ratio = share && share > 0 ? 100 / share : null;

  setHtml("pools-headline", ratio ? tr("s.093", { p0: ratio.toFixed(0) }) : tr("s.094"));

  setHtml(
    "volume-stats",
    statTile(
      tr("s.095"),
      share === null || share === undefined ? UNAVAILABLE : share.toFixed(2) + "%",
      { small: true, tone: "dead", sub: tr("s.096", { p0: vol.hours }) }
    ) +
      statTile(
        tr("s.097"),
        share === null || share === undefined ? UNAVAILABLE : (100 - share).toFixed(2) + "%",
        { small: true, tone: "warn", sub: tr("s.098") }
      ) +
      statTile(
        tr("s.099"),
        `${fmt18(ethA, 2)} / ${fmt18(ethB, 2)}`,
        { small: true, sub: tr("s.100") }
      )
  );

  const lede = $("pools-lede");
  if (lede && B && A) {
    const netA = BigInt(A.netImd);
    const gapNow = s ? s.derived.gapRaw : 0n;
    const cover = gapNow > 0n ? Number(netA) / Number(gapNow) : 0;
    lede.innerHTML =
      tr("s.101") +
      tr("s.102", { p0: vol.hours, p1: (100 - share).toFixed(1) }) +
      tr("s.103", { p0: share.toFixed(1) }) +
      (cover > 1
        ? tr("s.104", { p0: vol.hours, p1: fmt18(netA, 0) }) +
          tr("s.105", { p0: fmt18(gapNow, 0), p1: cover.toFixed(1) }) +
          tr("s.106")
        : "");
  }

  const note = $("pools-note");
  if (note) {
    note.innerHTML =
      tr("s.107", { p0: vol.hours }) +
      tr("s.108", { p0: share.toFixed(1), p1: vol.hookShareCountPct.toFixed(1) }) +
      tr("s.109", { p0: B.swaps, p1: A.swaps + B.swaps }) +
      tr("s.110") +
      tr("s.111") +
      tr("s.112") +
      tr("s.113", { p0: vol.fromBlock.toLocaleString(), p1: vol.toBlock.toLocaleString(), p2: vol.hours }) +
      tr("s.114") +
      tr("s.115", { p0: vol.chainWideSwaps.toLocaleString(), p1: (A.swaps + B.swaps).toLocaleString() }) +
      tr("s.116", { p0: vol.hours });
  }
}

function renderStatus() {
  const s = state.snap;
  if (!s) return;
  $("st-block").textContent = s.blockNumber.toLocaleString();
  /* Every other timestamp on this page is UTC: iso() appends " UTC", fmtDateTime() pins
   * timeZone:"UTC" and appends the suffix, and the "data as of" note is UTC. This one line was
   * the only local-time clock, and it carried no label — so a reader in UTC+8 who used it to
   * judge "how long has the page gone without an update" could be eight hours out, in the
   * direction that makes a frozen page look freshly updated. Same reading, same timezone label,
   * or the comparison the reader is making is wrong. */
  $("st-updated").textContent = iso(s.fetchedAt / 1000);
  const errCount = Object.keys(s.errors || {}).length + Object.keys((s.base && s.base.errors) || {}).length;
  const dot = $("dot-rpc");
  const label = $("st-rpc");
  dot.className = "dot " + (errCount === 0 ? "ok" : "warn");
  label.textContent = errCount === 0 ? tr("s.117") : tr("s.118", { p0: errCount });
}

/* ------------------------------------------------------------------ *
 * snapshot freshness
 *
 * The historical sections (trim curve, 24h/7d trends, message timeline) are rendered from
 * pre-generated JSON refreshed by a scheduled job. If that job stops, the page keeps
 * showing week-old history that still looks like data — so the age of the oldest snapshot
 * gets a banner of its own.
 * ------------------------------------------------------------------ */

function renderStaleBanner() {
  const el = $("stale-banner");
  if (!el) return;
  const oldest = oldestSnapshot({
    timeline: state.timeline,
    base: state.baseData,
    volume: state.volume,
    messages: state.messages,
    "bridge-history": state.bridgeSnapshot,
  });
  state.snapshotAgeHours = oldest ? oldest.ageHours : null;
  if (!oldest || oldest.ageHours <= STALE_AFTER_HOURS) {
    el.innerHTML = "";
    return;
  }
  const when =
    oldest.ageHours >= 48
      ? tr("stale.days", { p0: Math.floor(oldest.ageHours / 24) })
      : tr("stale.hours", { p0: oldest.ageHours.toFixed(1) });
  el.innerHTML =
    `<div class="banner warn" style="margin-top:18px"><span class="ic">!</span><div>` +
    tr("stale.banner", { p0: when, p1: esc(oldest.name) }) +
    `</div></div>`;
}

function renderRpcBanner() {
  const el = $("rpc-banner");
  if (!el) return;

  /* Three different failures used to share one banner, and the banner told the worst story
   * of the three every time.
   *
   *   "整体断网"        — tick()'s catch: no snapshot at all, every endpoint refused.
   *   "部分读数失败"    — the snapshot arrived but some views are missing (snap.errors).
   *   "某个区块渲染失败" — the data is fine and a renderer threw (renderFailures).
   *
   * The old text (s.119) said "读不到链上数据。所有配置的 RPC 端点都没有响应" for all three. A
   * single view failing to decode — which happens routinely, and which lib/contracts.js has a
   * whole retry pass for — was therefore announced as a total network outage, while the RPC
   * was healthy and thirty other numbers on the page were correct. On a site whose stated
   * selling point is that it does not overstate, that was the most damaging sentence it could
   * print.
   *
   * Each case now names itself and its own blast radius: which view could not be read, or
   * which section failed to draw. "读不到链上数据" is reserved for the case where there is
   * genuinely no snapshot to draw from. */
  const s = state.snap;

  if (state.lastError && !s) {
    el.innerHTML =
      `<div class="banner danger" style="margin-top:18px"><span class="ic">✕</span><div>` +
      tr("s.119") +
      tr("s.120") +
      `<div class="err" style="margin-top:6px">${esc(state.lastError)}</div></div></div>`;
    return;
  }

  const sections = [];
  if (state.lastError && s) {
    sections.push({ tone: "danger", ic: "✕", html: tr("s.526") + tr("s.530", { p0: esc(state.lastError) }) });
  }

  if (renderFailures.length) {
    sections.push({
      tone: "warn",
      ic: "!",
      html:
        tr("s.527", { p0: renderFailures.length }) +
        `<div class="tiny" style="margin-top:6px">` +
        renderFailures.map((f) => `<code>${esc(f.name)}</code>: ${esc(f.msg)}`).join("<br>") +
        `</div>`,
    });
  }

  const errs = { ...((s && s.errors) || {}) };
  for (const [k, v] of Object.entries((s && s.base && s.base.errors) || {})) errs["base." + k] = v;
  const keys = Object.keys(errs);
  if (keys.length) {
    sections.push({
      tone: "warn",
      ic: "!",
      html:
        tr("s.121", { p0: keys.length }) +
        `<div class="tiny" style="margin-top:6px">${keys.map((k) => `<code>${esc(k)}</code>: ${esc(errs[k])}`).join("<br>")}</div>`,
    });
  }

  if (!sections.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = sections
    .map((x) => `<div class="banner ${x.tone}" style="margin-top:18px"><span class="ic">${x.ic}</span><div>${x.html}</div></div>`)
    .join("");
}

function renderVerdict() {
  const s = state.snap;
  if (!s) return;
  const d = s.derived;
  const v = s.values;
  const lastTrim = state.timeline && state.timeline.last ? state.timeline.last.Trimmed : null;
  const trimAge = lastTrim && state.timeline.blockTime[lastTrim] ? agoBounded(state.timeline.blockTime[lastTrim]) : null;
  const sinceBlocks = lastTrim ? s.blockNumber - lastTrim : null;

  const atLineNow = onTheLine(d);
  /* onTheLine() outranks the raw state: a pool over the line by a few wei is described as sitting
   * on it, and the badge must say what the headline says.
   *
   * Two things at a position like E (held == cap == floor) are BOTH true — the pool is flush
   * against the line, and derive() calls the situation DORMANT because the line has bottomed out.
   * They are not rivals: "贴着触发线" names where the pool sits, DORMANT names what the state
   * machine will do about it, and the card is free to say both. What must not happen is the
   * *tone* claiming recovery, so the CSS class keeps the original author's exemption (a pool at
   * the line only because the line bottomed out is not "live") while the wording stays the
   * at-line wording, which is accurate. Hence two names: `atLineNow` for the wording, `recovered`
   * for the tone. */
  const recovered = atLineNow && d.state !== "DORMANT";
  /* v-title and the badge text both use the at-line wording whenever the pool is at the line,
   * including at E — same reasoning as the headline in renderSummary(). Only the CSS class keeps
   * the author's DORMANT exemption (a pool at the line because the line bottomed out is not
   * "live"), since tone is a judgement while the wording is a description. */
  $("v-title").textContent =
    (atLineNow
      ? tr("s.123")
      : { DORMANT: tr("s.122"), CRITICAL: tr("s.124"), LIVE: tr("s.125") }[d.state]) || tr("s.126");
  const badge = $("v-state");
  badge.className = "badge-state " + (recovered ? "live" : d.state.toLowerCase());
  badge.textContent =
    (atLineNow
      ? tr("s.128")
      : { DORMANT: tr("s.127"), CRITICAL: tr("s.129"), LIVE: tr("s.130") }[d.state]) || d.state;
  $("verdict").className = "verdict " + (d.state === "LIVE" || atLineNow ? "live" : d.state === "CRITICAL" ? "critical" : "");

  const held = v["hook.tokensInPool"];
  const cap = v["hook.inventoryCap"];
  const pending = v["hook.pendingTrim"];

  /* v-answer: three states, and it has to get the FACT right, not just the tone.
   *
   * Two defects here, both of the "the page states something untrue" kind rather than the
   * "two blocks disagree" kind the other P0-3 sites had.
   *
   * 1. E — `held == cap == floor` is reachable, and derive() reports it as DORMANT while calling
   *    it CRITICAL* in none of its branches. The DORMANT arm opened with s.131/s.133: "现在水位
   *    在线的下面" / "the water level is below the line right now". At held == cap the water
   *    level is not below the line, it is exactly ON it, and the same screen's s.139 branch
   *    exists precisely to describe that position. So the branch is split: `held == cap` is not
   *    "below", and must not print a sentence that says it is.
   *
   * 2. B — CRITICAL + atLine (held == cap, pendingTrim == 0) fell through to the `gapRaw === 0n`
   *    arm, whose s.141 says "下一笔卖出会立刻把超出的部分烧掉" — there is no 超出 (excess) to
   *    burn; gapRaw is 0. That arm is right for the LIVE-with-hold-back cases it was written
   *    for, but B reaches it too, and B is the state the site is in as this is written. Threshold
   *    it on atLineNow, which is the same predicate the lede and the badge now use.
   *
   * Ordering: DORMANT first (it cannot be atLine — atLine needs gapRaw === 0 and DORMANT has
   * held < cap), then LIVE-not-atLine, then atLine, then the remaining CRITICAL arm. */
  let answer;
  if (d.state === "DORMANT") {
    /* s.132 is the water-line metaphor and s.133 is its payoff — "the level is below the line,
     * so there is nothing to burn". They are a pair and only make sense together, so they are
     * selected together; s.533 is the stand-in that describes being flush against the line
     * instead of under it. Without s.533, the E cell (held == cap == floor) printed "水位在线的
     * 下面" about a pool whose level equals the line exactly. */
    answer =
      tr("s.131", { p0: fmt18(held, 2), p1: fmt18(cap, 0) }) +
      (held === cap ? tr("s.533") : tr("s.132") + tr("s.133")) +
      (trimAge ? tr("s.134", { p0: trimAge }) : "") +
      tr("s.135", { p0: fmt18(d.floor, 0) }) +
      tr("s.136", { p0: fmt18(cap, 0) });
  } else if (d.state === "LIVE" && !atLineNow) {
    answer =
      tr("s.137", { p0: fmt18(held, 2), p1: fmt18(cap, 2) }) +
      tr("s.138", { p0: fmt18(pending, 4) });
  } else if (atLineNow) {
    /* atLine (gapRaw === 0) from CRITICAL — this is the B state, and the state the live site was
     * in when this was written. s.139/s.140 describe the position accurately; s.141 is the one
     * that must go, because it promises an excess will be burned and gapRaw says there is none.
     *
     * s.139 asserts "正好等于触发线" / "exactly equal to its trigger line", so it may only be
     * printed when that is literally true. atLineNow is true for a whole band, not just the equal
     * point: `cap + 1 wei` and the C band are over the line, and their held is NOT equal to cap
     * even though gapRaw rounds to 0. Printing s.139 there would replace one false statement
     * about geometry with another, so the equal case is keyed on `held === cap` directly and
     * everything else in the atLine band gets wording that does not claim equality.
     *
     * This arm must come before the plain `gapRaw === 0n` arm, which is the LIVE-with-carried-
     * pending case s.141 was actually written for. */
    answer =
      (held === cap
        ? tr("s.139", { p0: fmt18(held, 2), p1: fmt18(cap, 2) }) + tr("s.140")
        : tr("s.538", { p0: fmt18(held, 2), p1: fmt18(cap, 2) })) +
      tr("s.534") +
      (trimAge ? tr("s.142", { p0: trimAge }) : "") +
      tr("s.143", { p0: fmt18(d.floor, 0) });
  } else if (d.gapRaw === 0n) {
    answer =
      tr("s.139", { p0: fmt18(held, 2), p1: fmt18(cap, 2) }) +
      tr("s.140") +
      tr("s.141") +
      (trimAge ? tr("s.142", { p0: trimAge }) : "") +
      tr("s.143", { p0: fmt18(d.floor, 0) });
  } else {
    answer =
      tr("s.144") +
      tr("s.145", { p0: fmt18(d.floor, 0) }) +
      tr("s.146");
  }
  $("v-answer").innerHTML = answer;

  const vl = $("verdict-lede");
  if (vl) {
    /* atLine first, for the same reason the headline and the badge put it first: the card's own
     * title (s.123 "烧毁已恢复，贴着触发线") and the hero's atLine copy already say "recovered",
     * so the lede underneath must not say "销毁暂时停止" — which is what s.148, the plain
     * CRITICAL string, says. That was the whole visible symptom of P0-3 in state B: a success
     * badge over a sentence announcing that burning had paused.
     *
     * But atLine is NOT one situation, and the E cell proves it. E is DORMANT with
     * held == cap == floor: gapRaw is 0, so atLine is true, yet the line has already reached its
     * lowest mark and cannot fall further. s.535 ("销毁随时会被下一笔卖出重新点燃" / "the next
     * sell can relight the burn at any moment") over-promises there — a sell raises held, but the
     * line is pinned, so the pool has to climb past cap under its own steam. s.147, the plain
     * DORMANT string, under-describes it: the pool really is flush against the line, so "销毁已经
     * 停止" reads as if it were far below.
     *
     * E therefore gets wording of its own (s.539) that says both true things at once: the pool is
     * on the line, and relighting depends on the line being able to fall — which it cannot. That
     * is the one position where the paragraph must not be either of the two existing strings.
     * atLine still outranks CRITICAL and LIVE, which is what the P0-3 fix needed. */
    vl.innerHTML =
      atLineNow
        ? d.state === "DORMANT"
          ? tr("s.539")
          : tr("s.535")
        : d.state === "DORMANT"
          ? tr("s.147")
          : d.state === "CRITICAL"
            ? tr("s.148")
            : tr("s.149");
  }

  $("v-gap").textContent = d.gapRaw === 0n ? "0" : fmt18(d.gapRaw, 4);
  // "超出触发线 0.0000 IMD —— 已经具备触发条件" is technically true and completely useless;
  // below the display threshold say what the position actually means.
  $("v-gap-alt").innerHTML =
    d.gapRaw === 0n
      ? atLineNow
        ? tr("s.516")
        : tr("s.150", { p0: fmt18(d.pendingTrim, 4) })
      : `≈ ${fmt18(d.gapEth, 6)} ETH · ≈ $${fmt18(d.gapUsd, 2)}` +
        (d.ethUsd === 0n ? tr("s.151") : `（ETH/USD $${fmt18(d.ethUsd, 2)}）`);

  $("v-held").textContent = fmt18(held, 4);
  $("v-cap").textContent = fmt18(cap, 2);
  $("v-floor").textContent = fmt18(d.floor, 2);
  const pendingShown = fmt18(pending, 4);
  $("v-pending").innerHTML = pending === 0n || pendingShown === "0.0000" ? tr("s.152") : pendingShown;
  $("v-cap-label").textContent = tr("s.153", { p0: fmt18(cap, 0) });

  const pct = cap > 0n ? Number((held * 10000n) / cap) / 100 : 0;
  $("v-fill").style.width = Math.max(0, Math.min(100, pct)).toFixed(1) + "%";

  for (const [elId, key] of [
    ["src-gap", "hook.inventoryCap"],
    ["src-held", "hook.tokensInPool"],
    ["src-cap", "hook.inventoryCap"],
    ["src-floor", "hook.capFloor"],
    ["src-pending", "hook.pendingTrim"],
  ]) {
    const e = $(elId);
    if (e) e.innerHTML = srcTag(key);
  }
}

function renderStates() {
  const s = state.snap;
  if (!s) return;
  const d = s.derived;
  const cur = d.state;
  /* onTheLine(d) — not a local restatement of it.
   *
   * This was the at-line test written out by hand — onTheLine() with the "prints as 0.00"
   * layer removed. It looks like a harmless shortcut, and in the state the page spends most of
   * its time in — exactly on the line, pendingTrim === 0 — the two agree, so it looked right
   * forever. They part company in the narrow band where `gapRaw === 0` and
   * `0 < pendingTrim <= 0.004999 IMD`: the pool is a few wei over the line, and
   * pendingTrim() = floor(L*excess/held) returns a positive value that still prints as "0.00".
   *
   * State the direction precisely, because the intuitive telling is backwards. The copy without
   * the threshold is NARROWER, not wider — it says false exactly where onTheLine() says true. So
   * the damage is not an over-claim that something is burning; it is that two blocks of the same
   * page describe one position two ways. In the C band renderVerdict() calls it "贴着触发线"
   * and renderSummary() prints s.516, while the CRITICAL tile here reads s.159
   * "临界 · 触发线还在降" — the tile saying the line still has room to fall about a position
   * that is already flush against it. Each wording defends itself in isolation. Both at once is
   * the page disagreeing with itself, and that is the one thing this dashboard cannot do.
   *
   * (The highlight was never misapplied: `x.id === cur` picks the tile, and the atLine term only
   * chooses the tone *inside* the tile already selected. B, C and E all highlight the right
   * tile. The whole defect is the one string above.)
   *
   * Fix it by deleting the second copy of the rule, not by retuning the copy. Every other site
   * that needs this verdict calls the function (renderSummary, renderVerdict, the gap line).
   * This was the last hand-rolled one. */
  const atLineNow = onTheLine(d);
  const defs = [
    {
      id: "DORMANT",
      name: tr("s.154"),
      cond: tr("s.155"),
      line: tr("s.156"),
      now: tr("s.157", { p0: fmt18(d.held, 2), p1: fmt18(d.cap, 0), p2: fmt18(d.floor, 0) }),
      tone: "dormant",
    },
    {
      id: "CRITICAL",
      name: atLineNow ? tr("s.158") : tr("s.159"),
      cond: atLineNow
        ? tr("s.160")
        : tr("s.161"),
      line: atLineNow
        ? tr("s.162")
        : tr("s.163"),
      now: atLineNow
        ? tr("s.164", { p0: fmt18(d.held, 2), p1: fmt18(d.cap, 2), p2: fmt18(d.floor, 0) })
        : tr("s.165", { p0: fmt18(d.cap, 2), p1: fmt18(d.floor, 2) }),
      tone: "critical",
    },
    {
      id: "LIVE",
      name: tr("s.166"),
      cond: tr("s.167"),
      line: tr("s.168"),
      /* The "now:" line of the LIVE tile is about *this* reading, so it must not be written
       * from a rule that ignores whether LIVE is the state we are actually in.
       *
       * It used to read pendingTrim > 0n ? s.169 : s.170, which means every non-LIVE state
       * printed s.170 — "当前待烧毁量 0" / "Pending trim 0" — under a tile whose own heading
       * says s.166 "正在烧毁" / "Burning". The page rendered as one self-contradicting line:
       *
       *     ○ 正在烧毁 … 当前：当前待烧毁量 0
       *
       * and did it in exactly the states where it is most wrong to imply a burn is in flight.
       * Under CRITICAL the same string appeared directly beside the CRITICAL tile that was
       * correctly saying nothing is being burned right now.
       *
       * The repair is not a better value, it is a different claim. The tile is a description of
       * a branch of derive() (s.167/s.168 spell out that branch); what happened *this* reading
       * belongs to the active tile. So: only the current state gets the live figure, and every
       * other state gets the honest "not this branch" wording instead of a fabricated zero.
       *
       * A zero is a reading; "the condition is not met" is a fact about which branch we are on.
       * Printing the first when we mean the second is the same class of error as showing a
       * frozen snapshot number without saying it is frozen. */
      now:
        cur === "LIVE"
          ? d.pendingTrim > 0n
            ? tr("s.169", { p0: fmt18(d.pendingTrim, 4) })
            /* LIVE by derive(), but pendingTrim === 0n: the pool is over the line yet this
             * reading has nothing pending. Say what is true of the branch rather than a 0. */
            : tr("s.170")
          : atLineNow
            ? tr("s.531", { p0: fmt18(d.pendingTrim, 4) })
            : tr("s.532"),
      tone: "live",
    },
  ];
  setHtml(
    "states",
    defs
      .map(
        (x) =>
          `<div class="state ${x.id === cur ? "on " + (atLineNow && x.id === "CRITICAL" ? "live" : x.tone) : ""}">` +
          `<div class="name">${x.id === cur ? "● " : "○ "}${esc(x.name)}</div>` +
          `<div class="cond">${x.cond}</div>` +
          `<div class="src-line">${esc(x.line)}</div>` +
          tr("s.171", { p0: x.now }) +
          `</div>`
      )
      .join("")
  );
  setHtml(
    "state-note",
    tr("s.172", { p0: defs.find((x) => x.id === cur)?.name || cur }) +
      tr("s.173") +
      tr("s.174") +
      (atLineNow
        ? tr("s.175") +
          tr("s.176")
        : "") +
      (d.ratchetDead ? tr("s.177") : "")
  );
}

function renderTimeline() {
  const t = state.timeline;
  const s = state.snap;
  if (!t || !s) return;
  const rows = [
    ["MarketOpened", tr("s.178"), "alive"],
    ["Trimmed", tr("s.179"), "dead"],
    ["CapRatcheted", tr("s.180"), "dead"],
    ["BackstopSettled", tr("s.181"), "dead"],
    ["Rebalanced", tr("s.182"), "dead"],
    ["ClaimsSettled", tr("s.183"), "dead"],
    ["FeesWithdrawn", tr("s.184"), "dead"],
    ["FeeCollected", tr("s.185"), "alive"],
    ["DeploymentFloorUpdated", tr("s.186"), "alive"],
  ];
  const out = rows.map(([name, label, tone]) => {
    const b = t.last[name];
    if (!b) return "";
    const ts = t.blockTime[b];
    const age = ts ? ago(ts) : "—";
    const days = blocksToDays(s.blockNumber - b);
    return (
      `<div class="ev ${tone}"><div class="what">${esc(label)}</div>` +
      tr("s.187", { p0: b.toLocaleString(), p1: ts ? iso(ts) : "—" }) +
      tr("s.188", { p0: age, p1: days.toFixed(1) })
    );
  });
  setHtml("timeline", out.join(""));

  const lastTrim = t.last.Trimmed;
  const tl = $("timeline-lede");
  if (tl) {
    const trimDays = blocksToDays(s.blockNumber - lastTrim);
    /* `gapRaw === 0n` was serving as a third, approximate definition of "burning" here — neither
     * derive()'s state nor onTheLine(). State it in terms of the two real predicates instead:
     * LIVE means a burn is under way, onTheLine(d) means the pool is flush against the line. The
     * old form happened to give the right answer in B and C and the wrong one only in DORMANT
     * (gapRaw > 0 there, so it read false while the state machine also said DORMANT — it agreed
     * by luck). Reading the shared predicate removes the luck. */
    const burning = s.derived.state === "LIVE" || onTheLine(s.derived);
    tl.innerHTML =
      tr("s.189") +
      (burning
        ? tr("s.190", { p0: trimDays < 1 ? tr("s.388") : trimDays.toFixed(1) + tr("s.389") }) +
          tr("s.191")
        : tr("s.192", { p0: trimDays.toFixed(1) }) +
          tr("s.193"));
  }
  setHtml(
    "timeline-note",
    tr("s.194", { p0: s.blockNumber.toLocaleString() }) +
      tr("s.195") +
      tr("s.196", { p0: lastTrim.toLocaleString(), p1: blocksToDays(s.blockNumber - lastTrim).toFixed(1) }) +
      tr("s.197") +
      tr("s.198", { p0: t.totalLogs.toLocaleString(), p1: t.scannedTo.toLocaleString() })
  );
}

function renderDoors() {
  const s = state.snap;
  const b = state.baseData;
  if (!s) return;
  const v = s.values;
  const bv = (s.base && s.base.values) || {};

  // door 1 — L1 trim
  const pending = v["hook.pendingTrim"];
  const claims = v["hook.burnClaims"];
  const sinkBal = v["burnExecutor.tokenBalance"];
  setHtml(
    "door1",
    tr("s.199", { p0: pending === 0n ? "var(--dead)" : "var(--live)", p1: pending === 0n ? tr("s.390") : tr("s.391") }) +
      tr("s.200", { p0: fmt18(pending, 4) }) +
      tr("s.201", { p0: fmt18(claims, 6) }) +
      tr("s.202", { p0: esc(v["hook.burnSink"]) }) +
      tr("s.203", { p0: fmt18(sinkBal, 6) }) +
      tr("s.509", {
        p0: (() => {
          const p = v["burnExecutor.previewBridge"];
          if (!p) return UNAVAILABLE;
          return p[0] === 0n
            ? tr("s.510")
            : tr("s.511", { p0: fmt18(p[0], 6), p1: fmt18(p[2], 8) });
        })(),
      })
  );
  setHtml(
    "door1-note",
    pending === 0n
      ? tr("s.204")
      : tr("s.205", { p0: fmt18(pending, 4) })
  );

  // door 2 — Base
  const fp = bv["base.fp.totalSupply"];
  const adapterBal = bv["base.fp.adapterBalance"];
  const recvBal = bv["base.fp.receiverBalance"];
  const dec = bv["base.fp.decimals"] !== undefined ? Number(bv["base.fp.decimals"]) : 18;
  const burns = b ? b.burns : [];
  const bridges = b ? b.bridges : [];
  const lastBurn = burns.length ? burns[burns.length - 1] : null;
  const lastBridge = bridges.length ? bridges[bridges.length - 1] : null;

  setHtml(
    "door2",
    tr("s.206", { p0: esc(b ? b.state.tokenSymbol : "—"), p1: esc(b ? b.state.token : "") }) +
      tr("s.207", { p0: fp === undefined ? UNAVAILABLE : fmtUnits(fp, dec, 4) }) +
      tr("s.208", { p0: adapterBal === undefined ? UNAVAILABLE : fmtUnits(adapterBal, dec, 4) }) +
      tr("s.209", { p0: recvBal === undefined ? UNAVAILABLE : fmtUnits(recvBal, dec, 6) }) +
      tr("s.210", { p0: bridges.length }) +
      tr("s.211", { p0: burns.length }) +
      tr("s.212", { p0: lastBridge && lastBridge.t ? iso(lastBridge.t) : "—" }) +
      tr("s.213", { p0: lastBurn && lastBurn.t ? iso(lastBurn.t) : "—" })
  );
  setHtml(
    "door2-note",
    tr("s.214", { p0: lastBurn && lastBurn.t ? ago(lastBurn.t) : "—" }) +
      tr("s.215") +
      tr("s.216", { p0: lastBurn && lastBurn.t && state.timeline && state.timeline.blockTime[state.timeline.last.Trimmed]
        ? ((lastBurn.t - state.timeline.blockTime[state.timeline.last.Trimmed]) / 86400).toFixed(1)
        : "—" }) +
      tr("s.217") +
      tr("s.218") +
      tr("s.219") +
      tr("s.220")
  );
  setHtml(
    "door2-tech",
    tr("s.221") +
      tr("s.222", { p0: esc(BASE.frenPet) }) +
      tr("s.223") +
      tr("s.224") +
      tr("s.225") +
      tr("s.226")
  );

  // pairing table
  const rows = [];
  const n = Math.max(bridges.length, burns.length);
  for (let i = n - 1; i >= 0 && rows.length < 8; i--) {
    const br = bridges[i];
    const bu = burns[i];
    rows.push(
      `<tr><td class="num">${br ? br.b.toLocaleString() : "—"}</td>` +
        `<td class="tiny">${br && br.t ? iso(br.t) : "—"}</td>` +
        `<td class="num">${bu ? bu.b.toLocaleString() : "—"}</td>` +
        `<td class="tiny">${bu && bu.t ? iso(bu.t) : "—"}</td>` +
        `<td class="tiny">${bu && bu.caller ? esc(bu.caller.slice(0, 10)) + "…" : "—"}</td></tr>`
    );
  }
  setHtml(
    "door-table",
    tr("s.227") +
      `<tbody>${rows.join("")}</tbody>`
  );
}

/* ------------------------------------------------------------------ *
 * the second door, measured
 *
 * BurnExecutor does not burn anything: it collects what trims pull out and waits for
 * someone to pay the bridge fee. So this number is a QUEUE, and its trend is what
 * separates "the pipeline is moving" from "IMD is piling up in a contract". The copy
 * says so in words — the number on its own invites the wrong reading, and that reading
 * is the opposite of the two-door story the rest of the page tells.
 * ------------------------------------------------------------------ */

function renderAwaiting() {
  const s = state.snap;
  if (!s) return;
  const bal = s.values["burnExecutor.tokenBalance"];
  setHtml("awaiting-title", tr("awaiting.title"));

  if (bal === undefined) {
    setHtml("awaiting-stats", statTile(tr("awaiting.current"), UNAVAILABLE, { tone: "dim", srcKey: "burnExecutor.tokenBalance" }));
    setHtml("awaiting-note", tr("awaiting.noteUnavailable"));
    return;
  }

  /* Two clocks on one card — say so, or the card lies by juxtaposition.
   *
   * `now` is the live eth_call (burnExecutor.tokenBalance, refreshed every 60s). The other five
   * points, and therefore net24 / net7d and the "who is pushing" chip, come from
   * data/bridge-history.json, which is rebuilt from Transfer logs on the refresh job's schedule.
   * When that job is current the two clocks are minutes apart and nothing needs saying. When it
   * stops — it stopped for 6.6 hours on 2026-09-24 — the card keeps reading a live balance
   * beside a "24h net change" whose second term froze hours ago, with no visual difference.
   *
   * The subtraction is the part that cannot be repaired by relabelling alone, and it is worth
   * writing down: net24 = now(live) − 24h(frozen) mixes two epochs. That is why the sub-line on
   * each net tile carries the snapshot's own timestamp rather than the card's refresh time.
   *
   * The honest fix is not to fake realtime for the frozen half — the prompt for this round is
   * explicit that labelling staleness beats manufacturing freshness. It is to attach the cutoff
   * to the frozen figures, keep the live figure labelled as live, and say in the note which half
   * is which. `asOf()` already exists for exactly this purpose (it names the snapshot's build
   * time and only appears when mayNotBeLatest()).
   *
   * The real event the frozen series is blind to is surfaced separately below, from base.json's
   * bridges[]/burns[] — an event ledger rather than a sample series, so it is bounded by the
   * snapshot age too and is labelled the same way. */
  const snap = state.bridgeSnapshot;
  /* The frozen half's cutoff. `snap` must be declared before this line — hoisting does not
   * apply to `const`, so reading it earlier throws a ReferenceError, and renderOne() would
   * turn that into a silently blank card rather than a loud failure. */
  const snapAt = snap && snap.fetchedAt ? iso(Math.floor(Date.parse(snap.fetchedAt) / 1000)) : null;
  const toBig = (v) => {
    try {
      return v === null || v === undefined ? null : BigInt(v);
    } catch {
      return null;
    }
  };
  const hist =
    snap && Array.isArray(snap.points) && snap.points.length >= 2
      ? {
          now: bal,
          points: snap.points.map((p) => ({
            label: p.label,
            hoursAgo: p.hoursAgo,
            block: p.block,
            value: p.label === "now" ? bal : toBig(p.value),
          })),
        }
      : null;

  const trend = hist ? readBridgeTrend(hist) : null;
  const verdict = trend ? trend.verdict : "unknown";
  const label =
    verdict === "moving"
      ? tr("awaiting.moving")
      : verdict === "growing"
        ? tr("awaiting.growing")
        : verdict === "flat"
          ? tr("awaiting.flat")
          : tr("awaiting.noHistory");
  const chip = verdict === "moving" ? "good" : verdict === "growing" ? "bad" : "warn";
  const net = (v) =>
    v === null || v === undefined ? UNAVAILABLE : (v > 0n ? "+" : v < 0n ? "−" : "±") + fmt18(v < 0n ? -v : v, 2) + " IMD";

  setHtml(
    "awaiting-stats",
    statTile(tr("awaiting.current"), fmt18(bal, 4) + " IMD", {
      sub: tr("awaiting.currentSub"),
      srcKey: "burnExecutor.tokenBalance",
    }) +
      /* The net tiles get the snapshot's timestamp as their sub, not the page's refresh time:
       * these two numbers are the frozen half of the card and the only place a reader can see
       * which moment they belong to. `awaiting.snapshotAt` reuses the existing key (it is the
       * same sentence the note prints) rather than minting a near-duplicate. */
      statTile(tr("awaiting.net24"), net(trend && trend.net24), {
        small: true,
        sub: snapAt ? tr("awaiting.frozenAsOf", { p0: snapAt }) : tr("awaiting.frozenNoTime"),
        tone: mayNotBeLatest() ? "dim" : "",
      }) +
      statTile(tr("awaiting.net7d"), net(trend && trend.net7d), {
        small: true,
        sub: snapAt ? tr("awaiting.frozenAsOf", { p0: snapAt }) : tr("awaiting.frozenNoTime"),
        tone: mayNotBeLatest() ? "dim" : "",
      }) +
      statTile(tr("awaiting.whoPushes"), `<span class="chip ${chip}">${esc(label)}</span>`, {
        small: true,
        sub: snapAt ? tr("awaiting.frozenAsOf", { p0: snapAt }) : tr("awaiting.frozenNoTime"),
        tone: mayNotBeLatest() ? "dim" : "",
      })
  );

  const explain =
    verdict === "moving"
      ? tr("awaiting.movingExplain")
      : verdict === "growing"
        ? tr("awaiting.growingExplain")
        : verdict === "flat"
          ? tr("awaiting.flatExplain")
          : "";
  const provenance = snapAt ? " " + tr("awaiting.snapshotAt", { p0: snapAt }) : "";
  /* Which moments the two halves of the net figures come from.
   *
   * This card mixes two clocks by design, and the mixing is not obvious from the numbers:
   *
   *   current  — read live, this poll      (burnExecutor.tokenBalance)
   *   net24/7d — (the sample series' "now" slot, which is ALSO filled with the live balance)
   *              minus (a point sampled at a fixed past block from data/bridge-history.json)
   *
   * So net24 is not "the change over 24h as of the snapshot" nor "as of now": it is a
   * subtraction whose two ends belong to different moments — a real balance now, minus a
   * sampled balance at a block tens of thousands back. That is a legitimate reading of the
   * queue's direction, and it is the reason the "someone is pushing" chip can still be right
   * while the series behind it is hours old. But it is NOT a same-moment difference, and a
   * reader who assumes it is will misjudge how fresh the trend is.
   *
   * Rather than pick one clock and lose the other (a stale series would then read as flat, and
   * a live-only reading would lose the trend entirely), each half is labelled with its own
   * cutoff above: the frozen tiles carry the snapshot's timestamp, the note carries the
   * series' own fetchedAt, and this line states the mix in words. */
  const seriesAt = snap && snap.fetchedAt ? iso(Math.floor(Date.parse(snap.fetchedAt) / 1000)) : null;
  const mixedClock = seriesAt ? " " + tr("awaiting.mixedClock", { p0: seriesAt }) : "";
  /* The last real move of the second door, so the card is not blind to an event the sample
   * series cannot contain.
   *
   * The 6-point series samples every 6 hours. A single 1050.49 IMD bridge-and-burn — the largest
   * in the series' history, executed 2026-09-24 15:50 UTC — can fall between two samples, which
   * is exactly what happened while the refresh job was down. When the queue then reads ~0, this
   * card's "24h net change" and its "someone is pushing" chip are both computed from points that
   * may predate the event entirely.
   *
   * base.json's bridges[] is an event LEDGER, not a sample series, so it holds the move itself
   * (block + timestamp + tx). Reading the last entry costs nothing: it is already in memory as
   * part of state.baseData, refreshed on the same cycle as the rest of the Base side. This is
   * deliberately NOT a new eth_getLogs poll — the requirement is to stop the card from being
   * silently wrong, and a ledger that is one Base-refresh old does that while a purpose-built
   * log scanner would add a network path the page does not otherwise need.
   *
   * It is labelled with the same cutoff discipline as everything else: the timestamp shown is
   * the event's own block time, and the "as of" is attached only when the snapshot is behind.
   *
   * Read from state.baseData, not s.base. Both exist and both are about Base, but they are not
   * the same object: s.base is the Base *chain* readings attached to the current poll (address
   * balances, chainId, blockNumber) and carries no event list. The bridges[]/burns[] ledgers come
   * from data/base.json, which boot() loads into state.baseData and which carries its own
   * builtAt. Taking the array off s.base would find nothing and silently drop the line. */
  const baseLedger = state.baseData;
  const lastBridge =
    baseLedger && Array.isArray(baseLedger.bridges) && baseLedger.bridges.length
      ? baseLedger.bridges[baseLedger.bridges.length - 1]
      : null;
  const bridgeLine =
    lastBridge && lastBridge.t
      ? " " + tr("awaiting.lastBridgeBurn", { p0: fmtDateTime(lastBridge.t), p1: lastBridge.b.toLocaleString() }) +
        (baseLedger.builtAt
          ? tr("awaiting.ledgerAsOf", { p0: iso(Math.floor(Date.parse(baseLedger.builtAt) / 1000)) })
          : "")
      : "";
  setHtml(
    "awaiting-note",
    tr("awaiting.what", { amount: fmt18(bal, 2) }) + (explain ? " " + explain : "") + bridgeLine + mixedClock + " " + tr("awaiting.devQuote") + provenance
  );
}

function renderPanel() {
  const s = state.snap;
  if (!s) return;
  const v = s.values;
  const d = s.derived;
  const tile = (label, tag, fn, sub = "", tone = "") => {
    const x = v[tag];
    return statTile(label, x === undefined ? UNAVAILABLE : fn(x), { srcKey: tag, sub, small: true, tone });
  };
  const bool = (label, tag, sub = "") =>
    statTile(label, v[tag] === undefined ? UNAVAILABLE : String(v[tag]), { srcKey: tag, sub, small: true });

  const tiles = [
    tile(tr("s.228"), "hook.tokensInPool", (x) => fmt18(x, 4), tr("s.229")),
    tile(tr("s.230"), "hook.inventoryCap", (x) => fmt18(x, 2), tr("s.231")),
    tile(tr("s.232"), "hook.capFloor", (x) => fmt18(x, 2), tr("s.233")),
    tile(tr("s.234"), "hook.pendingTrim", (x) => (x === 0n ? "0" : fmt18(x, 4)), tr("s.235")),
    tile(tr("s.236"), "hook.ethInPool", (x) => fmt18(x, 6) + " ETH", tr("s.237")),
    tile(tr("s.238"), "hook.positionLiquidity", (x) => x.toString(), tr("s.239")),
    tile(tr("s.240"), "hook.totalBurned", (x) => fmt18(x, 3) + " IMD", tr("s.243")),
    tile(tr("s.242"), "hook.totalRewarded", (x) => fmt18(x, 3) + " IMD", tr("s.241")),
    tile(tr("s.244"), "hook.retainedEth", (x) => fmt18(x, 6) + " ETH", tr("s.245")),
    tile(tr("s.246"), "hook.backstopEthPrincipal", (x) => fmt18(x, 6) + " ETH", tr("s.247")),
    tile(tr("s.248"), "hook.backstopConvertedEth", (x) => fmt18(x, 6) + " ETH", tr("s.249")),
    tile(tr("s.250"), "hook.totalFeeEth", (x) => fmt18(x, 6) + " ETH", tr("s.253"), "warn"),
    tile(tr("s.252"), "hook.totalFeeToken", (x) => fmt18(x, 3) + " IMD", tr("s.251"), "warn"),
    bool(tr("s.254"), "hook.backstopIsFilled", tr("s.255")),
    tile(tr("s.256"), "hook.refTick", (x) => x.toString(), tr("s.257")),
    tile(tr("s.258"), "hook.deploymentFloorTick", (x) => x.toString(), tr("s.259")),
    tile(tr("s.260"), "hook.currentTick", (x) => x.toString(), tr("s.261")),
    tile(tr("s.262"), "hook.rebalanceEthThreshold", (x) => fmt18(x, 4) + " ETH", tr("s.263")),
    tile(tr("s.264"), "hook.keeperReward", (x) => fmt18(x, 6) + " ETH", tr("s.265")),
    bool(tr("s.266"), "hook.marketOpen", tr("s.267")),
    bool(tr("s.268"), "hook.pendingRebalance", tr("s.269")),
    bool(tr("s.270"), "owner.nonce", tr("s.271")),
  ];
  setHtml("panel", tiles.join(""));

  // raw table — includes rows for values we could NOT read, with the reason
  const all = { ...v };
  const errs = { ...(s.errors || {}) };
  const keys = [...new Set([...Object.keys(all), ...Object.keys(errs)])].sort();
  const rows = keys
    .map((k) => {
      const val = all[k];
      const isErr = val === undefined;
      const shown = isErr
        ? ""
        : Array.isArray(val)
          ? val.map((x) => (typeof x === "bigint" ? x.toString() : String(x))).join(", ")
          : typeof val === "bigint"
            ? val.toString()
            : String(val);
      return (
        `<tr><td class="tiny"><code>${esc(k)}</code></td>` +
        `<td class="tiny" style="word-break:break-all">${isErr ? tr("s.001") : esc(shown)}</td>` +
        tr("s.272", { p0: isErr ? esc(errs[k] || tr("s.392")) : "" })
      );
    })
    .join("");
  setHtml("raw-table", tr("s.273", { p0: rows }));
}

/* ---------------- simulator ---------------- */

/** Adapt live snapshot -> the pure simulator's inputs. */
function protocolParams(snap) {
  const v = snap.values;
  return {
    positionLiquidity: v["hook.positionLiquidity"],
    heldNow: v["hook.tokensInPool"],
    capNow: v["hook.inventoryCap"],
    capFloor: v["hook.capFloor"],
    sqrtPriceX96: v["hook.currentSqrtPriceX96"],
    ratchetBps: v["hook.ratchetBps"],
    capDecayTokensPerDay: v["hook.capDecayTokensPerDay"],
    lastCapDecayAt: v["hook.lastCapDecayAt"],
    minTrimTokens: v["hook.minTrimTokens"],
    rewardShareBps: v["hook.rewardShareBps"],
    nowSec: Date.now() / 1000,
  };
}

function simulate(inflowWei, pricePct) {
  const s = state.snap;
  if (!s) return null;
  const p = protocolParams(s);
  /* Every field simulatePure() does arithmetic on must be a real BigInt before we hand it over.
   *
   * This guard used to test only positionLiquidity and heldNow, which is not the set the maths
   * touches. simulatePure() also does BigInt arithmetic on capNow, capFloor, sqrtPriceX96,
   * ratchetBps, capDecayTokensPerDay and lastCapDecayAt. When any of those comes back
   * `undefined` — one hook view failing to read, which lib/contracts.js explicitly retries
   * individually because partial batch failure is routine — the mixed BigInt/Number expression
   * throws "Cannot mix BigInt and other types".
   *
   * Where it threw from is what made it worth its own note: protocolParams() itself does no
   * arithmetic, so the throw came out of simulatePure(), which is called from simulate(), which
   * is called at the top of renderSimulator() — before the `if (!r || r.error)` fallback that
   * exists to render the graceful s.274 message. So the fallback never ran; the renderer just
   * died, and (before renderOne) took eight later renderers with it. The fallback is exactly
   * what this path should reach, so the fix is to make the guard test the whole field set and
   * let s.274 do its job.
   *
   * nowSec is derived from Date.now(), not from the chain, so it is never undefined and is
   * deliberately not listed. */
  for (const field of [
    "positionLiquidity",
    "heldNow",
    "capNow",
    "capFloor",
    "sqrtPriceX96",
    "ratchetBps",
    "capDecayTokensPerDay",
    "lastCapDecayAt",
    "minTrimTokens",
    "rewardShareBps",
  ]) {
    if (typeof p[field] !== "bigint") return null;
  }
  return simulatePure(p, { inflowWei, pricePct });
}

function renderSimulator() {
  const s = state.snap;
  if (!s) return;
  const inflowWei = imdToWei(Number($("sim-inflow").value || 0));
  const pricePct = Number($("sim-price").value || 0);
  const days = Math.max(0, Number($("sim-days").value || 0));
  const r = simulate(inflowWei, pricePct);
  if (!r || r.error) {
    setHtml(
      "sim-out",
      tr("s.274", { p0: r && r.error ? " " + esc(r.error) : "" })
    );
    return;
  }
  const d = s.derived;
  const v = s.values;
  const out = [];
  const st = r.stateAfter;

  out.push(
    `<div class="grid g4">` +
      statTile(tr("s.275"), fmt18(r.held, 4), { small: true, sub: tr("s.276", { p0: fmt18(d.held, 2) }) }) +
      statTile(tr("s.277"), fmt18(r.cap, 2), { small: true, sub: r.ratcheted ? tr("s.278") : tr("s.279") }) +
      statTile(
        tr("s.280"),
        r.gapAfter === 0n ? tr("s.281") : fmt18(r.gapAfter, 4),
        { small: true, tone: r.gapAfter === 0n ? "live" : "", sub: r.gapAfter === 0n ? tr("s.282") : tr("s.283") }
      ) +
      statTile(tr("s.284"), st, { small: true, tone: st === "LIVE" ? "live" : st === "DORMANT" ? "dead" : "warn" }) +
      `</div>`
  );

  if (r.ratcheted) {
    out.push(
      `<div class="banner info"><span class="ic">i</span><div>` +
        tr("s.285", { p0: fmt18(r.ratchetTarget, 4) }) +
        tr("s.286", { p0: fmt18(r.rateFloor, 4), p1: fmt18(v["hook.capFloor"], 2), p2: fmt18(r.cap, 4) }) +
        tr("s.287") +
        `</div></div>`
    );
  }

  if (r.willTrim) {
    out.push(
      `<div class="banner ok"><span class="ic">●</span><div>` +
        tr("s.288", { p0: fmt18(r.excess, 6) }) +
        tr("s.289", { p0: (Number(v["hook.rewardShareBps"]) / 100).toFixed(0), p1: (100 - Number(v["hook.rewardShareBps"]) / 100).toFixed(0) }) +
        tr("s.290", { p0: fmt18(r.burned, 6), p1: fmt18(r.rewarded, 6) }) +
        `</div></div>`
    );
  } else {
    out.push(
      `<div class="banner warn"><span class="ic">○</span><div>` +
        tr("s.291", { p0: fmt18(r.held, 4), p1: fmt18(r.cap, 2) }) +
        tr("s.292", { p0: fmt18(r.gapAfter, 4) }) +
        (r.ratcheted
          ? tr("s.293", { p0: fmt18(r.gapAfter, 4) })
          : tr("s.294")) +
        `</div></div>`
    );
  }

  if (days > 0 && inflowWei > 0n) {
    const h = simulateHorizon(protocolParams(s), { startHeld: r.held, startCap: r.cap, perDayWei: inflowWei, days });
    out.push(
      `<div class="grid g4">` +
        statTile(tr("s.295", { p0: days }), String(h.fired), { small: true, sub: h.firstFireDay ? tr("s.296", { p0: h.firstFireDay }) : tr("s.297") }) +
        statTile(tr("s.298"), fmt18(h.totalBurned, 4) + " IMD", { small: true, sub: tr("s.299") }) +
        statTile(tr("s.300"), fmt18(h.totalRewarded, 4) + " IMD", { small: true }) +
        statTile(tr("s.301"), h.endHeld >= h.endCap ? "0" : fmt18(h.endCap - h.endHeld, 4), { small: true }) +
        `</div>`
    );
    if (h.firstFireDay) {
      const when = new Date(Date.now() + h.firstFireDay * 86400000).toISOString().slice(0, 10);
      out.push(
        `<div class="banner info"><span class="ic">i</span><div>` +
          tr("s.302", { p0: fmt18(inflowWei, 2), p1: h.firstFireDay, p2: when }) +
          tr("s.303") +
          `</div></div>`
      );
    }
  }
  setHtml("sim-out", out.join(""));
}

function renderTrimNow() {
  const s = state.snap;
  if (!s) return;
  const d = s.derived;
  const v = s.values;
  const share = Number(v["hook.rewardShareBps"]);
  setHtml(
    "trim-now",
    statTile(tr("s.304"), d.pendingTrim === 0n ? "0" : fmt18(d.pendingTrim, 6) + " IMD", {
      srcKey: "hook.pendingTrim",
      tone: d.pendingTrim === 0n ? "dead" : "live",
      sub: d.pendingTrim === 0n ? tr("s.305") : tr("s.306"),
      small: true,
    }) +
      statTile(tr("s.307"), fmt18(d.pendingBurn, 6) + " IMD", {
        small: true,
        sub: `${(100 - share / 100).toFixed(2)}%`,
      }) +
      statTile(tr("s.308"), fmt18(d.pendingReward, 6) + " IMD", { small: true, sub: `${(share / 100).toFixed(2)}%` }) +
      /* This tile is a CEILING, not a reading, and it sat in a row with two readings.
       *
       * The two tiles to its left are computed live from the chain's 1500 bps:
       * (100 - share/100) = 85.00% and (share/100) = 15.00%. Both describe the hook as
       * configured right now. This tile printed the literal string "30%", which is
       * MAX_REWARD_SHARE_BPS = 3000 — the value rewardShareBps() can never exceed. Three
       * percentages side by side read as three facts about the current config; the third was
       * a bound. The card's own s.310 ("销毁恒 ≥70%，owner 无法调高") is the only thing that
       * hinted otherwise, one line down and in small print.
       *
       * It also had no data source at all. It carried srcKey: "hook.rewardShareBps" while
       * printing 30%, so the tooltip pointed at the 15% view — a reader who followed it would
       * find 1500 bps and conclude the page was broken. And baseline.json has no
       * hook.maxRewardShareBps: lib/contracts.js does define the read
       * (maxRewardShareBps: fn("MAX_REWARD_SHARE_BPS")), but it was never wired into collect(),
       * and its own comment says the getter is an `internal const` that `may revert` — so it is
       * not reliably readable and adding it to the poll would risk a permanent error entry for
       * a constant.
       *
       * So: report it as what it is, label it a ceiling in words, and drop the false srcKey.
       * A srcKey is a promise that a number came from a named view; the honest value here is
       * no srcKey at all, plus an explicit label. Distinguishing the bound from the readings
       * is the requirement — inventing a chain read for a constant is not. */
      statTile(tr("s.536"), "30%", {
        small: true,
        sub: tr("s.310"),
        tone: "dim",
      })
  );
  const tnl = $("trim-now-lede");
  if (tnl) {
    tnl.innerHTML =
      d.pendingTrim === 0n
        ? tr("s.311")
        : tr("s.312", { p0: fmt18(d.pendingTrim, 4), p1: (100 - share / 100).toFixed(2), p2: (share / 100).toFixed(2) });
  }
}

function renderRewards() {
  const s = state.snap;
  if (!s) return;
  const v = s.values;
  const tile = (label, tag, fn, sub = "", tone = "") => {
    const x = v[tag];
    return statTile(label, x === undefined ? UNAVAILABLE : fn(x), { srcKey: tag, sub, small: true, tone });
  };
  setHtml(
    "rewards",
    tile(
      tr("s.313"),
      "dripper.drippable",
      (x) => fmt18(x, 6) + " IMD",
      tr("s.314"),
      v["dripper.drippable"] === 0n ? "dead" : "live"
    ) +
      statTile(
        tr("s.315"),
        v["bal.imd.dripper"] === undefined ? UNAVAILABLE : fmt18(v["bal.imd.dripper"], 6) + " IMD",
        { srcKey: "bal.imd.dripper", small: true, sub: tr("s.316") }
      ) +
      tile(tr("s.317"), "dripper.dripRatePerSecond", (x) => fmt18(x * 86400n, 2) + tr("s.318"), tr("s.319")) +
      tile(tr("s.320"), "dripper.lastDripAt", (x) => iso(Number(x)), tr("s.321")) +
      statTile(tr("s.322"), v["dripper.canDrip"] === undefined ? UNAVAILABLE : String(v["dripper.canDrip"]), {
        srcKey: "dripper.canDrip",
        small: true,
        sub: tr("s.323"),
      }) +
      tile(tr("s.324"), "dripper.minDripAmount", (x) => fmt18(x, 4) + " IMD", tr("s.325")) +
      statTile(
        tr("s.326"),
        v["distributor.heldBonding"] === undefined ? UNAVAILABLE : fmt18(v["distributor.heldBonding"], 6) + " IMD",
        { srcKey: "distributor.heldBonding", small: true, sub: tr("s.329") }
      ) +
      statTile(
        tr("s.328"),
        v["distributor.heldNft"] === undefined ? UNAVAILABLE : fmt18(v["distributor.heldNft"], 6) + " IMD",
        { srcKey: "distributor.heldNft", small: true, sub: tr("s.327") }
      ) +
      statTile(
        tr("s.330"),
        (() => {
          const a = v["distributor.heldBonding"];
          const b = v["distributor.heldNft"];
          return a === undefined || b === undefined ? UNAVAILABLE : fmt18(a + b, 6) + " IMD";
        })(),
        { small: true, tone: "warn", sub: tr("s.331") }
      ) +
      tile(tr("s.332"), "distributor.stakingEarned", (x) => fmt18(x, 6) + " IMD", tr("s.333")) +
      statTile(
        tr("s.334"),
        (() => {
          const a = v["distributor.stakingBps"];
          const b = v["distributor.bondingBps"];
          const c = v["distributor.nftBps"];
          if (a === undefined || b === undefined || c === undefined) return UNAVAILABLE;
          return `${Number(a) / 100}% / ${Number(b) / 100}% / ${Number(c) / 100}%`;
        })(),
        { small: true, sub: tr("s.335"), srcKey: "distributor.stakingBps" }
      )
  );
}

function renderSimd() {
  const s = state.snap;
  if (!s) return;
  const d = s.derived;
  const v = s.values;
  setHtml(
    "simd",
    statTile(tr("s.336"), fmt18(d.totalAssets, 4) + " IMD", {
      srcKey: "simd.totalAssets",
      small: true,
      sub: tr("s.337"),
    }) +
      statTile(tr("s.338"), fmtUnits(d.totalSupply, d.simdDecimals, 4) + " sIMD", {
        srcKey: "simd.totalSupply",
        small: true,
        sub: tr("s.339", { p0: d.simdDecimals }),
      }) +
      statTile(tr("s.340"), fmt18(d.simdRate, 6) + " IMD", {
        small: true,
        tone: "warn",
        sub: tr("s.341"),
      }) +
      statTile(tr("s.342"), (Number(d.simdShareOfSupply) / 100).toFixed(2) + "%", {
        srcKey: "imd.totalSupply",
        small: true,
        sub: tr("s.343"),
      }) +
      statTile(tr("s.344"), v["simd.paused"] === undefined ? UNAVAILABLE : String(v["simd.paused"]), {
        srcKey: "simd.paused",
        small: true,
        sub: tr("s.345"),
      }) +
      statTile(tr("s.346"), tr("s.347"), {
        srcKey: "simd.decimals",
        small: true,
        sub: tr("s.348"),
      })
  );
  const injected = d.totalAssets > d.totalSupply ? d.totalAssets - (d.totalSupply * 10n ** 18n) / 10n ** BigInt(d.simdDecimals) : 0n;
  setHtml(
    "simd-explain",
    tr("s.349") +
      tr("s.350") +
      tr("s.351") +
      tr("s.352") +
      tr("s.353") +
      tr("s.354") +
      `<div class="note">` +
      tr("s.355") +
      tr("s.356") +
      tr("s.357") +
      tr("s.358") +
      tr("s.359") +
      tr("s.360") +
      tr("s.361", { p0: fmt18(v["hook.totalRewarded"] || 0n, 2) }) +
      tr("s.362", { p0: fmt18(v["distributor.stakingEarned"] || 0n, 2) }) +
      tr("s.363") +
      `</div></details>`
  );
}

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

function renderOwner() {
  const s = state.snap;
  if (!s) return;
  const v = s.values;

  const status = OWNER_CONTRACTS.map((c) => {
    const raw = v[c.ownerKey];
    const owner = raw === undefined ? null : String(raw).toLowerCase();
    return { ...c, owner, renounced: owner === ZERO_ADDR, unknown: owner === null };
  });
  const renouncedList = status.filter((c) => c.renounced);
  const liveList = status.filter((c) => !c.renounced && !c.unknown);
  const unknownList = status.filter((c) => c.unknown);

  const livePowers = liveList.reduce((n, c) => n + c.powerIds.length, 0);

  setHtml(
    "owner-summary",
    statTile(tr("s.364"), `${renouncedList.length} / ${status.length}`, {
      small: true,
      tone: renouncedList.length ? "live" : "",
      sub: renouncedList.map((c) => c.contract).join(tr("s.512")) || tr("s.367"),
    }) +
      statTile(tr("s.366"), String(liveList.length), {
        small: true,
        tone: liveList.length ? "dead" : "live",
        sub: liveList.map((c) => c.contract).join(tr("s.512")) || tr("s.365"),
      }) +
      statTile(tr("s.368"), String(livePowers) + tr("s.369"), {
        small: true,
        tone: livePowers ? "dead" : "live",
        sub: unknownList.length ? tr("s.370", { p0: unknownList.length }) : tr("s.371"),
      })
  );

  setHtml(
    "owner-contracts",
    status
      .map((c) => {
        const powers = c.powerIds
          .map((id) => OWNER_POWERS.find((p) => p.id === id))
          .filter(Boolean);
        const badge = c.unknown
          ? tr("s.372")
          : c.renounced
            ? tr("s.373")
            : tr("s.374");
        const ownerLine = c.unknown
          ? tr("s.375", { p0: esc(c.ownerKey) })
          : c.renounced
            ? tr("s.376", { p0: ZERO_ADDR })
            : `<a href="https://etherscan.io/address/${c.owner}" target="_blank" rel="noopener"><code>${esc(c.owner)}</code></a>`;
        return (
          `<div class="owner-card ${c.unknown ? "" : c.renounced ? "safe" : "risk"}">` +
          `<div class="owner-head"><div><b>${esc(c.contract)}</b> <span class="tiny muted">${esc(td(c.role))}</span></div>${badge}</div>` +
          `<div class="owner-addr-line"><span class="tiny muted">owner</span> ${ownerLine}</div>` +
          `<p class="owner-note">${c.unknown ? tr("s.377") : c.renounced ? esc(td(c.renouncedNote)) : esc(td(c.liveNote))}</p>` +
          (powers.length
            ? `<ul class="owner-powers">${powers
                .map(
                  (p) =>
                    `<li><span class="sev ${p.severity}">${p.severity}</span> ` +
                    `<code class="tiny">${esc(p.fn)}</code> ` +
                    `<span class="tiny muted">${esc(p.line)}</span>` +
                    `<div class="tiny">${td(p.what)}</div>` +
                    (p.quote ? `<blockquote>“${esc(p.quote)}”<cite>— ${esc(p.quoteLine)}</cite></blockquote>` : "") +
                    `</li>`
                )
                .join("")}</ul>`
            : tr("s.395")) +
          `</div>`
        );
      })
      .join("")
  );

  const lede = $("owner-lede");
  if (lede) {
    lede.innerHTML =
      tr("s.396", { p0: status.length }) +
      (renouncedList.length
        ? tr("s.397", { p0: renouncedList.map((c) => c.contract).join(tr("s.512")) }) +
          tr("s.398")
        : "") +
      (liveList.length
        ? tr("s.399", { p0: liveList.map((c) => c.contract).join(tr("s.512")) }) +
          tr("s.400", { p0: livePowers })
        : "") +
      tr("s.401");
  }

  const rows = OWNER_POWERS.map((p) => {
    const owner = v[(OWNER_CONTRACTS.find((c) => c.addr === p.addr) || {}).ownerKey];
    const isZero = owner !== undefined && String(owner).toLowerCase() === ZERO_ADDR;
    return (
      `<tr${isZero ? ' style="opacity:.55"' : ""}>` +
      `<td><span class="sev ${p.severity}">${p.severity}</span></td>` +
      `<td><div style="font-weight:600">${esc(p.contract)}</div><div class="tiny muted"><a href="https://etherscan.io/address/${p.addr}#code" target="_blank" rel="noopener">${esc(p.addr)}</a></div></td>` +
      `<td><code class="tiny">${esc(p.fn)}</code><div class="tiny muted">${esc(p.line)}</div></td>` +
      `<td class="tiny">${td(p.what)}${p.quote ? `<blockquote>“${esc(p.quote)}”<cite>— ${esc(p.quoteLine)}</cite></blockquote>` : ""}</td>` +
      `<td class="tiny">${isZero ? tr("s.378") : tr("s.379")}</td>` +
      `</tr>`
    );
  }).join("");
  setHtml(
    "powers",
    tr("s.402", { p0: rows })
  );
}

/* ------------------------------------------------------------------ *
 * on-chain messages — the dev's only announcement channel
 * ------------------------------------------------------------------ */

const MSG_FILTERS = {
  all: (m) => true,
  dev: (m) => m.isDev,
  community: (m) => !m.isDev,
  key: (m) => !!m.important,
};

/** How many messages are rendered before the "show all" button appears. */
const MSG_PAGE = 6;

function renderMessages() {
  const data = state.messages;
  const el = $("messages-list");
  if (!el) return;
  if (!data || !data.messages || !data.messages.length) {
    el.innerHTML = tr("s.403");
    return;
  }
  const all = data.messages;
  const devCount = all.filter((m) => m.isDev).length;
  const commCount = all.length - devCount;
  const keyCount = all.filter((m) => m.important).length;

  const setN = (id, n) => {
    const e = $(id);
    if (e) e.textContent = String(n);
  };
  setN("msgf-all-n", all.length);
  setN("msgf-dev-n", devCount);
  setN("msgf-community-n", commCount);
  setN("msgf-key-n", keyCount);

  const newestDev = all.find((m) => m.isDev);
  const ageDays = newestDev ? (Date.now() / 1000 - newestDev.ts) / 86400 : null;
  const lede = $("messages-lede");
  if (lede) {
    lede.innerHTML =
      tr("s.404") +
      tr("s.405", { p0: all.length, p1: devCount }) +
      tr("s.406", { p0: commCount }) +
      (ageDays !== null && ageDays > 7
        ? tr("s.407", { p0: ageDays.toFixed(0) })
        : ageDays !== null
          ? tr("s.408", { p0: ageDays < 1 ? tr("s.380") : ageDays.toFixed(0) + tr("s.381") })
          : "");
  }

  // the newest dev post gets its own card at the top
  const card = $("messages-latest-card");
  if (card && newestDev) {
    card.style.display = "";
    setHtml("messages-latest", renderMessageBody(newestDev, true));
  } else if (card) {
    card.style.display = "none";
  }

  const filter = MSG_FILTERS[state.msgFilter] || MSG_FILTERS.all;
  const shown = all.filter(filter);
  // 70+ entries, each a multi-line English quote: rendered in full they make "证据" a
  // scroll with no end, which is what the reader complained about. Show the newest few and
  // let the button do the rest — the filters above still search the whole set.
  const visible = state.msgShowAll ? shown : shown.slice(0, MSG_PAGE);
  el.innerHTML = visible.length
    ? visible.map((m) => renderMessageBody(m, false)).join("")
    : tr("s.409");

  const more = $("messages-more");
  const toggle = $("msg-toggle");
  if (more && toggle) {
    const hidden = shown.length - visible.length;
    if (hidden > 0) {
      toggle.hidden = false;
      toggle.textContent = tr("msg.showAll", { p0: shown.length });
    } else if (state.msgShowAll && shown.length > MSG_PAGE) {
      toggle.hidden = false;
      toggle.textContent = tr("msg.showLess");
    } else {
      toggle.hidden = true;
    }
    toggle.onclick = () => {
      state.msgShowAll = !state.msgShowAll;
      renderMessages();
    };
  }

  setHtml(
    "messages-tech",
    tr("s.410", { p0: esc(data.address) }) +
      tr("s.411") +
      tr("s.412") +
      tr("s.413", { p0: data.counts.txs, p1: data.counts.decoded, p2: data.counts.undecodable }) +
      tr("s.414", { p0: data.devAddresses.map((a) => `<code>${esc(a)}</code>`).join(tr("s.382")) }) +
      tr("s.415", { p0: esc(data.address) }) +
      tr("s.416", { p0: new Date(data.fetchedAt).toISOString().replace("T", " ").slice(0, 19) }) +
      tr("s.417")
  );
}

function renderMessageBody(m, expanded) {
  const when = iso(m.ts);
  const age = ago(m.ts);
  const who = m.isDev
    ? `<span class="chip good">${tr("msg.fromDev")}</span>`
    : `<span class="chip">${tr("msg.fromCommunity", { addr: esc(m.from.slice(0, 10)) })}</span>`;
  // The "important" note is data (from fetch-messages.mjs, written in Chinese). Prefer
  // the localised key so English mode does not leak Chinese; fall back to the raw note.
  const key = "important." + m.block;
  const importantText = m.important ? (hasKey(key) ? tr(key) : m.important) : "";
  const keyTag = m.important ? `<span class="chip warn">${tr("msg.keyPrefix")}${esc(importantText)}</span>` : "";
  const text = esc(m.text);
  const isLong = m.text.length > 220;

  // The English text is the evidence and is shown in BOTH languages — never hidden
  // behind a translation. The Chinese summary is additive, and is visually marked as
  // ours (mono block vs. indented sans-serif line with an explicit tag) so the two
  // can never be confused at a glance, including on a phone.
  const zhEntry = state.messagesZh && state.messagesZh[String(m.block)];
  const summary =
    getLang() === "zh" && zhEntry && zhEntry.summary
      ? `<div class="msg-summary"><span class="tag">${tr("msg.unofficialTranslation")}</span>${esc(zhEntry.summary)}</div>`
      : "";

  return (
    `<div class="msg ${m.isDev ? "from-dev" : "from-community"} ${m.important ? "key" : ""}">` +
    `<div class="msg-head">${who}${keyTag}<span class="tiny muted">${tr("msg.block")} ${m.block.toLocaleString()} · ${when} · ${age}</span></div>` +
    `<div class="msg-verbatim-label tiny">${tr("msg.verbatimLabel")}</div>` +
    `<div class="msg-body ${isLong && !expanded ? "clamped" : ""}">${text}</div>` +
    (isLong && !expanded ? `<button type="button" class="msg-more" data-msg="${esc(m.tx)}">${tr("msg.expand")}</button>` : "") +
    summary +
    `<div class="msg-foot"><a href="https://etherscan.io/tx/${esc(m.tx)}" target="_blank" rel="noopener">${tr("msg.viewOnEtherscan")}</a></div>` +
    `</div>`
  );
}

function initMessageFilters() {
  for (const k of Object.keys(MSG_FILTERS)) {
    const b = $("msgf-" + k);
    if (b && b.addEventListener) {
      b.addEventListener("click", () => {
        state.msgFilter = k;
        // A filter is a fresh question: collapse back to the newest few rather than
        // leaving a 40-entry list open because the previous filter was expanded.
        state.msgShowAll = false;
        for (const k2 of Object.keys(MSG_FILTERS)) {
          const b2 = $("msgf-" + k2);
          if (b2) b2.className = "preset" + (k2 === k ? " active" : "");
        }
        renderMessages();
      });
    }
  }
  const list = $("messages-list");
  if (list && list.addEventListener) {
    list.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest(".msg-more") : null;
      if (!btn) return;
      const body = btn.previousElementSibling;
      if (body) body.className = "msg-body";
      btn.remove();
    });
  }
}

/* ---------------- parameter change monitor ---------------- */

function readWatch(snap) {
  const out = {};
  for (const w of WATCHED) {
    const val = snap.values[w.c + "." + w.k];
    out[w.id] = val === undefined ? null : typeof val === "bigint" ? val.toString() : String(val);
  }
  out["__nonce"] = snap.values["owner.nonce"] !== undefined ? String(snap.values["owner.nonce"]) : null;
  out["__block"] = String(snap.blockNumber);
  return out;
}

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {}
}

function renderMonitor() {
  const s = state.snap;
  if (!s) return;
  const cur = readWatch(s);
  const prev = loadJson(LS_WATCH, null);
  const log = loadJson(LS_LOG, []);

  const changes = [];
  if (prev) {
    for (const w of WATCHED) {
      const a = prev[w.id];
      const b = cur[w.id];
      if (a !== undefined && a !== null && b !== null && a !== b) {
        changes.push({ id: w.id, label: w.label, from: a, to: b, src: w.src, at: Date.now(), block: s.blockNumber });
      }
    }
    if (prev["__nonce"] && cur["__nonce"] && prev["__nonce"] !== cur["__nonce"]) {
      const delta = Number(cur["__nonce"]) - Number(prev["__nonce"]);
      changes.push({
        // Keys, not translated strings: this record is written to localStorage and read
        // back later, so it must be able to follow a language switch.
        id: "__nonce",
        label: "s.418",
        from: prev["__nonce"],
        to: cur["__nonce"],
        src: "s.419",
        at: Date.now(),
        block: s.blockNumber,
        nonceDelta: delta,
      });
    }
  }

  if (changes.length) {
    const newLog = [...changes.map((c) => ({ ...c, firstSeen: c.at })), ...log].slice(0, 200);
    saveJson(LS_LOG, newLog);
  }
  saveJson(LS_WATCH, cur);

  const nonceChanged = changes.some((c) => c.id === "__nonce");
  const paramChanged = changes.filter((c) => c.id !== "__nonce");

  $("monitor-status").innerHTML = !prev
    ? tr("s.420")
    : changes.length === 0
      ? tr("s.421", { p0: WATCHED.length })
      : tr("s.422", {
          p0: changes.length,
          p1: paramChanged.length ? tr("s.383", { p0: paramChanged.length }) : "",
          p2: nonceChanged ? tr("s.384") : "",
        });

  const rows = WATCHED.map((w) => {
    const val = cur[w.id];
    const pv = prev ? prev[w.id] : null;
    const changed = pv !== null && val !== null && pv !== val;
    const shown = val === null ? UNAVAILABLE : formatWatchValue(w, val);
    return (
      `<tr${changed ? ' style="background:#1c1113"' : ""}>` +
      `<td class="tiny"><code>${esc(w.label)}</code></td>` +
      `<td class="tiny">${shown}${changed ? ` <span class="chip bad">← ${esc(formatWatchValue(w, pv))}</span>` : ""}</td>` +
      `<td class="tiny muted">${esc(td(w.src))}</td></tr>`
    );
  }).join("");
  setHtml("watch-table", tr("s.423", { p0: rows }));

  const logRows = log
    .slice(0, 40)
    .map(
      (c) =>
        `<tr><td class="tiny">${new Date(c.firstSeen).toISOString().replace("T", " ").slice(0, 19)}</td>` +
        `<td class="tiny"><code>${esc(td(c.label))}</code></td>` +
        `<td class="tiny">${esc(c.from)} → <b>${esc(c.to)}</b></td>` +
        `<td class="tiny muted">${esc(td(c.src))}</td></tr>`
    )
    .join("");
  setHtml(
    "watch-log",
    log.length
      ? tr("s.424", { p0: logRows })
      : tr("s.425")
  );
}

function formatWatchValue(w, val) {
  if (val === null) return tr("s.426");
  if (typeof val !== "string") return String(val);
  if (val.startsWith("0x") && val.length === 42) return val;
  try {
    const b = BigInt(val);
    if (w.unit === "ETH") return fmt18(b, 6) + " ETH";
    if (w.unit === "IMD") return fmt18(b, 2) + " IMD";
    if (w.unit === "IMD/day") return fmt18(b, 0) + tr("s.427");
    if (w.unit === "bps") return b.toString() + " bps";
    if (w.unit === "ticks" || w.unit === "ticks/day") return b.toString();
    return b.toString();
  } catch {
    return val;
  }
}

/* ---------------- history ---------------- */

function renderHistory() {
  const t = state.timeline;
  const s = state.snap;
  if (!t || !s) return;
  const trims = t.trims || [];
  const settles = t.backstopSettles || [];
  $("hist-count").textContent = String(trims.length + settles.length);
  $("hist-range").textContent = `${t.scannedFrom.toLocaleString()} – ${t.scannedTo.toLocaleString()}`;

  // sparkline: burned per event, log-ish scaling for visibility
  const W = 800;
  const H = 90;
  const series = [
    ...trims.map((x) => ({ t: x.t, v: Number(x.burned) / 1e18, kind: "trim" })),
    ...settles.map((x) => ({ t: x.t, v: Number(x.burned) / 1e18, kind: "settle" })),
  ]
    .filter((x) => x.t)
    .sort((a, b) => a.t - b.t);
  if (series.length) {
    const t0 = series[0].t;
    const t1 = series[series.length - 1].t;
    const maxV = Math.max(...series.map((x) => x.v), 1);
    const bars = series
      .map((x) => {
        const px = ((x.t - t0) / Math.max(1, t1 - t0)) * (W - 4);
        const h = Math.max(1.2, (Math.log10(1 + x.v) / Math.log10(1 + maxV)) * (H - 6));
        const color = x.kind === "trim" ? "#ff5d5d" : "#35d07f";
        return `<rect x="${px.toFixed(1)}" y="${(H - h).toFixed(1)}" width="1.8" height="${h.toFixed(1)}" fill="${color}" opacity="0.85"/>`;
      })
      .join("");
    $("spark").innerHTML = bars;
  }

  const totalBurned = trims.reduce((a, x) => a + BigInt(x.burned), 0n) + settles.reduce((a, x) => a + BigInt(x.burned), 0n);
  const totalRewarded = trims.reduce((a, x) => a + BigInt(x.rewarded), 0n) + settles.reduce((a, x) => a + BigInt(x.rewarded), 0n);
  const lastTrim = trims.length ? trims[trims.length - 1] : null;
  const firstTrim = trims.length ? trims[0] : null;

  setHtml(
    "hist-stats",
    statTile(tr("s.428"), String(trims.length), {
      small: true,
      sub: tr("s.429", { p0: settles.length }),
    }) +
      statTile(tr("s.430"), fmt18(totalBurned, 4) + " IMD", { small: true, sub: tr("s.431") }) +
      statTile(tr("s.432"), fmt18(totalRewarded, 4) + " IMD", { small: true }) +
      statTile(
        tr("s.433"),
        fmt18(trims.reduce((a, x) => (BigInt(x.burned) > a ? BigInt(x.burned) : a), 0n), 4) + " IMD",
        { small: true }
      )
  );

  const hl = $("history-lede");
  if (hl && lastTrim) {
    const days = blocksToDays(s.blockNumber - lastTrim.b);
    hl.innerHTML =
      tr("s.434", { p0: trims.length }) +
      tr("s.435", { p0: settles.length }) +
      tr("s.436", { p0: firstTrim.b.toLocaleString(), p1: lastTrim.b.toLocaleString() }) +
      tr("s.437", { p0: days.toFixed(1) });
  }
  setHtml(
    "hist-note",
    tr("s.438") +
      tr("s.439") +
      tr("s.440") +
      tr("s.441") +
      tr("s.442") +
      tr("s.443") +
      tr("s.444") +
      tr("s.445") +
      tr("s.446") +
      tr("s.447", { p0: firstTrim ? firstTrim.b.toLocaleString() : "—", p1: lastTrim ? lastTrim.b.toLocaleString() : "—" })
  );
}

function renderPools() {
  const s = state.snap;
  if (!s) return;
  const v = s.values;
  const d = s.derived;
  const rows = [
    { name: tr("s.448"), id: POOL_IDS.A, key: "poolA", fee: POOLS.A.fee, sp: POOLS.A.tickSpacing, hooks: tr("s.449"), burn: tr("s.450") },
    { name: tr("s.451"), id: POOL_IDS.B, key: "poolB", fee: POOLS.B.fee, sp: POOLS.B.tickSpacing, hooks: ADDR.hook, burn: tr("s.452") },
  ]
    .map((p) => {
      const slot0 = v[p.key + ".slot0"];
      const liq = v[p.key + ".liquidity"];
      const price = p.key === "poolA" ? d.priceA : d.priceB;
      return (
        `<tr>` +
        `<td><b>${esc(p.name)}</b><div class="tiny muted"><code>${esc(p.id)}</code></div></td>` +
        `<td class="num">${p.fee / 10000}%</td>` +
        `<td class="num">${p.sp}</td>` +
        `<td class="tiny" style="word-break:break-all">${esc(p.hooks)}</td>` +
        `<td>${p.burn}</td>` +
        `<td class="num">${slot0 === undefined ? UNAVAILABLE : String(slot0[1])}</td>` +
        `<td class="num">${liq === undefined ? UNAVAILABLE : liq.toString()}</td>` +
        `<td class="num">${fmt18(price.ethPerImd, 12)}</td>` +
        `</tr>`
      );
    })
    .join("");
  setHtml(
    "pools",
    tr("s.453", { p0: rows })
  );
  setHtml(
    "pools-tech",
    tr("s.454") +
      tr("s.455") +
      tr("s.456") +
      tr("s.457") +
      tr("s.458", { p0: esc(ADDR.stateView) }) +
      tr("s.459") +
      tr("s.460")
  );
}

function renderFooter() {
  const s = state.snap;
  if (!s) return;
  const errs = Object.keys(s.errors || {}).length + Object.keys((s.base && s.base.errors) || {}).length;
  setHtml(
    "footer-src",
    tr("s.461", { p0: esc(s.endpoint), p1: s.blockNumber.toLocaleString() }) +
      tr("s.462", { p0: s.base && s.base.blockNumber ? s.base.blockNumber.toLocaleString() : tr("s.385") }) +
      tr("s.463", { p0: errs }) +
      tr("s.464", { p0: esc(POOL_IDS.B) })
  );
}

/* ------------------------------------------------------------------ *
 * simulator presets — so nobody has to fill in a blank form
 *
 * `hint` holds a locale KEY, not a translated string: this object is built while the
 * module loads, which is before initI18n() has read a single dictionary, so calling
 * tr() here would freeze the key name ("s.465") into the page.
 * ------------------------------------------------------------------ */

const PRESETS = {
  calm: {
    inflow: 1000,
    price: 0,
    days: 30,
    hint: "s.465",
  },
  dump: {
    inflow: 0,
    price: -20,
    days: 0,
    hint: "s.466",
  },
  flat: {
    inflow: 0,
    price: 0,
    days: 0,
    hint: "s.467",
  },
  custom: null,
};

function applyPreset(name) {
  state.preset = name;
  for (const k of Object.keys(PRESETS)) {
    const b = $("preset-" + k);
    if (b) b.className = "preset" + (k === name ? " active" : "");
  }
  const p = PRESETS[name];
  if (p) {
    for (const [numId, rangeId, val] of [
      ["sim-inflow", "sim-inflow-r", p.inflow],
      ["sim-price", "sim-price-r", p.price],
      ["sim-days", "sim-days-r", p.days],
    ]) {
      const n = $(numId);
      const r = $(rangeId);
      if (n) n.value = String(val);
      if (r) r.value = String(val);
    }
  }
  const hint = $("preset-hint");
  if (hint) hint.textContent = p ? tr(p.hint) : tr("s.468");
  renderSimulator();
}

function initPresets() {
  for (const k of Object.keys(PRESETS)) {
    const b = $("preset-" + k);
    if (b && b.addEventListener) b.addEventListener("click", () => applyPreset(k));
  }
  applyPreset("calm");
}

/* ------------------------------------------------------------------ *
 * where every number comes from
 * ------------------------------------------------------------------ */

function renderSources() {
  const el = $("sources-table");
  if (!el) return;
  const rows = [
    [tr("s.469"), "tokensInPool", tr("s.470")],
    [tr("s.471"), "pendingTrim", tr("s.472")],
    [tr("s.473"), "inventoryCap", tr("s.474")],
    [tr("s.475"), "capDecayTokensPerDay", tr("s.476")],
    [tr("s.477"), "totalBurned", tr("s.478")],
    [tr("s.479"), "burnClaims", tr("s.480")],
    [tr("s.481"), "backstopEthPrincipal", tr("s.482")],
    [tr("s.483"), "backstopIsFilled", tr("s.484")],
    [tr("s.485"), "burnExecutor.tokenBalance", tr("s.486")],
    [tr("s.487"), "burnExecutor.previewBridge", tr("s.488")],
    [tr("s.489"), "dripper.drippable", tr("s.490")],
    [tr("s.491"), "distributor.stakingBps", tr("s.492")],
    [tr("s.493"), "simd.totalAssets", tr("s.494")],
    [tr("s.495"), "imd.totalSupply", tr("s.496")],
    [tr("s.497"), "poolB.slot0", tr("s.498")],
    [tr("s.499"), "chainlink.latestRoundData", tr("s.500")],
    [tr("s.501"), "owner.nonce", tr("s.502")],
    [tr("s.503"), "base.fp.totalSupply", "Base"],
    [tr("s.504"), "base.fp.adapterBalance", "Base"],
    [tr("s.505"), "base.fp.receiverBalance", "Base"],
  ];
  const html = rows
    .map(([label, key, chain]) => {
      const s = SOURCES[key];
      if (!s) return "";
      const url = (s.chain === "base" ? BASE.explorer : "https://etherscan.io") + "/address/" + s.a + "#readContract";
      return (
        `<tr>` +
        `<td>${esc(label)}</td>` +
        `<td class="tiny"><code>${esc(s.f)}</code></td>` +
        `<td class="tiny"><a href="${url}" target="_blank" rel="noopener">${esc(s.a.slice(0, 10))}…${esc(s.a.slice(-6))}</a></td>` +
        `<td class="tiny muted">${esc(s.l || "—")}</td>` +
        `<td class="tiny muted">${esc(chain)}</td>` +
        `</tr>`
      );
    })
    .join("");
  el.innerHTML =
    tr("s.506", { p0: html });
  const pb = $("poolid-b");
  if (pb) pb.textContent = POOL_IDS.B;
}

/* ------------------------------------------------------------------ *
 * wiring
 * ------------------------------------------------------------------ */

function bindSlider(numId, rangeId) {
  const n = $(numId);
  const r = $(rangeId);
  if (!n || !r) return;
  r.addEventListener("input", () => {
    n.value = r.value;
    renderSimulator();
  });
  n.addEventListener("input", () => {
    const v = Math.max(Number(r.min), Math.min(Number(r.max), Number(n.value || 0)));
    r.value = String(v);
    renderSimulator();
  });
}

/* ------------------------------------------------------------------ *
 * theme — light is the shipped default; dark is a stored opt-in
 * ------------------------------------------------------------------ */

const THEME_KEY = "pool4.theme";

function isDarkTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark";
}

/** The button always names the theme it switches TO, never the current one.
 *  Guarded by has(): this runs before the locale files have loaded, and writing a raw
 *  key into the label at that moment would flash "html.theme.dark" at the reader. */
function syncThemeButton() {
  const label = $("theme-label");
  const btn = $("theme-toggle");
  const dark = isDarkTheme();
  const labelKey = dark ? "html.theme.light" : "html.theme.dark";
  if (label && hasKey(labelKey)) label.textContent = tr(labelKey);
  if (btn && btn.setAttribute) {
    const titleKey = dark ? "html.theme.toLight" : "html.theme.toDark";
    if (hasKey(titleKey)) {
      const title = tr(titleKey);
      btn.setAttribute("title", title);
      btn.setAttribute("aria-label", title);
    }
  }
}

function initTheme() {
  const btn = $("theme-toggle");
  if (btn && btn.addEventListener) {
    btn.addEventListener("click", () => {
      const next = isDarkTheme() ? "light" : "dark";
      if (next === "dark") document.documentElement.setAttribute("data-theme", "dark");
      else document.documentElement.removeAttribute("data-theme");
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch (e) {
        /* private mode: the choice just does not survive the tab */
      }
      syncThemeButton();
    });
  }
  syncThemeButton();
}

/* ------------------------------------------------------------------ *
 * collapsible groups + anchor nav
 *
 * A nav link has to OPEN the group it points into. Otherwise clicking "机制" scrolls to a
 * closed <details> and looks broken — the heading is there, the content is not. The first
 * version opened the group but let the browser do the scrolling, and the scroll was computed
 * before the newly opened content had laid out, so the group could land off-screen: the
 * reader saw a jump and no content, which reads as "nothing happened". Opening, then
 * scrolling on the next frame, is what makes the two agree.
 * ------------------------------------------------------------------ */

function initGroups() {
  const openGroupFor = (hash, flash) => {
    if (!hash || hash === "#") return null;
    let target = null;
    try {
      target = document.querySelector(hash);
    } catch (e) {
      return null; // a malformed hash is not worth throwing over
    }
    const group = target && target.closest ? target.closest("details.group") : null;
    if (!group) return null;
    group.open = true;
    if (flash && group.classList) {
      group.classList.remove("jumped");
      void group.offsetWidth; // restart the animation if it is already running
      group.classList.add("jumped");
      setTimeout(() => group.classList.remove("jumped"), 1600);
    }
    return group;
  };

  const jumpTo = (hash) => {
    const group = openGroupFor(hash, true);
    if (!group) return;
    const scroll = () => {
      try {
        group.scrollIntoView({ block: "start", behavior: "smooth" });
      } catch (e) {
        if (group.scrollIntoView) group.scrollIntoView();
      }
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(scroll);
    else scroll();
  };

  for (const a of document.querySelectorAll(".anchors a")) {
    a.addEventListener("click", (e) => {
      const href = a.getAttribute("href");
      if (!href || href.charAt(0) !== "#") return;
      // Take over from the browser: its jump fires before the opened group has laid out.
      if (e.preventDefault) e.preventDefault();
      jumpTo(href);
      try {
        history.replaceState(null, "", href);
      } catch (err) {
        /* file:// or a sandboxed frame: the URL simply keeps the old hash */
      }
    });
  }
  window.addEventListener("hashchange", () => jumpTo(location.hash));
  openGroupFor(location.hash, false);
}

/* ------------------------------------------------------------------ *
 * "text -> calldata hex" helper for the on-chain message tutorial
 *
 * The message board is a plain EOA: a message is the calldata of a zero-value transfer.
 * Wallets want that calldata as hex, and hand-converting UTF-8 to hex is exactly the step
 * that stops people. Nothing here leaves the page.
 *
 * The no-op default and the real implementation are declared near the top of the module (see
 * "hex helper handle"), not here. boot() calls hexRender() as soon as the locale files load,
 * and boot() runs long before this function would ever be reached: a `let` down here is still
 * in its temporal dead zone at that moment, so calling it from boot() threw
 * "Cannot access 'hexRender' before initialization" — replacing a wrong string with a blank
 * page, which is not a fix.
 * ------------------------------------------------------------------ */

function initHexTool() {
  const input = $("hex-input");
  const out = $("hex-out");
  const meta = $("hex-meta");
  const copy = $("hex-copy");
  if (!input || !out) return;
  const enc = typeof TextEncoder === "function" ? new TextEncoder() : null;

  hexRender = () => {
    const text = input.value || "";
    if (!text.trim() || !enc) {
      out.hidden = true;
      out.textContent = "";
      if (meta) meta.textContent = "";
      return;
    }
    const bytes = enc.encode(text);
    let hex = "0x";
    for (const b of bytes) hex += b.toString(16).padStart(2, "0");
    out.hidden = false;
    out.textContent = hex;
    if (meta) meta.textContent = tr("s.513", { p0: bytes.length, p1: hex.length - 2 });
  };

  input.addEventListener("input", () => hexRender());

  if (copy && copy.addEventListener) {
    copy.addEventListener("click", async () => {
      const hex = out.textContent || "";
      if (!hex) return;
      let ok = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(hex);
          ok = true;
        }
      } catch (e) {
        ok = false;
      }
      if (!ok) {
        // The clipboard API needs a secure context; selecting the text is the honest fallback.
        try {
          const range = document.createRange();
          range.selectNodeContents(out);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          ok = true;
        } catch (e) {
          ok = false;
        }
      }
      copy.textContent = ok ? tr("s.514") : tr("s.515");
      setTimeout(() => {
        copy.textContent = tr("html.howto.copy");
      }, 1800);
    });
  }
  /* NO hexRender() here. init() is synchronous and runs before boot() has awaited the locale
   * files, so calling it here rendered the literal key "s.513" whenever #hex-input already had
   * content — which the browser supplies on a soft refresh, a back navigation, or a form
   * restore, not just if the reader typed something. See boot(), which calls it once the
   * dictionary is loaded, and onLangChange(), which redoes it when the language changes. */
}

function init() {
  initTheme();
  initGroups();
  initHexTool();

  bindSlider("sim-inflow", "sim-inflow-r");
  bindSlider("sim-price", "sim-price-r");
  bindSlider("sim-days", "sim-days-r");
  $("sim-inflow").value = "0";
  $("sim-price").value = "0";
  $("sim-days").value = "0";
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      state.nextAt = 0;
      tick();
    }
  });
  boot().catch((e) => {
    state.lastError = String(e.message || e);
    renderRpcBanner();
  });
}

init();
