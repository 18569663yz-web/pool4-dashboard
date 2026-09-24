// Self-contained historical log index for the POOL4 hook.
//
// Free RPCs cap eth_getLogs windows (publicnode 403 on wide ranges, drpc 400,
// pokt 50 blocks, 1rpc 50 blocks) — but tenderly / mevblocker / blastapi serve
// ~1000-block windows. We walk the whole life of the contract in 1000-block
// chunks with adaptive shrinking and endpoint rotation, so no indexer or API key
// is needed.
//
//   node scripts/index-logs.mjs [--from=N] [--force]
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { Rpc, keccak256Hex, utf8ToBytes, rpcEndpoints } from "../lib/evm.js";
import { ADDR } from "../lib/contracts.js";
import { outPath } from "../lib/snapshot-out.js";
import { mergeEventIndex, resumePoint, classifyHead, nextScanTo, logBlock } from "../lib/log-index.js";

// Input and output are separate paths on purpose: --out-dir redirects where the index is
// written (so the refresh job can validate it first), while the incremental scan still
// starts from the index the site currently ships.
const PREV = new URL("../data/history.json", import.meta.url);
const OUT = outPath("history.json");
mkdirSync(new URL("../data/", import.meta.url), { recursive: true });

const WINDOW_RPCS = [
  "https://gateway.tenderly.co/public/mainnet",
  "https://rpc.mevblocker.io",
  "https://eth-mainnet.public.blastapi.io",
  "https://ethereum-rpc.publicnode.com",
  "https://eth-pokt.nodies.app",
];

const TOPICS = {
  PoolInitialized: "PoolInitialized(uint160,int24)",
  MarketOpened: "MarketOpened(uint128,uint256,uint256)",
  InventoryFunded: "InventoryFunded(uint128,uint256,uint256,uint256)",
  CapRatcheted: "CapRatcheted(uint256,uint256)",
  Trimmed: "Trimmed(uint128,uint256,uint256,uint256)",
  BackstopDeployed: "BackstopDeployed(int24,int24,uint128,uint256)",
  BackstopSettled: "BackstopSettled(uint128,uint256,uint256,uint256)",
  ClaimsSettled: "ClaimsSettled(uint256,uint256,uint256)",
  Rebalanced: "Rebalanced(int24)",
  RebalanceConfigUpdated: "RebalanceConfigUpdated(bool,uint256)",
  KeeperRewardUpdated: "KeeperRewardUpdated(uint256)",
  KeeperRewardPaid: "KeeperRewardPaid(address,uint256)",
  MaxRefStepUpdated: "MaxRefStepUpdated(int24)",
  DeploymentFloorUpdated: "DeploymentFloorUpdated(int24,int24)",
  FloorDecayUpdated: "FloorDecayUpdated(uint256)",
  CapFloorUpdated: "CapFloorUpdated(uint256,uint256)",
  CapDecayUpdated: "CapDecayUpdated(uint256)",
  RatchetUpdated: "RatchetUpdated(uint256,uint256)",
  BurnSinkUpdated: "BurnSinkUpdated(address,address)",
  RewardsRecipientUpdated: "RewardsRecipientUpdated(address,address)",
  RewardShareUpdated: "RewardShareUpdated(uint256,uint256)",
  RetainedEthWithdrawn: "RetainedEthWithdrawn(address,uint256)",
  FeesWithdrawn: "FeesWithdrawn(address,uint256,uint256)",
  FeeCollected: "FeeCollected(uint256,uint256)",
  MarketClosed: "MarketClosed(address,uint256,uint256)",
};
const TOPIC0 = Object.fromEntries(Object.entries(TOPICS).map(([k, s]) => [k, keccak256Hex(utf8ToBytes(s))]));
const BY_TOPIC = Object.fromEntries(Object.entries(TOPIC0).map(([k, v]) => [v, k]));

const pool = new Rpc(rpcEndpoints(WINDOW_RPCS), { timeoutMs: 30000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hx = (n) => "0x" + Number(n).toString(16);

async function getLogs(from, to, attempt = 0) {
  const span = to - from + 1;
  try {
    const res = await pool.call("eth_getLogs", [{ address: ADDR.hook, fromBlock: hx(from), toBlock: hx(to) }]);
    return { logs: res };
  } catch (e) {
    const msg = String(e.message);
    // Too wide / rate limited: split, or back off.
    if (/rate|429|too many/i.test(msg) && attempt < 4) {
      await sleep(1200 * (attempt + 1));
      return getLogs(from, to, attempt + 1);
    }
    if (span <= 10) return { logs: [], error: msg };
    const mid = from + Math.floor(span / 2) - 1;
    const a = await getLogs(from, mid, 0);
    await sleep(120);
    const b = await getLogs(mid + 1, to, 0);
    return { logs: [...(a.logs || []), ...(b.logs || [])], error: a.error || b.error };
  }
}

const args = process.argv.slice(2);
const force = args.includes("--force");
const fromArg = args.find((a) => a.startsWith("--from="));

let db = { address: ADDR.hook, events: {} };
if (!force) {
  try {
    db = JSON.parse(readFileSync(PREV, "utf8"));
  } catch {}
}

/* Incremental by design — see lib/log-index.js for the merge rules and their boundaries.
 *
 * `scanFrom` is the floor of the whole index (just before MarketOpened) and never moves;
 * the resume point is the previous `scanTo` minus a reorg margin. Everything this scan does
 * not cover is carried over, which is why `totalLogs` counts the merged index rather than
 * this run's windows (the page quotes it as "the whole lifecycle"). */
const FLOOR = 25887000; // just before MarketOpened
const RESCAN_MARGIN = 200;
const prevEvents = db.events || {};
const prevScanTo = Number(db.scanTo) || 0;

// Ask every endpoint and take the highest head: `blockNumber()` returns whichever node
// answers first, and a lagging one would silently define how far back we scan.
const headInfo = await pool.highestBlockNumber();
const head = headInfo.n;
console.log(`head block ${head} from ${headInfo.url}`);
if (headInfo.endpoints > 1) {
  console.log(`  ${headInfo.endpoints} endpoints answered; spread ${headInfo.spread} block(s) between the highest and the lowest`);
}
if (headInfo.spread > RESCAN_MARGIN) {
  console.log(`  note: that spread is larger than the ${RESCAN_MARGIN}-block rescan margin — a lagging endpoint would have cost us real range`);
}

// A head behind the indexed height is not lag beyond the tolerance: it is the wrong chain,
// a broken endpoint or a corrupt index. Rewriting history with a shorter one is the worst
// possible response, so stop instead.
const headClass = classifyHead({ head, prevScanTo, tolerance: RESCAN_MARGIN });
if (headClass === "behind") {
  console.error(
    `\nrefusing to update the index: head ${head} is ${prevScanTo - head} blocks BEHIND the indexed height ${prevScanTo}`
  );
  console.error("endpoint lag is a few blocks; this is a different chain, a broken endpoint or a corrupt index.");
  console.error("data/history.json was not touched.");
  process.exit(1);
}
if (headClass === "lagging") {
  console.warn(`note: head ${head} is ${prevScanTo - head} blocks behind the indexed height ${prevScanTo} — endpoint lag; the index keeps its previous height`);
}

const start = fromArg
  ? Number(fromArg.slice(7))
  : resumePoint({ prevScanTo, floor: FLOOR, margin: RESCAN_MARGIN, force: !!force });
console.log(
  prevScanTo && !fromArg
    ? `resuming at block ${start} (previous index reached ${prevScanTo}; re-reading ${RESCAN_MARGIN} blocks for reorg safety)`
    : `starting a full scan at block ${start}`
);
console.log(`scanning blocks ${start}..${head} in 1000-block windows`);

const all = [];
let done = 0;
const total = Math.ceil((head - start + 1) / 1000);
const t0 = Date.now();
for (let from = start; from <= head; from += 1000) {
  const to = Math.min(from + 999, head);
  const { logs, error } = await getLogs(from, to);
  if (error) console.log(`  window ${from}..${to} partial: ${error.slice(0, 80)}`);
  all.push(...logs);
  done++;
  if (done % 20 === 0 || done === total) {
    const eta = ((Date.now() - t0) / done) * (total - done);
    console.log(`  ${done}/${total} windows, ${all.length} logs, eta ${(eta / 1000).toFixed(0)}s`);
  }
  await sleep(60);
}

// Merge: fresh windows plus everything this scan did not cover. The boundary rule lives in
// lib/log-index.js — including the case where `head < start` (the loop above does not run at
// all) and a naive `block < start` test would drop the whole previous range.
const { events, carried, unknown, indexedLogs } = mergeEventIndex({
  topic0ByName: TOPIC0,
  signatures: TOPICS,
  nameByTopic: (t) => BY_TOPIC[t],
  prevEvents,
  freshLogs: all,
  start,
  head,
});

// The index may not move backwards, even when the head is momentarily lower.
const scanTo = nextScanTo(head, prevScanTo);
db = {
  address: ADDR.hook,
  head,
  scanFrom: FLOOR,
  scanTo,
  fetchedAt: new Date().toISOString(),
  totalLogs: indexedLogs,
  scannedLogs: all.length,
  carriedLogs: carried,
  unknownTopicLogs: unknown,
  events,
};
writeFileSync(OUT, JSON.stringify(db, null, 2));

console.log(`\nscanned ${all.length} logs in ${((Date.now() - t0) / 1000).toFixed(1)}s over ${done} windows (${unknown} with unknown topics)`);
console.log(`index now holds ${indexedLogs} logs (${carried} carried over, ${indexedLogs - carried} from this scan), scanTo ${scanTo}`);
for (const [name, e] of Object.entries(events)) {
  if (!e.count) continue;
  const f = logBlock(e.logs[0]);
  const l = logBlock(e.logs[e.logs.length - 1]);
  console.log(`  ${name.padEnd(24)} ${String(e.count).padStart(5)}  blocks ${f}..${l}`);
}
console.log("\nwrote history.json");
