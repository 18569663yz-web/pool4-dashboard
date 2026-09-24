// State-machine assertions.
//
// The dashboard's headline must flip the moment the engine can burn again. That
// decision lives in derive() (lib/contracts.js), so it is testable without a DOM
// or a fork: feed it synthetic readings and check the resulting state.
//
// The rule under test (mirrors CappedBurnHook.sol L960 / L991-992):
//   LIVE      pendingTrim > 0  OR  held > cap
//   CRITICAL  held <= cap  AND  cap > capFloor
//   DORMANT   held <= cap  AND  cap == capFloor
//
//   node scripts/test-state-machine.mjs
import { derive } from "../lib/contracts.js";

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

const E18 = 10n ** 18n;
const imd = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

/** Minimal value bag — only what derive() reads. */
function bag({ held, cap, floor, pendingTrim = null, minTrim = 0n }) {
  return {
    "hook.tokensInPool": held,
    "hook.inventoryCap": cap,
    "hook.capFloor": floor,
    "hook.pendingTrim": pendingTrim === null ? (held > cap ? held - cap : 0n) : pendingTrim,
    "hook.minTrimTokens": minTrim,
    "hook.ethInPool": imd(30),
    "hook.positionLiquidity": 623901337860260950818n,
    "hook.currentSqrtPriceX96": 1702384790887829874190392875648n,
    "hook.ratchetBps": 10000n,
    "hook.capDecayTokensPerDay": imd(3000),
    "hook.rewardShareBps": 1500n,
    "hook.totalBurned": imd(29254),
    "hook.totalRewarded": imd(5162),
    "hook.backstopIsFilled": false,
    "hook.refTick": 61338n,
    "hook.deploymentFloorTick": 65022n,
    "hook.marketOpen": true,
    "poolA.slot0": [1707542338713754910313909781016n, 61412n, 0n, 10000n],
    "poolB.slot0": [1702384790887829874190392875648n, 61352n, 0n, 10000n],
    "poolA.liquidity": 7402136912466800636019n,
    "poolB.liquidity": 623901337860260950818n,
    "chainlink.latestRoundData": [1n, 276247410382n, 0n, 1790123603n, 1n],
    "chainlink.decimals": 8n,
    "simd.totalAssets": imd(1617000),
    "simd.totalSupply": 204155741096000000000000000n,
    "simd.decimals": 24n,
    "imd.totalSupply": imd(3748422),
    "hook.pendingRebalance": false,
    "hook.rebalanceEthThreshold": imd(0.1),
    "hook.keeperReward": imd(0.002),
    "hook.backstopEthPrincipal": imd(25),
    "hook.backstopConvertedEth": 0n,
    "hook.backstopFillThreshold": imd(0.1),
    "hook.retainedEth": imd(0.078),
    "hook.burnSink": "0xe29386719c155b6847ad5a4e97c6674f10ffc750",
    "hook.rewardsRecipient": "0x9046739e1535b40efbe6ab3f45d0024b690eca30",
    "burnExecutor.tokenBalance": imd(20.26),
    "burnExecutor.previewBridge": [imd(20.26), imd(20.26), 10n ** 14n],
    "burnExecutor.baseBurnReceiver": "0xf9d7cbf5bef2f5c9ba93a70f31ddca6457716793",
    "burnExecutor.oft": "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7",
    "dripper.drippable": 0n,
    "dripper.dripRatePerSecond": 11574074074074074n,
    "dripper.maxCatchupSeconds": 3600n,
    "dripper.lastDripAt": 1790000000n,
    "dripper.minDripAmount": imd(1),
    "dripper.canDrip": false,
    "dripper.vault": "0x9efa934d9fad4ae28c998a40195646b965a97247",
    "distributor.heldBonding": imd(2065),
    "distributor.heldNft": imd(1548.75),
    "distributor.stakingEarned": imd(1548.75),
    "distributor.bondingEarned": imd(2065),
    "distributor.nftEarned": imd(1548.75),
    "distributor.stakingBps": 3000n,
    "distributor.bondingBps": 4000n,
    "distributor.nftBps": 3000n,
    "simd.paused": false,
    "owner.nonce": 2578,
    "bal.imd.dripper": 0n,
    "bal.imd.distributor": imd(3613.76),
    "bal.imd.hook": 0n,
    "bal.imd.burnExecutor": imd(20.26),
    "bal.eth.hook": imd(0.078),
    "bal.eth.owner": imd(0.12),
  };
}

const FLOOR = imd(20000);

console.log("the current on-chain shape (cap pinned at the floor, inventory below it)");
{
  const d = derive(bag({ held: imd(13405), cap: FLOOR, floor: FLOOR }));
  ok("state is DORMANT", d.state === "DORMANT", d.state);
  ok("pendingTrim is 0", d.pendingTrim === 0n);
  ok("gap is cap - held", d.gapRaw === FLOOR - imd(13405), `${d.gapRaw}`);
}

console.log("\nthe engine is one wei over the cap -> must be LIVE");
{
  const d = derive(bag({ held: FLOOR + 1n, cap: FLOOR, floor: FLOOR }));
  ok("state flips to LIVE", d.state === "LIVE", d.state);
  ok("pendingTrim is positive", d.pendingTrim > 0n, `${d.pendingTrim}`);
  ok("pendingTrim equals the excess", d.pendingTrim === 1n, `${d.pendingTrim}`);
}

console.log("\nheld exactly at the cap -> nothing to burn, but the ratchet is pinned");
{
  const d = derive(bag({ held: FLOOR, cap: FLOOR, floor: FLOOR }));
  ok("state is DORMANT (excess == 0)", d.state === "DORMANT", d.state);
  ok("pendingTrim is 0", d.pendingTrim === 0n);
}

console.log("\npendingTrim > 0 while held <= cap (minTrimTokens edge) -> must still be LIVE");
{
  // contrived: the authoritative view says there is something to burn
  const d = derive(bag({ held: imd(19999), cap: FLOOR, floor: FLOOR, pendingTrim: 1n }));
  ok("pendingTrim alone forces LIVE", d.state === "LIVE", d.state);
}

console.log("\ncap above the floor -> CRITICAL, because the ratchet can still move");
{
  const d = derive(bag({ held: imd(13405), cap: imd(30000), floor: FLOOR }));
  ok("state is CRITICAL", d.state === "CRITICAL", d.state);
  ok("ratchetAtFloor is false", d.ratchetAtFloor === false);
}

console.log("\nthe flip a capFloor change would cause");
{
  // dev raises capFloor above the inventory -> the cap is dragged up, but held is still below it
  const raised = derive(bag({ held: imd(13405), cap: imd(30000), floor: imd(30000) }));
  ok("raising capFloor keeps it DORMANT (nothing to burn yet)", raised.state === "DORMANT", raised.state);
  ok("gap grows to the new cap", raised.gapRaw === imd(30000) - imd(13405), `${raised.gapRaw}`);
  // dev lowers capFloor below the inventory -> immediately burnable
  const lowered = derive(bag({ held: imd(13405), cap: imd(13000), floor: imd(13000) }));
  ok("lowering the cap below the inventory flips to LIVE", lowered.state === "LIVE", lowered.state);
  ok("pendingTrim is the excess", lowered.pendingTrim === imd(405), `${lowered.pendingTrim}`);
}

console.log("\nburn/reward split of the pending amount");
{
  const d = derive(bag({ held: FLOOR + imd(1000), cap: FLOOR, floor: FLOOR }));
  ok("pendingBurn + pendingReward == pendingTrim", d.pendingBurn + d.pendingReward === d.pendingTrim);
  ok("reward is 15%", d.pendingReward === (d.pendingTrim * 1500n) / 10000n, `${d.pendingReward}`);
}

console.log("\nmissing readings must not be silently treated as zero");
{
  const b = bag({ held: imd(13405), cap: FLOOR, floor: FLOOR });
  delete b["hook.tokensInPool"];
  delete b["hook.inventoryCap"];
  const d = derive(b);
  // derive falls back to 0n for absent keys, which is exactly why the UI must show
  // "取不到" instead of trusting derived numbers when `errors` is non-empty.
  ok("derive falls back to 0 when a reading is absent (UI must guard)", d.held === 0n && d.cap === 0n, `held=${d.held} cap=${d.cap}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
