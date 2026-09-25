// Build the small static data files the dashboard loads at boot.
// Everything here is a snapshot; the live numbers come from eth_call in the browser.
//
//   node scripts/build-data.mjs
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { Rpc, encodeCall, decodeReturns, fmt18, fmtUnits, keccak256Hex, utf8ToBytes } from "../lib/evm.js";
import { ADDR, POOL_IDS } from "../lib/contracts.js";
import { scanLogWindows } from "../lib/log-scan.js";
import { outPath, stagedPath } from "../lib/snapshot-out.js";

const DATA = new URL("../data/", import.meta.url);
mkdirSync(DATA, { recursive: true });
const SKIP_BASE = process.argv.includes("--skip-base");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hx = (n) => "0x" + BigInt(n).toString(16);

/**
 * Offline mode for tests: `--base-fixture <path>` (or POOL4_BASE_FIXTURE) replaces every
 * network call with data from a file.
 *
 * This exists because of a bug that only CI could see: the summary referenced
 * `bridgeBlocks`, which is declared inside the Base section, so the script threw
 * ReferenceError on every run that did NOT pass --skip-base — i.e. every CI run — while
 * local runs passed --skip-base (Blockscout is unreachable here under node) and never
 * executed the line. Tests that cannot reach a branch cannot protect it; the fixture makes
 * that branch reachable offline.
 */
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const FIXTURE_PATH = argOf("--base-fixture", process.env.POOL4_BASE_FIXTURE || "");
const fixture = FIXTURE_PATH ? JSON.parse(readFileSync(FIXTURE_PATH, "utf8").replace(/^\uFEFF/, "")) : null;
if (fixture) console.log(`fixture mode: ${FIXTURE_PATH} — no chain access\n`);

const l1 = new Rpc(undefined, { timeoutMs: 30000 });
const base = new Rpc(
  ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org", "https://base.meowrpc.com"],
  { timeoutMs: 25000 }
);

/** L1 block timestamps for a list of block numbers — batched, or read from the fixture. */
async function l1BlockTimes(blockList) {
  const out = {};
  if (fixture) {
    for (const b of blockList) {
      const v = fixture.l1BlockTimestamps?.[b];
      if (v !== undefined) out[b] = v;
    }
    return out;
  }
  for (let i = 0; i < blockList.length; i += 50) {
    const chunk = blockList.slice(i, i + 50);
    const res = await l1.batch(chunk.map((b) => ({ method: "eth_getBlockByNumber", params: [hx(b), false] })));
    res.forEach((o, k) => {
      if (o.ok && o.result) out[chunk[k]] = Number(BigInt(o.result.timestamp));
    });
    await sleep(60);
  }
  return out;
}

const BASE_IMD_ADAPTER = "0xab152db8aac047b6757ffcf495ffe88d7712690a";
const BASE_FP = "0xff0c532fdb8cd566ae169c1cb157ff2bdc83e105";
const BASE_BURN_RECEIVER = "0xf9d7cbf5bef2f5c9ba93a70f31ddca6457716793";

/* ------------------------------------------------------------------ *
 * 1. timeline: trims + milestone events, with real timestamps
 * ------------------------------------------------------------------ */
console.log("building timeline…");
// The index THIS RUN produced, not the committed one — see stagedPath() for the failure
// that made the distinction matter. The line below is also the observability hook: a run
// that reads the wrong index now says so in its own log.
const HIST_PATH = stagedPath("history.json");
const hist = JSON.parse(readFileSync(HIST_PATH, "utf8"));
console.log(`  index: ${HIST_PATH}`);
console.log(`  scanTo ${hist.scanTo}, head ${hist.head}, ${hist.totalLogs} logs indexed`);
const decodeTrim = (l) => {
  const d = l.data.replace(/^0x/, "");
  const w = (i) => BigInt("0x" + d.slice(i * 64, (i + 1) * 64));
  return { b: parseInt(l.blockNumber, 16), burned: w(1).toString(), rewarded: w(2).toString(), eth: w(3).toString(), tx: l.transactionHash };
};

const trims = hist.events.Trimmed.logs.map(decodeTrim);
const settles = hist.events.BackstopSettled.logs.map((l) => {
  const d = l.data.replace(/^0x/, "");
  const w = (i) => BigInt("0x" + d.slice(i * 64, (i + 1) * 64));
  return { b: parseInt(l.blockNumber, 16), burned: w(1).toString(), rewarded: w(2).toString() };
});

// timestamps for the blocks we care about (dedup, batched)
const wanted = new Set();
for (const t of trims) wanted.add(t.b);
for (const s of settles) wanted.add(s.b);
/* EVERY block of a milestone type, not just its first and last.
 *
 * These blocks feed two different consumers with different shapes, and the mismatch is what
 * produced `"t": null` in timeline.json:
 *
 *   - `wanted` (below) was built from the ENDPOINTS of each type, on the assumption that only
 *     the first and last occurrence are ever displayed.
 *   - `milestones` (:108-118) iterates EVERY log of the type and renders each one, taking its
 *     timestamp from `ts[m.b]` (:132).
 *
 * So an event in the middle of a type was rendered but never queried, `ts[b]` came back
 * undefined, and `|| null` recorded it as if the chain had no timestamp for that block. It did:
 * blocks 25892082 / 25950882 / 25972798 all resolve fine — the build simply never asked. The
 * bug is invisible in the endpoint types and reappears whenever a new interior event lands, so
 * it recurred on every CI run.
 *
 * Cost is bounded by the milestone types, which are small (11 logs across all four). The types
 * with thousands of logs (DeploymentFloorUpdated 3275, CapRatcheted 1989, FeeCollected 4491) are
 * not rendered as milestones, so they stay on the endpoint-only path — adding every log of every
 * type would take this from 11 blocks to ~11k for no benefit. The two lists below are
 * deliberately different: endpoints for the types we only ever show the ends of, and the full
 * log set for the types we render in full. */
const MILESTONE_TYPES = ["MarketOpened", "CapFloorUpdated", "CapDecayUpdated", "FeesWithdrawn"];
const MILESTONE_ALL_TYPES = ["ClaimsSettled", "FeeCollected", "DeploymentFloorUpdated"];
const addAllLogs = (name) => {
  const ls = hist.events[name] && hist.events[name].logs;
  if (!ls) return;
  for (const l of ls) wanted.add(parseInt(l.blockNumber, 16));
};
const addEndpointLogs = (name) => {
  const ls = hist.events[name] && hist.events[name].logs;
  if (!ls || !ls.length) return;
  wanted.add(parseInt(ls[0].blockNumber, 16));
  wanted.add(parseInt(ls[ls.length - 1].blockNumber, 16));
};
for (const name of MILESTONE_TYPES) addAllLogs(name);
for (const name of MILESTONE_ALL_TYPES) addEndpointLogs(name);
/* `timeline.last[...]` is a third consumer of `ts`, and it was the one still uncovered.
 *
 * renderTimeline() renders `t.last[name]` for nine event types, but the lists above cover only
 * seven of them — CapRatcheted and Rebalanced appear in neither. So `last.CapRatcheted` pointed
 * at a block the build never queried and its row rendered as "— · —（— 天前）". This is the same
 * bug as the milestones, one consumer further along; it surfaced live during verification
 * (block 26049191) rather than being found by reading.
 *
 * Resolving only `t.last[name]` — one block per type, not every log — is what makes this
 * affordable: 3275 and 1989-log types would be thousands of RPC calls otherwise, and only their
 * newest occurrence is ever displayed. */
const LAST_RENDERED_TYPES = [
  "MarketOpened", "Trimmed", "CapRatcheted", "BackstopSettled", "Rebalanced",
  "ClaimsSettled", "FeesWithdrawn", "FeeCollected", "DeploymentFloorUpdated",
];
for (const name of LAST_RENDERED_TYPES) {
  const ls = hist.events[name] && hist.events[name].logs;
  if (ls && ls.length) wanted.add(parseInt(ls[ls.length - 1].blockNumber, 16));
}
const blocks = [...wanted].sort((a, b) => a - b);
console.log(`  resolving ${blocks.length} block timestamps…`);
const ts = await l1BlockTimes(blocks);
console.log(`  got ${Object.keys(ts).length} timestamps`);

const milestones = [];
for (const [name, label] of [
  ["MarketOpened", "市场开盘（inventoryCap 冻结）"],
  ["CapFloorUpdated", "owner 修改 capFloor"],
  ["CapDecayUpdated", "owner 修改 capDecayTokensPerDay"],
  ["FeesWithdrawn", "owner 提取 LP 费"],
]) {
  const ls = hist.events[name] && hist.events[name].logs;
  if (!ls) continue;
  for (const l of ls) milestones.push({ name, label, b: parseInt(l.blockNumber, 16), tx: l.transactionHash });
}

const lastOf = (name) => {
  const ls = hist.events[name] && hist.events[name].logs;
  return ls && ls.length ? parseInt(ls[ls.length - 1].blockNumber, 16) : null;
};

const timeline = {
  builtAt: new Date().toISOString(),
  scannedTo: hist.head,
  scannedFrom: hist.scanFrom,
  totalLogs: hist.totalLogs,
  blockTime: ts,
  trims: trims.map((t) => ({ ...t, t: ts[t.b] || null })),
  backstopSettles: settles.map((s) => ({ ...s, t: ts[s.b] || null })),
  milestones: milestones.map((m) => ({ ...m, t: ts[m.b] || null })),
  last: {
    MarketOpened: lastOf("MarketOpened"),
    Trimmed: lastOf("Trimmed"),
    CapRatcheted: lastOf("CapRatcheted"),
    BackstopSettled: lastOf("BackstopSettled"),
    Rebalanced: lastOf("Rebalanced"),
    ClaimsSettled: lastOf("ClaimsSettled"),
    FeesWithdrawn: lastOf("FeesWithdrawn"),
    FeeCollected: lastOf("FeeCollected"),
    DeploymentFloorUpdated: lastOf("DeploymentFloorUpdated"),
  },
  counts: Object.fromEntries(Object.entries(hist.events).map(([k, v]) => [k, v.count])),
};
writeFileSync(outPath("timeline.json"), JSON.stringify(timeline));
console.log(`  wrote data/timeline.json (${(JSON.stringify(timeline).length / 1024).toFixed(0)} KB)`);

/* ------------------------------------------------------------------ *
 * 2. base side: the second door
 *
 * `--skip-base` skips this section entirely. base.blockscout.com is unreachable from
 * some networks (it times out under node while the same URL answers from PowerShell on
 * the same machine), and a refresh that publishes a fresh timeline.json is still worth
 * more than no refresh at all. The previously built base.json stays in place, and the
 * page raises its staleness banner if the gap passes three hours.
 *
 * The refresh job does NOT skip this by default — on GitHub's runners the endpoint is
 * reachable, and a gap there should be visible rather than silently tolerated.
 * ------------------------------------------------------------------ */
/**
 * What the Base section wants to say afterwards, in one object.
 *
 * `bridgeBlocks` / `burnBlocks` / `baseState` are declared *inside* the block below, so the
 * summary further down cannot see them. An earlier version referenced `bridgeBlocks` from
 * outside that block and threw `ReferenceError: bridgeBlocks is not defined` on CI — and
 * only on CI, because local runs passed --skip-base (Blockscout is unreachable from this
 * machine under node), which made the whole block, including the failing line, unreachable.
 * Publishing a result instead of reaching for the internals removes the trap.
 */
/**
 * Base fetches start the error approach: bounded attempts, then success or a throw.
 *
 * Without it, one stalled Blockscout connection has no ceiling at all — `fetch()` alone can
 * hand back a socket that never answers, and the section would hang forever instead of
 * reaching the try/catch below.
 */
async function fetchJson(url, timeoutMs = 30_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: ac.signal });
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

let baseSummary = null;
if (!SKIP_BASE) {
console.log("\nbuilding base.json…");
try {
/**
 * POOL4_BASE_FAIL=1 makes the Base half fail on purpose, in the one place the try/catch can
 * see: inside the section, after the timeline has been built and written. It is the fault
 * injection scripts/test-base-isolation.mjs uses to prove that (a) the new behaviour keeps
 * timeline.json and exits 0, and (b) the old behaviour, with POOL4_BASE_ISOLATION=0, destroys
 * it. Neither variable is set by the refresh job or the workflow.
 */
if (process.env.POOL4_BASE_FAIL === "1") throw new Error("POOL4_BASE_FAIL=1 — deliberate Base failure (fault injection)");
const bs = async (address, topic0, extra = "") => {
  if (fixture) return fixture.baseLogs || [];
  const url = `https://base.blockscout.com/api?module=logs&action=getLogs&fromBlock=1&toBlock=latest&address=${address}${topic0 ? "&topic0=" + topic0 : ""}${extra}`;
  let lastMessage = "no response";
  for (let i = 0; i < 4; i++) {
    const j = await fetchJson(url);
    if (j.status === "1") return j.result;
    /* "No logs found" is a real answer — an address that has emitted nothing. Anything else,
     * after four attempts, is a failure, and `return []` for it would publish an empty burn
     * list that is indistinguishable from a chain with no burns. verify-snapshots.mjs would
     * catch it as "burn count did not shrink", which reads like history rather than an
     * outage — the same confusion as the L1 scan above (HANDOFF #17). */
    if (j.message === "No logs found") return [];
    lastMessage = `${j.message || "unexpected response"}${j.result ? " — " + String(j.result).slice(0, 80) : ""}`;
    await sleep(3000 * (i + 1));
  }
  throw new Error(`Blockscout never answered for ${address}: ${lastMessage}`);
};

// BaseBurnReceiver (verified on Base, solc 0.8.26) emits:
//   event BurnExecuted(address indexed caller, address indexed token);
//   function burn() { IBaseBurnableToken(token).burn(balanceOf(address(this))); emit BurnExecuted(msg.sender, token); }
// Note it carries NO amount — the amount only shows up as a falling totalSupply.
const BURN_TOPIC = keccak256Hex(utf8ToBytes("BurnExecuted(address,address)"));
const burns = await bs(BASE_BURN_RECEIVER, BURN_TOPIC);
console.log(`  Base BurnExecuted() events: ${burns.length}`);
const burnBlocks = [...new Set(burns.map((b) => parseInt(b.blockNumber, 16)))].sort((a, b) => a - b);
// Blockscout returns timeStamp inline; only fall back to RPC if it is missing.
const baseTs = {};
for (const l of burns) {
  const b = parseInt(l.blockNumber, 16);
  if (l.timeStamp) baseTs[b] = parseInt(l.timeStamp, 16);
}
const missing = burnBlocks.filter((b) => baseTs[b] === undefined);
if (missing.length && fixture) {
  for (const b of missing) {
    const v = fixture.baseBlockTimestamps?.[b];
    if (v !== undefined) baseTs[b] = v;
  }
} else if (missing.length) {
  for (let i = 0; i < missing.length; i += 40) {
    const chunk = missing.slice(i, i + 40);
    const out = await base.batch(chunk.map((b) => ({ method: "eth_getBlockByNumber", params: [hx(b), false] })));
    out.forEach((o, k) => {
      if (o.ok && o.result) baseTs[chunk[k]] = Number(BigInt(o.result.timestamp));
    });
    await sleep(80);
  }
}

// L1 bridge events
const BRIDGE_TOPIC = keccak256Hex(utf8ToBytes("TokensBridgedForBurn(address,uint32,bytes32,uint256,uint256,bytes32)"));
// The highest head, not the first endpoint to answer: a lagging node would shorten the range
// and silently drop the newest bridges. Same reasoning as index-logs.mjs.
const l1head = fixture ? fixture.l1Head : (await l1.highestBlockNumber()).n;
let bridgeLogs = [];
if (fixture) {
  bridgeLogs = [...(fixture.l1BridgeLogs || [])];
} else {
  /* 247 windows is 247 chances for a public endpoint to throttle one of them. The scan used
   * to swallow that in `catch {}`, so a dropped window surfaced only as verify-snapshots.mjs
   * reporting one fewer bridge than the previous run — indistinguishable from a chain event. */
  const scan = await scanLogWindows({
    from: 25800000,
    to: l1head,
    fetchWindow: (from, to) =>
      l1.call("eth_getLogs", [{ address: ADDR.burnExecutor, topics: [BRIDGE_TOPIC], fromBlock: hx(from), toBlock: hx(to) }]),
    sleep,
  });
  bridgeLogs = scan.logs;
  if (scan.retries) console.log(`  L1 scan: ${scan.retries} retries over ${scan.windows} windows`);
  if (scan.failures.length) {
    console.error(`  ${scan.failures.length} of ${scan.windows} L1 windows never answered:`);
    for (const f of scan.failures.slice(0, 8)) console.error(`    ${f.from}..${f.to}  ${f.error}`);
    if (scan.failures.length > 8) console.error(`    … and ${scan.failures.length - 8} more`);
    /* Publishing a base.json that is missing bridge events is worse than publishing nothing:
     * the page states the bridge count as a fact, and a quiet 62 → 61 reads as history. */
    throw new Error(`L1 bridge scan incomplete (${scan.failures.length}/${scan.windows} windows failed)`);
  }
}
console.log(`  L1 TokensBridgedForBurn events: ${bridgeLogs.length}`);
const bridgeBlocks = [...new Set(bridgeLogs.map((b) => parseInt(b.blockNumber, 16)))].sort((a, b) => a - b);
const l1Ts = await l1BlockTimes(bridgeBlocks);

// live Base reads
const baseRead = async (to, sig, types = [], outs = ["uint256"], args = []) => {
  if (fixture) {
    // The fixture stores decoded values, keyed by the call that produces them.
    const key = sig === "balanceOf(address)" ? (to === BASE_IMD_ADAPTER ? "adapterBalance()" : "receiverBalance()") : sig;
    const v = fixture.baseReads?.[key];
    if (v === undefined) throw new Error(`fixture has no value for ${key}`);
    return v;
  }
  return decodeReturns(outs, await base.ethCall(to, encodeCall(sig, types, args)))[0];
};
const fpDecimals = Number(await baseRead(BASE_FP, "decimals()", [], ["uint8"]));
const baseState = {
  chainId: 8453,
  head: fixture ? fixture.baseHead : await base.blockNumber(),
  token: BASE_FP,
  tokenName: await baseRead(BASE_FP, "name()", [], ["string"]),
  tokenSymbol: await baseRead(BASE_FP, "symbol()", [], ["string"]),
  tokenDecimals: fpDecimals,
  tokenTotalSupply: (await baseRead(BASE_FP, "totalSupply()")).toString(),
  adapter: BASE_IMD_ADAPTER,
  adapterBalance: (await baseRead(BASE_FP, "balanceOf(address)", ["address"], ["uint256"], [BASE_IMD_ADAPTER])).toString(),
  receiver: BASE_BURN_RECEIVER,
  receiverBalance: (await baseRead(BASE_FP, "balanceOf(address)", ["address"], ["uint256"], [BASE_BURN_RECEIVER])).toString(),
  sourceDefaultReceiver: "0x4b118f0c63d09f09cb35fc6e8024a6c96493eada",
};

const baseJson = {
  builtAt: new Date().toISOString(),
  state: baseState,
  burnReceiverSource: "verified on Base, solc 0.8.26 — event BurnExecuted(address indexed caller, address indexed token), no amount",
  burns: burns
    .map((b) => ({
      b: parseInt(b.blockNumber, 16),
      t: baseTs[parseInt(b.blockNumber, 16)] || null,
      caller: "0x" + (b.topics[1] || "").slice(26),
      tx: b.transactionHash,
    }))
    .sort((a, b) => a.b - b.b),
  bridges: bridgeLogs.map((b) => ({ b: parseInt(b.blockNumber, 16), t: l1Ts[parseInt(b.blockNumber, 16)] || null, tx: b.transactionHash })),
  poolIds: POOL_IDS,
};
writeFileSync(outPath("base.json"), JSON.stringify(baseJson));
console.log(`  wrote data/base.json (${(JSON.stringify(baseJson).length / 1024).toFixed(0)} KB)`);

const callers = new Map();
for (const b of baseJson.burns) callers.set(b.caller, (callers.get(b.caller) || 0) + 1);
console.log(`  burn callers: ${[...callers.entries()].map(([a, n]) => `${a}×${n}`).join(", ")}`);

// Everything the summary needs, in a value that outlives this block. Note it carries the
// *values* the summary prints, not the maps they came from: l1Ts and baseTs are declared
// here too, and reaching for them from outside is exactly the bug being fixed.
baseSummary = {
  lastBridge: bridgeBlocks[bridgeBlocks.length - 1],
  lastBurn: burnBlocks[burnBlocks.length - 1],
  bridgeTime: l1Ts[bridgeBlocks[bridgeBlocks.length - 1]],
  burnTime: baseTs[burnBlocks[burnBlocks.length - 1]],
  fpDecimals,
  totalSupply: baseState.tokenTotalSupply,
  adapterBalance: baseState.adapterBalance,
};
} catch (e) {
  /* POOL4_BASE_ISOLATION=0 restores the pre-fix behaviour (the exception escapes and takes
   * timeline.json with it). It exists so scripts/test-base-isolation.mjs can show that its
   * assertions are capable of failing — HANDOFF #13. Nothing in the refresh job sets it. */
  if (process.env.POOL4_BASE_ISOLATION === "0") throw e;
  /* The Base half failed. Say so loudly — and then keep the half that succeeded.
   *
   * This is the fix for the outage that took the refresh chain down for six hours: base.json
   * threw (Blockscout unreachable), the exception left the process, and timeline.json — built
   * minutes earlier, written to the staging directory, and about to be verified — was
   * discarded with it. The refresh job would have degraded on its own: base.json is an
   * `optionalOutputs` entry, so its absence only leaves the published copy in place and the
   * page's staleness banner starts counting. That path never got the chance to run.
   *
   * So base.json is simply not written, the exit code stays 0, and timeline.json is promoted
   * as usual. The published base.json keeps its old contents and the banner rises on its own,
   * because the file that stops moving is now the oldest snapshot. A failure being *visible*
   * is the point — this is not a licence to publish unverified data: the staging →
   * verify → promote gate is untouched, and `timeline.json` only reaches data/ by passing it.
   */
  console.error("\n" + "!".repeat(72));
  console.error(`!! base.json was NOT built — ${e && e.message ? e.message : e}`);
  console.error("!! data/base.json keeps its previous contents; it is now the oldest snapshot,");
  console.error("!! so the page's staleness banner will say so. timeline.json is unaffected.");
  console.error("!".repeat(72) + "\n");
}
} // end of the Base section (see --skip-base above)

console.log("\nsummary:");
// A missing timestamp must not take the whole script down — the summary is diagnostics,
// and the artifacts above are already written. (It used to throw RangeError here.)
const at = (t) => (t ? new Date(t * 1000).toISOString() : "time unavailable");
console.log(`  last L1 trim       block ${timeline.last.Trimmed}  ${at(ts[timeline.last.Trimmed])}`);
if (baseSummary) {
console.log(`  last L1 bridge     block ${baseSummary.lastBridge}  ${at(baseSummary.bridgeTime)}`);
console.log(`  last Base burn     block ${baseSummary.lastBurn}  ${at(baseSummary.burnTime)}`);
console.log(`  Base FP totalSupply ${fmtUnits(BigInt(baseSummary.totalSupply), baseSummary.fpDecimals, 4)}`);
console.log(`  adapter FP balance  ${fmtUnits(BigInt(baseSummary.adapterBalance), baseSummary.fpDecimals, 4)}`);
} else {
console.log("  Base section skipped (--skip-base): base.json keeps its previous contents");
}
