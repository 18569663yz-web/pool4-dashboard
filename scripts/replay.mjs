// Replay real historical trims against the source-level model.
//
// For each historical Trimmed event we read the PRE-trim state with a historical
// eth_call (archive), then check that the Solidity formulas reproduce the emitted
// numbers exactly. No fitting, no fudging: if a formula is wrong, this prints a mismatch.
//
//   node scripts/replay.mjs [n]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { Rpc, encodeCall, decodeReturns, fmt18, keccak256Hex, utf8ToBytes } from "../lib/evm.js";
import { ADDR, ABI, POOL_IDS } from "../lib/contracts.js";

// Public RPCs that serve historical state without a token.
const ARCHIVE = [
  "https://eth.drpc.org",
  "https://gateway.tenderly.co/public/mainnet",
  "https://eth-mainnet.public.blastapi.io",
  "https://rpc.mevblocker.io",
  "https://eth-pokt.nodies.app",
];
const rpc = new Rpc(ARCHIVE, { timeoutMs: 30000 });

const db = JSON.parse(readFileSync(new URL("../data/history.json", import.meta.url), "utf8"));
const trims = db.events.Trimmed.logs;
if (!trims.length) throw new Error("no Trimmed events in data/history.json");

const hx = (n) => "0x" + BigInt(n).toString(16);
const decodeLog = (l) => {
  const d = l.data.replace(/^0x/, "");
  const w = (i) => BigInt("0x" + d.slice(i * 64, (i + 1) * 64));
  return {
    block: parseInt(l.blockNumber, 16),
    tx: l.transactionHash,
    liquidityRemoved: w(0),
    tokensBurned: w(1),
    tokensRewarded: w(2),
    ethRetained: w(3),
  };
};

const HOOK_CALLS = {
  tokensInPool: "tokensInPool()",
  ethInPool: "ethInPool()",
  inventoryCap: "inventoryCap()",
  capFloor: "capFloor()",
  positionLiquidity: "positionLiquidity()",
  rewardShareBps: "rewardShareBps()",
  ratchetBps: "ratchetBps()",
  capDecayTokensPerDay: "capDecayTokensPerDay()",
  lastCapDecayAt: "lastCapDecayAt()",
  capDecayRemainder: "capDecayRemainder()",
  currentTick: "currentTick()",
};

/** Read a set of hook views at an explicit historical block. */
async function stateAt(block) {
  const keys = Object.keys(HOOK_CALLS);
  const reqs = keys.map((k) => ({
    method: "eth_call",
    params: [{ to: ADDR.hook, data: encodeCall(HOOK_CALLS[k]) }, hx(block)],
  }));
  const out = await rpc.batch(reqs);
  const v = {};
  const errs = {};
  out.forEach((r, i) => {
    if (!r.ok) {
      errs[keys[i]] = r.error;
      return;
    }
    v[keys[i]] = decodeReturns(ABI.hook[keys[i]].outs, r.result)[0];
  });
  const h = await rpc.getBlock(hx(block));
  v.timestamp = Number(BigInt(h.timestamp));
  v.block = block;
  return { v, errs };
}

const N = Math.min(Number(process.argv[2] || 3), trims.length);
const picks = [...trims.slice(-N)].reverse(); // newest first

let allOk = true;
const check = (label, ok, detail) => {
  if (!ok) allOk = false;
  console.log(`    ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "   " + detail : ""}`);
};

console.log(`Replaying the last ${N} of ${trims.length} Trimmed events against CappedBurnHook.sol\n`);

for (const raw of picks) {
  const e = decodeLog(raw);
  const tokensRemoved = e.tokensBurned + e.tokensRewarded;
  console.log(`── trim @ block ${e.block}  tx ${e.tx}`);
  console.log(`   event: liquidityRemoved=${e.liquidityRemoved}  burned=${fmt18(e.tokensBurned, 6)}  rewarded=${fmt18(e.tokensRewarded, 6)}  ethRetained=${fmt18(e.ethRetained, 8)}`);

  const before = await stateAt(e.block - 1);
  const after = await stateAt(e.block);
  if (Object.keys(before.errs).length) console.log("   (pre-state errors: " + JSON.stringify(before.errs) + ")");

  const b = before.v;
  const a = after.v;
  console.log(`   pre  #${e.block - 1}: tokensInPool=${fmt18(b.tokensInPool, 6)}  cap=${fmt18(b.inventoryCap, 6)}  L=${b.positionLiquidity}  tick=${b.currentTick}`);
  console.log(`   post #${e.block}: tokensInPool=${fmt18(a.tokensInPool, 6)}  cap=${fmt18(a.inventoryCap, 6)}  L=${a.positionLiquidity}  tick=${a.currentTick}`);

  // (1) _disperse, L1033-1034
  const expRewarded = (tokensRemoved * b.rewardShareBps) / 10000n;
  const expBurned = tokensRemoved - expRewarded;
  check(
    "L1033-1034 _disperse split",
    expRewarded === e.tokensRewarded && expBurned === e.tokensBurned,
    `expected burned=${expBurned} rewarded=${expRewarded}`
  );

  // (2) positionLiquidity -= liquidityToRemove, L1001
  check(
    "L1001 positionLiquidity -= liquidityRemoved",
    a.positionLiquidity === b.positionLiquidity - e.liquidityRemoved,
    `${b.positionLiquidity} - ${e.liquidityRemoved} = ${a.positionLiquidity}`
  );

  // (3) the trim removes exactly the excess above the cap (L991 excess, L997 proportional withdrawal).
  //     `held` at the moment _applyCap runs is not observable from any block state (it is mid-swap),
  //     so we recover it from the post-trim state: tokensInPool scales linearly with liquidity at a
  //     fixed price, so held_before = tokensInPool_after * L_before / L_after.
  //     The comparison therefore carries the Uniswap getAmount1Delta floor-division residue; we assert
  //     agreement to 1e-4 relative, which is far tighter than any economically meaningful quantity.
  const heldBeforeTrim = (a.tokensInPool * b.positionLiquidity) / a.positionLiquidity;
  const excessImplied = heldBeforeTrim - a.inventoryCap;
  const relErr = Number((tokensRemoved > excessImplied ? tokensRemoved - excessImplied : excessImplied - tokensRemoved) * 10n ** 12n / (excessImplied || 1n)) / 1e12;
  check(
    "L991-997 trim removes exactly the excess above cap",
    relErr < 1e-4,
    `excess=${fmt18(excessImplied, 9)}  removed=${fmt18(tokensRemoved, 9)}  rel.err=${relErr.toExponential(2)}`
  );
  const liquidityPredicted = (b.positionLiquidity * excessImplied) / heldBeforeTrim;
  console.log(
    `         L997 check: floor(L*excess/held) = ${liquidityPredicted}, emitted = ${e.liquidityRemoved}, Δ = ${e.liquidityRemoved - liquidityPredicted} wei (floor residue)`
  );

  // (4) the cap did not move during a trim (only the ratchet branch writes it)
  check("L960 branch: cap unchanged by a trim", a.inventoryCap === b.inventoryCap, `${fmt18(b.inventoryCap, 6)} -> ${fmt18(a.inventoryCap, 6)}`);

  // (5) post-trim inventory sits at (or just above) the cap — the "rounds in the pool's favour" residue, L995-996
  const residue = a.tokensInPool - a.inventoryCap;
  check(
    "L994-1001 post-trim inventory ~= cap",
    residue >= 0n && residue < 10n ** 12n,
    `residue = ${residue} wei (${fmt18(residue, 12)} IMD)`
  );

  // (6) ignition distance was ~0 immediately before: the pre-block gap must have been small
  const gapBefore = b.inventoryCap > b.tokensInPool ? b.inventoryCap - b.tokensInPool : 0n;
  console.log(`   ignition gap one block earlier = ${fmt18(gapBefore, 6)} IMD  (price moved in the trim block)`);
  console.log("");
}

// ---- cumulative reconciliation against live on-chain totals ----
// totalBurned/totalRewarded are fed by TWO paths, both calling _disperse():
//   L1004  a trim        -> Trimmed event
//   L741   a backstop settle -> BackstopSettled event
// So the identity is  totalBurned == Σ Trimmed.burned + Σ BackstopSettled.burned.
console.log("── cumulative reconciliation over ALL " + trims.length + " trims ──");
let sumBurn = 0n;
let sumReward = 0n;
let sumEth = 0n;
let sumLiq = 0n;
for (const raw of trims) {
  const e = decodeLog(raw);
  sumBurn += e.tokensBurned;
  sumReward += e.tokensRewarded;
  sumEth += e.ethRetained;
  sumLiq += e.liquidityRemoved;
}
console.log(`   Σ Trimmed.tokensBurned   = ${fmt18(sumBurn, 6)} IMD`);
console.log(`   Σ Trimmed.tokensRewarded = ${fmt18(sumReward, 6)} IMD`);
console.log(`   Σ Trimmed.ethRetained    = ${fmt18(sumEth, 8)} ETH`);
console.log(`   Σ liquidityRemoved       = ${sumLiq}`);
console.log(`   burn/reward across trims = ${(Number(sumBurn) / Number(sumReward)).toFixed(6)}   (85/15 = 5.666667)`);
console.log(
  `   NOTE: Σrewarded/Σtotal floors to ${Number((sumReward * 10000n) / (sumBurn + sumReward))} bps, not 1500 — each trim floors its own\n` +
    `         division (L1033), so the aggregate sits just under the configured 1500 bps. Per-trim splits are exactly 1500.`
);

const settles = db.events.BackstopSettled.logs;
let setBurn = 0n;
let setReward = 0n;
for (const l of settles) {
  const d = l.data.replace(/^0x/, "");
  const w = (i) => BigInt("0x" + d.slice(i * 64, (i + 1) * 64));
  setBurn += w(1);
  setReward += w(2);
}
console.log(`\n   Σ BackstopSettled.tokensBurned   = ${fmt18(setBurn, 6)} IMD   (${settles.length} settles)`);
console.log(`   Σ BackstopSettled.tokensRewarded = ${fmt18(setReward, 6)} IMD`);

const live = await rpc.batch([
  { method: "eth_call", params: [{ to: ADDR.hook, data: encodeCall("totalBurned()") }, "latest"] },
  { method: "eth_call", params: [{ to: ADDR.hook, data: encodeCall("totalRewarded()") }, "latest"] },
]);
const liveBurned = decodeReturns(["uint256"], live[0].result)[0];
const liveRewarded = decodeReturns(["uint256"], live[1].result)[0];
console.log(`\n   live totalBurned()   = ${fmt18(liveBurned, 6)} IMD`);
console.log(`   live totalRewarded() = ${fmt18(liveRewarded, 6)} IMD`);
check(
  "Σ(Trimmed + BackstopSettled).burned == totalBurned()",
  sumBurn + setBurn === liveBurned,
  `Δ = ${liveBurned - sumBurn - setBurn} wei`
);
check(
  "Σ(Trimmed + BackstopSettled).rewarded == totalRewarded()",
  sumReward + setReward === liveRewarded,
  `Δ = ${liveRewarded - sumReward - setReward} wei`
);
check(
  "combined burn/reward == 85/15",
  Number(sumBurn + setBurn) / Number(sumReward + setReward) > 5.6666 && Number(sumBurn + setBurn) / Number(sumReward + setReward) < 5.6667,
  `${(Number(sumBurn + setBurn) / Number(sumReward + setReward)).toFixed(6)}`
);

// ---- the burn pipeline: did the burnSink actually forward them? ----
const sink = ADDR.burnExecutor;
const sinkCalls = await rpc.batch([
  { method: "eth_call", params: [{ to: ADDR.imd, data: encodeCall("balanceOf(address)", ["address"], [sink]) }, "latest"] },
  { method: "eth_call", params: [{ to: ADDR.hook, data: encodeCall("burnClaims()") }, "latest"] },
]);
const sinkBal = decodeReturns(["uint256"], sinkCalls[0].result)[0];
const burnClaims = decodeReturns(["uint256"], sinkCalls[1].result)[0];
console.log(`\n── burn pipeline ──`);
console.log(`   hook.burnClaims (unsettled)  = ${fmt18(burnClaims, 6)} IMD`);
console.log(`   BurnExecutor IMD balance     = ${fmt18(sinkBal, 6)} IMD`);
console.log(`   ⇒ settled to sink, still un-bridged = ${fmt18(sinkBal, 6)} IMD of ${fmt18(sumBurn, 6)} IMD burned-by-accounting`);

console.log(`\n${allOk ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}`);

// ---- when did each mechanism stop? ----
const head = db.head;
const last = (name) => {
  const l = db.events[name] && db.events[name].logs;
  return l && l.length ? parseInt(l[l.length - 1].blockNumber, 16) : null;
};
console.log("\n── last activity per mechanism (head = " + head + ") ──");
const rows = [
  ["MarketOpened", "market opened"],
  ["Trimmed", "a trim (85/15 burn)"],
  ["CapRatcheted", "the cap ratcheted down"],
  ["BackstopSettled", "backstop settled (2nd burn path)"],
  ["Rebalanced", "keeper rebalanced the backstop"],
  ["ClaimsSettled", "claims settled to sink/recipient"],
  ["FeesWithdrawn", "owner withdrew LP fees"],
  ["FeeCollected", "a swap paid the 1% LP fee"],
  ["DeploymentFloorUpdated", "placement floor moved"],
];
for (const [name, label] of rows) {
  const b = last(name);
  const e = db.events[name];
  if (b === null) {
    console.log(`   ${label.padEnd(36)} never`);
    continue;
  }
  const age = head - b;
  console.log(`   ${label.padEnd(36)} block ${b}  (${age} blocks ago ≈ ${(age * 12 / 86400).toFixed(1)} d)  n=${e.count}`);
}

// ---- inventory decay since the last trim: the "ignition distance" opening up ----
const lastTrim = last("Trimmed");
if (lastTrim) {
  console.log("\n── tokensInPool since the last trim (archive eth_call) ──");
  const samples = [];
  const steps = 10;
  for (let i = 0; i <= steps; i++) samples.push(lastTrim + Math.round(((head - lastTrim) * i) / steps));
  for (const blk of samples) {
    try {
      const out = await rpc.batch([
        { method: "eth_call", params: [{ to: ADDR.hook, data: encodeCall("tokensInPool()") }, hx(blk)] },
        { method: "eth_call", params: [{ to: ADDR.hook, data: encodeCall("inventoryCap()") }, hx(blk)] },
      ]);
      const held = out[0].ok ? decodeReturns(["uint256"], out[0].result)[0] : null;
      const cap = out[1].ok ? decodeReturns(["uint256"], out[1].result)[0] : null;
      if (held === null || cap === null) {
        console.log(`   #${blk}  (archive miss)`);
        continue;
      }
      const gap = cap > held ? cap - held : 0n;
      const bar = "█".repeat(Math.min(40, Math.round(Number(gap / 10n ** 17n) / 40)));
      console.log(`   #${blk}  held=${fmt18(held, 4).padStart(12)}  cap=${fmt18(cap, 2).padStart(10)}  gap=${fmt18(gap, 4).padStart(11)}  ${bar}`);
    } catch (e) {
      console.log(`   #${blk}  ERR ${String(e.message).slice(0, 60)}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}
process.exit(allOk ? 0 : 1);
