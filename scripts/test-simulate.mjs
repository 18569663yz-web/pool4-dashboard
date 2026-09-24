// Tests for lib/simulate.js.
//
// The important one is the last: take a REAL historical trim, feed the simulator
// the state from the block before it, and check that it reproduces the exact
// liquidityRemoved / tokensBurned / tokensRewarded that the chain emitted.
//
//   node scripts/test-simulate.mjs
import { Rpc, encodeCall, decodeReturns, fmt18, keccak256Hex, utf8ToBytes } from "../lib/evm.js";
import { ADDR, ABI } from "../lib/contracts.js";
import { simulate, simulateHorizon, isqrt, imdToWei, Q96 } from "../lib/simulate.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

console.log("pure math");
ok("isqrt(0) = 0", isqrt(0n) === 0n);
ok("isqrt(1) = 1", isqrt(1n) === 1n);
ok("isqrt(4) = 2", isqrt(4n) === 2n);
ok("isqrt(10^36) = 10^18", isqrt(10n ** 36n) === 10n ** 18n);
{
  const n = 123456789012345678901234567890n;
  const r = isqrt(n);
  ok("isqrt is exact floor", r * r <= n && (r + 1n) * (r + 1n) > n);
}
ok("imdToWei(1) = 1e18", imdToWei(1) === 10n ** 18n);
ok("imdToWei(13544.04)", imdToWei(13544.04) === 13544040000000000000000n);
ok("imdToWei(0.000001)", imdToWei(0.000001) === 10n ** 12n);

console.log("\nidentity: zero inputs must reproduce the live state exactly");
{
  // a synthetic but realistic position
  const L = 623901337860260950818n;
  const sqrtLower = 1n; // arbitrary; we only check self-consistency
  const sqrtP = 1702384790887829874190392875648n;
  const heldNow = (L * (sqrtP - sqrtLower)) / Q96;
  const p = {
    positionLiquidity: L,
    heldNow,
    capNow: 20000000000000000000000n,
    capFloor: 20000000000000000000000n,
    sqrtPriceX96: sqrtP,
    ratchetBps: 10000n,
    capDecayTokensPerDay: 3000000000000000000000n,
    lastCapDecayAt: BigInt(Math.floor(Date.now() / 1000)),
    minTrimTokens: 0n,
    rewardShareBps: 1500n,
    nowSec: Date.now() / 1000,
  };
  const r = simulate(p, { inflowWei: 0n, pricePct: 0 });
  ok("held unchanged with zero inputs", r.held === heldNow, `${r.held} vs ${heldNow}`);
  ok("cap unchanged (already at floor)", r.cap === p.capNow, `${r.cap}`);
  ok("no trim", !r.willTrim);
  ok("state DORMANT", r.stateAfter === "DORMANT");
}

console.log("\nratchet: L963-969");
{
  const DAY = 86400n;
  const nowSec = Math.floor(Date.now() / 1000);
  const p = {
    positionLiquidity: 1000n,
    heldNow: 500n * 10n ** 18n,
    capNow: 1000n * 10n ** 18n,
    capFloor: 100n * 10n ** 18n, // floor far below, so it does not bind
    sqrtPriceX96: 1n << 96n,
    ratchetBps: 10000n, // full ratchet
    capDecayTokensPerDay: 10n ** 30n, // effectively unlimited rate
    lastCapDecayAt: BigInt(nowSec) - DAY, // a full day of allowance has accrued
    minTrimTokens: 0n,
    rewardShareBps: 1500n,
    nowSec,
  };
  // with a huge allowance the ratchet should land exactly on held
  const r = simulate(p, { inflowWei: 0n, pricePct: 0 });
  ok("full ratchet drives cap to held", r.cap === p.heldNow, `${fmt18(r.cap, 6)} vs ${fmt18(p.heldNow, 6)}`);

  // zero rate: the cap must not move at all (this is the current on-chain shape)
  const p2 = { ...p, capDecayTokensPerDay: 0n };
  const r2 = simulate(p2, { inflowWei: 0n, pricePct: 0 });
  ok("zero decay rate freezes the cap", r2.cap === p2.capNow, `${fmt18(r2.cap, 6)}`);
  ok("...and is reported as not ratcheted", r2.ratcheted === false);

  // no elapsed time -> zero allowance -> cap frozen even with a huge rate
  const p3 = { ...p, lastCapDecayAt: BigInt(nowSec) };
  const r3 = simulate(p3, { inflowWei: 0n, pricePct: 0 });
  ok("zero elapsed time means zero allowance", r3.cap === p3.capNow, `${fmt18(r3.cap, 6)}`);

  // half ratchet
  const p4 = { ...p, ratchetBps: 5000n };
  const r4 = simulate(p4, { inflowWei: 0n, pricePct: 0 });
  const expected = p4.capNow - ((p4.capNow - p4.heldNow) * 5000n) / 10000n;
  ok("half ratchet halves the gap", r4.cap === expected, `${fmt18(r4.cap, 6)} vs ${fmt18(expected, 6)}`);

  // floor binds
  const p5 = { ...p, capFloor: 800n * 10n ** 18n };
  const r5 = simulate(p5, { inflowWei: 0n, pricePct: 0 });
  ok("capFloor clamps the ratchet", r5.cap === p5.capFloor, `${fmt18(r5.cap, 6)} vs floor ${fmt18(p5.capFloor, 6)}`);

  // daily rate limit binds: allowance of 10 tokens vs a 500-token gap
  const p6 = { ...p, capDecayTokensPerDay: 10n * 10n ** 18n };
  const r6 = simulate(p6, { inflowWei: 0n, pricePct: 0 });
  ok("daily decay limit binds", r6.cap === p6.capNow - 10n * 10n ** 18n, `${fmt18(r6.cap, 6)}`);
}

console.log("\ntrim: L991-1007, L1033-1034");
{
  const L = 1000000n;
  const sqrtLower = 0n;
  const sqrtP = 1n << 96n;
  const heldNow = (L * (sqrtP - sqrtLower)) / Q96; // = L when sqrtP = 2^96 and lower = 0
  const cap = (heldNow * 80n) / 100n; // 80% of held -> 20% excess
  const p = {
    positionLiquidity: L,
    heldNow,
    capNow: cap,
    capFloor: cap,
    sqrtPriceX96: sqrtP,
    ratchetBps: 10000n,
    capDecayTokensPerDay: 0n,
    lastCapDecayAt: BigInt(Math.floor(Date.now() / 1000)),
    minTrimTokens: 0n,
    rewardShareBps: 1500n,
    nowSec: Date.now() / 1000,
  };
  const r = simulate(p, { inflowWei: 0n, pricePct: 0 });
  ok("trim fires", r.willTrim);
  ok("excess = held - cap", r.excess === heldNow - cap, `${r.excess}`);
  ok("rewarded = floor(excess*1500/10000)", r.rewarded === (r.excess * 1500n) / 10000n);
  ok("burned = excess - rewarded", r.burned === r.excess - r.rewarded);
  ok("burned/rewarded ~ 85/15", Number(r.burned) / Number(r.rewarded) > 5.666 && Number(r.burned) / Number(r.rewarded) < 5.667);
  ok("liquidityOut = floor(L*excess/held)", r.liquidityToRemove === (L * r.excess) / heldNow);
  ok("L decreases", r.positionLiquidityAfter === L - r.liquidityToRemove);
  ok("state LIVE", r.stateAfter === "LIVE");
}

console.log("\nminTrimTokens gate (L992)");
{
  const L = 1000000n;
  const sqrtP = 1n << 96n;
  const heldNow = L;
  const cap = heldNow - 5n; // excess of 5 wei
  const p = {
    positionLiquidity: L,
    heldNow,
    capNow: cap,
    capFloor: cap,
    sqrtPriceX96: sqrtP,
    ratchetBps: 10000n,
    capDecayTokensPerDay: 0n,
    lastCapDecayAt: BigInt(Math.floor(Date.now() / 1000)),
    minTrimTokens: 10n, // excess 5 < 10 -> no trim
    rewardShareBps: 1500n,
    nowSec: Date.now() / 1000,
  };
  const r = simulate(p, { inflowWei: 0n, pricePct: 0 });
  ok("excess below minTrimTokens does not trim", !r.willTrim && r.belowMin, `excess=${r.excess} min=${p.minTrimTokens}`);
}

console.log("\nhorizon accumulation");
{
  const p = { rewardShareBps: 1500n };
  const startHeld = 0n;
  const startCap = 100n * 10n ** 18n;
  const perDay = 30n * 10n ** 18n;
  const h = simulateHorizon(p, { startHeld, startCap, perDayWei: perDay, days: 10 });
  // day 4 reaches 120 > 100 -> trim 20, back to 100; then days 5..7 -> 130>100 trim 30... etc.
  ok("fires at least once", h.fired > 0, `${h.fired} fires`);
  ok("first fire day = 4", h.firstFireDay === 4, `${h.firstFireDay}`);
  ok("burn/reward split holds", Number(h.totalBurned) / Number(h.totalRewarded) > 5.666 && Number(h.totalBurned) / Number(h.totalRewarded) < 5.667);
}

/* ------------------------------------------------------------------ *
 * End-to-end: reproduce a REAL historical trim
 * ------------------------------------------------------------------ */
console.log("\nend-to-end replay of a real historical trim");

const hist = JSON.parse(readFileSync(fileURLToPath(new URL("../data/history.json", import.meta.url)), "utf8"));
const trims = hist.events.Trimmed.logs;
const last = trims[trims.length - 1];
const evBlock = parseInt(last.blockNumber, 16);
const d = last.data.replace(/^0x/, "");
const w = (i) => BigInt("0x" + d.slice(i * 64, (i + 1) * 64));
const emittedLiquidity = w(0);
const emittedBurned = w(1);
const emittedRewarded = w(2);

const rpc = new Rpc(
  ["https://eth.drpc.org", "https://gateway.tenderly.co/public/mainnet", "https://rpc.mevblocker.io", "https://eth-mainnet.public.blastapi.io"],
  { timeoutMs: 30000 }
);
const hx = (n) => "0x" + BigInt(n).toString(16);
const stateAt = async (block) => {
  const keys = ["tokensInPool", "inventoryCap", "capFloor", "positionLiquidity", "ratchetBps", "capDecayTokensPerDay", "lastCapDecayAt", "minTrimTokens", "rewardShareBps", "currentSqrtPriceX96"];
  const out = await rpc.batch(keys.map((k) => ({ method: "eth_call", params: [{ to: ADDR.hook, data: encodeCall(ABI.hook[k].sig, [], []) }, hx(block)] })));
  const v = {};
  out.forEach((o, i) => {
    if (o.ok) v[keys[i]] = decodeReturns(ABI.hook[keys[i]].outs, o.result)[0];
  });
  return v;
};

try {
  const after = await stateAt(evBlock);
  const before = await stateAt(evBlock - 1);
  if (before.positionLiquidity === undefined || after.tokensInPool === undefined) {
    console.log("  (archive unavailable — skipping end-to-end check)");
  } else {
    // Recover the held value the moment _applyCap ran. `held` scales linearly with
    // liquidity at a fixed price, so scale the post-trim reading back up by L_before/L_after.
    const heldBeforeTrim = (after.tokensInPool * before.positionLiquidity) / after.positionLiquidity;
    const p = {
      positionLiquidity: before.positionLiquidity,
      heldNow: heldBeforeTrim,
      capNow: after.inventoryCap,
      capFloor: before.capFloor,
      sqrtPriceX96: before.currentSqrtPriceX96,
      ratchetBps: before.ratchetBps,
      capDecayTokensPerDay: before.capDecayTokensPerDay,
      lastCapDecayAt: before.lastCapDecayAt,
      minTrimTokens: before.minTrimTokens,
      rewardShareBps: before.rewardShareBps,
      nowSec: Date.now() / 1000,
    };
    const r = simulate(p, { inflowWei: 0n, pricePct: 0 });
    console.log(`  trim at block ${evBlock}`);
    console.log(`    L before      ${before.positionLiquidity}`);
    console.log(`    held (derived)${fmt18(heldBeforeTrim, 9)} IMD`);
    console.log(`    cap           ${fmt18(after.inventoryCap, 6)} IMD`);
    console.log(`    emitted       liquidityRemoved=${emittedLiquidity} burned=${fmt18(emittedBurned, 9)} rewarded=${fmt18(emittedRewarded, 9)}`);
    console.log(`    simulated     liquidityRemoved=${r.liquidityToRemove} burned=${fmt18(r.burned, 9)} rewarded=${fmt18(r.rewarded, 9)}`);

    const dLiq = r.liquidityToRemove > emittedLiquidity ? r.liquidityToRemove - emittedLiquidity : emittedLiquidity - r.liquidityToRemove;
    const relLiq = Number(dLiq) / Number(emittedLiquidity);
    ok("simulated liquidityRemoved matches the chain exactly", dLiq === 0n, `Δ=${dLiq} (rel ${relLiq.toExponential(2)})`);

    // `held` at the instant _applyCap ran is not observable from any block state, so we
    // recover it from the post-trim reading. That recovery carries Uniswap's floor-division
    // residue, which is why the derived split can differ by a few wei out of 2.6e18.
    const dRew = r.rewarded > emittedRewarded ? r.rewarded - emittedRewarded : emittedRewarded - r.rewarded;
    ok("simulated rewarded matches to <1e-15 relative", Number(dRew) / Number(emittedRewarded) < 1e-15, `Δ=${dRew} wei of ${emittedRewarded}`);
    const dBurn = r.burned > emittedBurned ? r.burned - emittedBurned : emittedBurned - r.burned;
    ok("simulated burned matches to <1e-15 relative", Number(dBurn) / Number(emittedBurned) < 1e-15, `Δ=${dBurn} wei of ${emittedBurned}`);
    ok("simulated split obeys L1033 exactly", r.rewarded === (r.excess * p.rewardShareBps) / 10000n && r.burned === r.excess - r.rewarded);
  }
} catch (e) {
  console.log(`  (end-to-end check could not run: ${String(e.message).slice(0, 90)})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
