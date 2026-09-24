// Snapshot the whole dashboard state into data/baseline.json.
// Read-only: eth_call + eth_getBlockByNumber + eth_getTransactionCount only.
//
//   node scripts/collect.mjs [rpcUrl ...]
import { writeFileSync, mkdirSync } from "node:fs";
import { Rpc, DEFAULT_RPCS, fmt18, fmtUnits, toNum } from "../lib/evm.js";
import { collect, ADDR, POOL_IDS } from "../lib/contracts.js";
import { outPath } from "../lib/snapshot-out.js";

const extra = process.argv.slice(2).filter((a) => a.startsWith("http"));
const rpc = new Rpc(extra.length ? extra.concat(DEFAULT_RPCS) : DEFAULT_RPCS, { timeoutMs: 25000 });

const t0 = Date.now();
const snap = await collect(rpc, { onProgress: (m) => console.log("  · " + m) });
snap.rpcs = rpc.health;
snap.poolIds = POOL_IDS;

mkdirSync(new URL("../data/", import.meta.url), { recursive: true });

// bigints are not JSON-serialisable; store decimal strings.
const ser = (obj) =>
  JSON.parse(
    JSON.stringify(obj, (k, val) => {
      if (typeof val === "bigint") return val.toString();
      return val;
    })
  );
writeFileSync(outPath("baseline.json"), JSON.stringify(ser(snap), null, 2));

const v = snap.values;
const d = snap.derived;

console.log(`\nblock ${snap.blockNumber}  (${new Date(snap.blockTimestamp * 1000).toISOString()})  via ${snap.endpoint}`);
console.log(`fetched in ${Date.now() - t0} ms, ${Object.keys(snap.errors).length} call errors`);

const row = (k, val) => console.log(`  ${String(k).padEnd(34)} ${val}`);

console.log("\n── cap / inventory ──────────────────────────────────────────");
row("inventoryCap", fmt18(v["hook.inventoryCap"], 6) + " IMD");
row("capFloor", fmt18(v["hook.capFloor"], 6) + " IMD");
row("tokensInPool (held)", fmt18(v["hook.tokensInPool"], 6) + " IMD");
row("pendingTrim()  [authoritative]", fmt18(v["hook.pendingTrim"], 6) + " IMD");
row("ignition gap (cap - held)", fmt18(d.gapRaw, 6) + " IMD");
row("ethInPool", fmt18(v["hook.ethInPool"], 6) + " ETH");
row("totalBurned", fmt18(v["hook.totalBurned"], 6) + " IMD");
row("totalRewarded", fmt18(v["hook.totalRewarded"], 6) + " IMD");
row("burn/reward ratio", d.burnRatio === null ? "n/a" : d.burnRatio.toFixed(4) + "  (85/15 = 5.6667)");
row("ratchetBps", v["hook.ratchetBps"].toString());
row("capDecayTokensPerDay", v["hook.capDecayTokensPerDay"].toString());
row("rewardShareBps", v["hook.rewardShareBps"].toString());
row("minTrimTokens", v["hook.minTrimTokens"].toString());
row("state", d.state);

console.log("\n── price / value ────────────────────────────────────────────");
row("pool A sqrtPriceX96", v["poolA.slot0"][0].toString());
row("pool A tick", v["poolA.slot0"][1].toString());
row("pool A liquidity", v["poolA.liquidity"].toString());
row("pool A ETH per IMD", fmt18(d.priceA.ethPerImd, 12));
row("pool B sqrtPriceX96", v["poolB.slot0"][0].toString());
row("pool B tick", v["poolB.slot0"][1].toString());
row("pool B liquidity", v["poolB.liquidity"].toString());
row("pool B ETH per IMD", fmt18(d.priceB.ethPerImd, 12));
row("ETH/USD (Chainlink)", fmt18(d.ethUsd, 2));
row("ignition gap in ETH", fmt18(d.gapEth, 6));
row("ignition gap in USD", fmt18(d.gapUsd, 2));

console.log("\n── if a trim fired right now (85/15) ────────────────────────");
row("pendingTrim", fmt18(d.pendingTrim, 6) + " IMD");
row("→ burn (85%)", fmt18(d.pendingBurn, 6) + " IMD");
row("→ rewards (15%)", fmt18(d.pendingReward, 6) + " IMD");

console.log("\n── backstop / reference ─────────────────────────────────────");
row("backstop lower/upper tick", `${v["hook.backstop"][0]} / ${v["hook.backstop"][1]}`);
row("backstop liquidity", v["hook.backstop"][2].toString());
row("backstopEthPrincipal", fmt18(v["hook.backstopEthPrincipal"], 6) + " ETH");
row("backstopConvertedEth", fmt18(v["hook.backstopConvertedEth"], 6) + " ETH");
row("backstopIsFilled", String(v["hook.backstopIsFilled"]));
row("refTick", v["hook.refTick"].toString());
row("deploymentFloorTick", v["hook.deploymentFloorTick"].toString());
row("pendingRebalance", String(v["hook.pendingRebalance"]));
row("retainedEth", fmt18(v["hook.retainedEth"], 6) + " ETH");

console.log("\n── reward flow ──────────────────────────────────────────────");
row("RewardDripper.drippable()", fmt18(v["dripper.drippable"], 6) + " IMD");
row("dripper IMD balance", fmt18(v["bal.imd.dripper"], 6) + " IMD");
row("dripRatePerSecond", v["dripper.dripRatePerSecond"].toString() + "  (" + fmt18(v["dripper.dripRatePerSecond"] * 86400n, 4) + " IMD/day)");
row("minDripAmount", fmt18(v["dripper.minDripAmount"], 6));
row("canDrip", String(v["dripper.canDrip"]));
row("distributor heldBonding", fmt18(v["distributor.heldBonding"], 6) + " IMD");
row("distributor heldNft", fmt18(v["distributor.heldNft"], 6) + " IMD");
row("distributor IMD balance", fmt18(v["bal.imd.distributor"], 6) + " IMD");
row("stakingEarned", fmt18(v["distributor.stakingEarned"], 6));
row("bondingEarned", fmt18(v["distributor.bondingEarned"], 6));
row("nftEarned", fmt18(v["distributor.nftEarned"], 6));

console.log("\n── burn pipeline (hook -> BurnExecutor -> Base) ─────────────");
row("burnSink", v["hook.burnSink"]);
row("rewardsRecipient", v["hook.rewardsRecipient"]);
row("burnClaims (unsettled)", fmt18(v["hook.burnClaims"], 6) + " IMD");
row("rewardClaims (unsettled)", fmt18(v["hook.rewardClaims"], 6) + " IMD");
row("BurnExecutor.tokenBalance", fmt18(v["burnExecutor.tokenBalance"], 6) + " IMD");
row("previewBridge → send", fmt18(d.bridgeAmountToSend, 6) + " IMD");
row("previewBridge → receive", fmt18(d.bridgeMinReceive, 6) + " IMD");
row("previewBridge → native fee", fmt18(d.bridgeNativeFee, 8) + " ETH");
row("baseBurnReceiver", v["burnExecutor.baseBurnReceiver"]);

console.log("\n── sIMD ─────────────────────────────────────────────────────");
row("totalAssets", fmt18(d.totalAssets, 6) + " IMD");
row("totalSupply", fmtUnits(d.totalSupply, d.simdDecimals, 6) + " sIMD");
row("decimals", String(d.simdDecimals));
row("IMD per sIMD (book ratio)", fmt18(d.simdRate, 6));
row("vault share of IMD supply", (Number(d.simdShareOfSupply) / 100).toFixed(2) + "%");
row("paused", String(v["simd.paused"]));

console.log("\n── governance ───────────────────────────────────────────────");
row("owner", ADDR.owner);
row("owner tx nonce", String(v["owner.nonce"]));
row("owner ETH", fmt18(v["bal.eth.owner"], 4));
row("hook ETH balance", fmt18(v["bal.eth.hook"], 6));
row("hook IMD balance", fmt18(v["bal.imd.hook"], 6));
row("totalFeeEth (withdrawable)", fmt18(v["hook.totalFeeEth"], 6) + " ETH");
row("totalFeeToken", fmt18(v["hook.totalFeeToken"], 6) + " IMD");

if (Object.keys(snap.errors).length) {
  console.log("\n── call errors ──────────────────────────────────────────────");
  for (const [k, e] of Object.entries(snap.errors)) console.log(`  ${k}: ${e}`);
}
console.log("\nwrote data/baseline.json");
