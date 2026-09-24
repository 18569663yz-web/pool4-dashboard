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
const head = await pool.blockNumber();
console.log("head block", head);

let db = { address: ADDR.hook, events: {} };
if (!force) {
  try {
    db = JSON.parse(readFileSync(PREV, "utf8"));
  } catch {}
}

const start = fromArg ? Number(fromArg.slice(7)) : db.scanFrom || 25887000; // just before MarketOpened
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

// bucket by event name
const events = {};
for (const [name, t0hex] of Object.entries(TOPIC0)) {
  events[name] = { topic0: t0hex, signature: TOPICS[name], logs: [] };
}
let unknown = 0;
for (const l of all) {
  const name = BY_TOPIC[(l.topics[0] || "").toLowerCase()];
  if (!name) {
    unknown++;
    continue;
  }
  events[name].logs.push(l);
}
for (const e of Object.values(events)) {
  e.logs.sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16) || parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16));
  e.count = e.logs.length;
}

db = { address: ADDR.hook, head, scanFrom: start, scanTo: head, fetchedAt: new Date().toISOString(), totalLogs: all.length, unknownTopicLogs: unknown, events };
writeFileSync(OUT, JSON.stringify(db, null, 2));

console.log(`\nscanned ${all.length} logs in ${((Date.now() - t0) / 1000).toFixed(1)}s (${unknown} with unknown topics)`);
for (const [name, e] of Object.entries(events)) {
  if (!e.count) continue;
  const f = parseInt(e.logs[0].blockNumber, 16);
  const l = parseInt(e.logs[e.logs.length - 1].blockNumber, 16);
  console.log(`  ${name.padEnd(24)} ${String(e.count).padStart(5)}  blocks ${f}..${l}`);
}
console.log("\nwrote history.json");
