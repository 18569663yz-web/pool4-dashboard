// Build the small static data files the dashboard loads at boot.
// Everything here is a snapshot; the live numbers come from eth_call in the browser.
//
//   node scripts/build-data.mjs
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { Rpc, encodeCall, decodeReturns, fmt18, fmtUnits, keccak256Hex, utf8ToBytes } from "../lib/evm.js";
import { ADDR, POOL_IDS } from "../lib/contracts.js";
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
for (const name of ["MarketOpened", "CapFloorUpdated", "CapDecayUpdated", "FeesWithdrawn", "ClaimsSettled", "FeeCollected", "DeploymentFloorUpdated"]) {
  const ls = hist.events[name] && hist.events[name].logs;
  if (ls && ls.length) {
    wanted.add(parseInt(ls[0].blockNumber, 16));
    wanted.add(parseInt(ls[ls.length - 1].blockNumber, 16));
  }
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
let baseSummary = null;
if (!SKIP_BASE) {
console.log("\nbuilding base.json…");
const bs = async (address, topic0, extra = "") => {
  if (fixture) return fixture.baseLogs || [];
  const url = `https://base.blockscout.com/api?module=logs&action=getLogs&fromBlock=1&toBlock=latest&address=${address}${topic0 ? "&topic0=" + topic0 : ""}${extra}`;
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    const j = await r.json();
    if (j.status === "1") return j.result;
    if (j.message === "No logs found") return [];
    await sleep(3000 * (i + 1));
  }
  return [];
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
const l1head = fixture ? fixture.l1Head : await l1.blockNumber();
const bridgeLogs = [];
if (fixture) {
  bridgeLogs.push(...(fixture.l1BridgeLogs || []));
} else {
  for (let from = 25800000; from <= l1head; from += 1000) {
    const to = Math.min(from + 999, l1head);
    try {
      const res = await l1.call("eth_getLogs", [{ address: ADDR.burnExecutor, topics: [BRIDGE_TOPIC], fromBlock: hx(from), toBlock: hx(to) }]);
      bridgeLogs.push(...res);
    } catch {}
    await sleep(40);
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
