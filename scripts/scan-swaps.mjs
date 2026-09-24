// P2: how much of the 24h volume actually passes through the burn hook?
//
// Uniswap v4 PoolManager emits
//   Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1,
//        uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)
// so grouping by topic1 (= poolId) tells us exactly how much traded in each pool.
//
//   node scripts/scan-swaps.mjs [hours]
import { writeFileSync } from "node:fs";
import { Rpc, keccak256Hex, utf8ToBytes, fmt18, rpcEndpoints } from "../lib/evm.js";
import { ADDR, POOL_IDS } from "../lib/contracts.js";
import { outPath } from "../lib/snapshot-out.js";

// `--out-dir <dir>` (used by the refresh job) must not be mistaken for the hours argument,
// so options are stripped before the first positional is read.
const argv = process.argv.slice(2);
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--out-dir") {
    i++;
    continue;
  }
  if (argv[i].startsWith("--")) continue;
  positional.push(argv[i]);
}
const HOURS = Number(positional[0] || 24);
const rpc = new Rpc(
  rpcEndpoints([
    "https://gateway.tenderly.co/public/mainnet",
    "https://rpc.mevblocker.io",
    "https://eth-mainnet.public.blastapi.io",
    "https://ethereum-rpc.publicnode.com",
    "https://eth-pokt.nodies.app",
  ]),
  { timeoutMs: 30000 }
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hx = (n) => "0x" + BigInt(n).toString(16);

const SWAP = keccak256Hex(utf8ToBytes("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"));
const head = await rpc.blockNumber();
const span = Math.ceil((HOURS * 3600) / 12);
const from = head - span;
console.log(`scanning Swap events in blocks ${from}..${head} (${HOURS}h, ${span} blocks)`);

const byPool = new Map();
let total = 0;
let failed = 0;
const t0 = Date.now();

for (let lo = from; lo <= head; lo += 1000) {
  const hi = Math.min(lo + 999, head);
  let logs = null;
  for (let attempt = 0; attempt < 3 && logs === null; attempt++) {
    try {
      logs = await rpc.call("eth_getLogs", [{ address: ADDR.poolManager, topics: [SWAP], fromBlock: hx(lo), toBlock: hx(hi) }]);
    } catch {
      await sleep(900 * (attempt + 1));
    }
  }
  if (logs === null) {
    failed++;
    // try a narrower window
    for (let l2 = lo; l2 <= hi; l2 += 200) {
      try {
        const part = await rpc.call("eth_getLogs", [{ address: ADDR.poolManager, topics: [SWAP], fromBlock: hx(l2), toBlock: hx(Math.min(l2 + 199, hi)) }]);
        logs = (logs || []).concat(part);
      } catch {}
      await sleep(60);
    }
    logs = logs || [];
  }
  total += logs.length;
  for (const l of logs) {
    const id = (l.topics[1] || "").toLowerCase();
    // PoolManager hosts every v4 pool on the chain; only these two are ETH/IMD.
    if (id !== POOL_IDS.A.toLowerCase() && id !== POOL_IDS.B.toLowerCase()) continue;
    const d = l.data.replace(/^0x/, "");
    const w = (i) => BigInt("0x" + d.slice(i * 64, (i + 1) * 64));
    // int128 arrives sign-extended into a full 256-bit word
    const s128 = (v) => (v >= 1n << 255n ? v - (1n << 256n) : v);
    const a0 = s128(w(0));
    const a1 = s128(w(1));
    const rec = byPool.get(id) || { id, count: 0, ethAbs: 0n, imdAbs: 0n, netEth: 0n, netImd: 0n };
    rec.count++;
    rec.ethAbs += a0 < 0n ? -a0 : a0;
    rec.imdAbs += a1 < 0n ? -a1 : a1;
    rec.netEth += a0;
    rec.netImd += a1;
    byPool.set(id, rec);
  }
  await sleep(70);
  if ((lo - from) % 20000 < 1000) console.log(`  ${lo - from}/${span} blocks, ${total} swaps`);
}

console.log(`\nscanned ${total} swaps in ${((Date.now() - t0) / 1000).toFixed(1)}s (${failed} windows needed narrowing)`);

const rows = [...byPool.values()].sort((a, b) => (b.ethAbs > a.ethAbs ? 1 : -1));
const totalEthAbs = rows.reduce((s, r) => s + r.ethAbs, 0n);
const totalCount = rows.reduce((s, r) => s + r.count, 0);

console.log(`\n=== the two ETH/IMD pools, last ${HOURS}h (of ${total} v4 swaps chain-wide) ===`);
for (const r of rows) {
  const label = r.id === POOL_IDS.A.toLowerCase() ? "池 A（无 hook）" : "池 B（有 hook）";
  const pctEth = totalEthAbs > 0n ? Number((r.ethAbs * 10000n) / totalEthAbs) / 100 : 0;
  const pctCount = totalCount > 0 ? (r.count * 100) / totalCount : 0;
  console.log(
    `  ${label.padEnd(16)} swaps=${String(r.count).padStart(5)} (${pctCount.toFixed(1)}%)  ` +
      `ETH 侧流量=${fmt18(r.ethAbs, 4).padStart(12)} (${pctEth.toFixed(2)}%)  ` +
      `净 IMD 流入=${fmt18(r.netImd, 2).padStart(12)}`
  );
}

const A = byPool.get(POOL_IDS.A.toLowerCase());
const B = byPool.get(POOL_IDS.B.toLowerCase());
let shareEth = null;
let shareCount = null;
if (A && B) {
  shareEth = Number((B.ethAbs * 10000n) / (A.ethAbs + B.ethAbs)) / 100;
  shareCount = (B.count * 100) / (A.count + B.count);
  console.log(`\n  ⇒ 经过烧毁引擎的金额占比: ${shareEth.toFixed(2)}%   （池 A 是它的 ${(100 / shareEth - 1).toFixed(1)} 倍）`);
  console.log(`  ⇒ 经过烧毁引擎的笔数占比: ${shareCount.toFixed(2)}%`);
  console.log(`  ⇒ 金额比 ≈ 1 : ${((100 - shareEth) / shareEth).toFixed(1)}`);
  console.log(`\n  若池 A 的卖压也经过烧毁引擎：`);
  console.log(`    池 A 净 IMD 流入 = ${fmt18(A.netImd, 2)} IMD（正 = 净卖出，会把库存推向触发线）`);
  console.log(`    池 B 净 IMD 流入 = ${fmt18(B.netImd, 2)} IMD`);
  console.log(`    仅池 A 一天的卖压就远超当前点火距离`);
}

const out = {
  scannedAt: new Date().toISOString(),
  hours: HOURS,
  fromBlock: from,
  toBlock: head,
  chainWideSwaps: total,
  totalEthAbs: totalEthAbs.toString(),
  totalSwaps: totalCount,
  hookShareEthPct: shareEth,
  hookShareCountPct: shareCount,
  pools: rows.map((r) => ({
    id: r.id,
    label: r.id === POOL_IDS.A.toLowerCase() ? "A" : "B",
    swaps: r.count,
    ethAbs: r.ethAbs.toString(),
    imdAbs: r.imdAbs.toString(),
    netEth: r.netEth.toString(),
    netImd: r.netImd.toString(),
  })),
  poolIds: POOL_IDS,
};
writeFileSync(outPath("volume.json"), JSON.stringify(out, null, 2));
console.log("\nwrote data/volume.json");
