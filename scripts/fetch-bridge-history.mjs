// Rebuild the second door's queue history from Transfer logs.
//
// Why not eth_call at a past block: that needs an archive node, and the public RPC
// fleet serves those historical calls only intermittently. The queue's value at a past
// moment is recoverable anyway — take today's balance and subtract the net flow since:
//
//   balance(t) = balance(now) − Σ inflows(t…now) + Σ outflows(t…now)
//
// Transfer logs answer that exactly, are cheap, and every public node serves them
// (chunked, because range limits are real). The result is written to
// data/bridge-history.json for the page to fall back on when the archive calls fail.
//
//   node scripts/fetch-bridge-history.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Rpc, keccak256Hex, decodeReturns, encodeCall } from "../lib/evm.js";
import { ADDR } from "../lib/contracts.js";
import { outPath } from "../lib/snapshot-out.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const rpc = new Rpc(undefined, { timeoutMs: 25000 });

const TRANSFER = keccak256Hex("Transfer(address,address,uint256)");
const pad = (addr) => "0x" + "0".repeat(24) + addr.slice(2).toLowerCase();
const WINDOW_DAYS = 7;
const CHUNK = 10_000;

const head = await rpc.blockNumber();
const headBlock = await rpc.getBlock(head);
const headTs = Number(headBlock.timestamp);
const fromBlock = head - Math.ceil((WINDOW_DAYS * 86400) / 12);

console.log(`head ${head} (${new Date(headTs * 1000).toISOString()})`);
console.log(`scanning blocks ${fromBlock}…${head} for IMD transfers touching BurnExecutor`);

const logs = [];
for (let start = fromBlock; start <= head; start += CHUNK) {
  const end = Math.min(start + CHUNK - 1, head);
  for (const topics of [
    [TRANSFER, null, pad(ADDR.burnExecutor)], // into the waypoint
    [TRANSFER, pad(ADDR.burnExecutor), null], // out of it
  ]) {
    try {
      const batch = await rpc.call("eth_getLogs", [{ address: ADDR.imd, fromBlock: "0x" + start.toString(16), toBlock: "0x" + end.toString(16), topics }]);
      for (const l of batch) {
        logs.push({ block: Number(l.blockNumber), from: l.topics[1], to: l.topics[2], value: decodeReturns(["uint256"], l.data)[0] });
      }
    } catch (e) {
      console.log(`  chunk ${start}-${end} failed: ${String(e.message || e).slice(0, 80)}`);
    }
  }
}
console.log(`  ${logs.length} transfer events`);
logs.sort((a, b) => a.block - b.block);

/* A week with zero transfers is not a real state: the pool trades constantly and the
 * waypoint moves in and out with every trim and bridge. Zero events means the scan failed,
 * and continuing would publish a snapshot whose "historical" points all equal today's
 * balance — a file that looks perfectly valid and says "nothing ever moved". Fail instead,
 * so the refresh keeps the previous snapshot. */
if (logs.length === 0) {
  console.error("no IMD transfers touched BurnExecutor in the window — the log scan failed, refusing to write a snapshot");
  process.exit(1);
}

/** Net flow into the waypoint over the last `blocks` blocks. */
function netSince(blocks) {
  const cutoff = head - blocks;
  let net = 0n;
  for (const l of logs) {
    if (l.block < cutoff) continue;
    net += l.to.toLowerCase() === ADDR.burnExecutor.toLowerCase() ? l.value : -l.value;
  }
  return net;
}

const nowRaw = await rpc.ethCall(ADDR.burnExecutor, encodeCall("tokenBalance()"));
const now = decodeReturns(["uint256"], nowRaw)[0];

const plan = [
  { label: "now", hoursAgo: 0, blocks: 0 },
  { label: "6h", hoursAgo: 6, blocks: Math.round((6 * 3600) / 12) },
  { label: "12h", hoursAgo: 12, blocks: Math.round((12 * 3600) / 12) },
  { label: "18h", hoursAgo: 18, blocks: Math.round((18 * 3600) / 12) },
  { label: "24h", hoursAgo: 24, blocks: Math.round((24 * 3600) / 12) },
  { label: "7d", hoursAgo: 168, blocks: Math.round((168 * 3600) / 12) },
];

const points = plan.map((p) => ({ label: p.label, hoursAgo: p.hoursAgo, block: head - p.blocks, value: (now - netSince(p.blocks)).toString() }));

const out = {
  _note:
    "BurnExecutor 的 IMD 余额历史，由 Transfer 日志重建（余额(t) = 现在 − t 之后的净流入）。" +
    "页面优先用 RPC 历史采样；公共节点不提供 archive 调用时回退到这份快照。由 scripts/fetch-bridge-history.mjs 生成。",
  fetchedAt: new Date().toISOString(),
  headBlock: head,
  headTs,
  now: now.toString(),
  events: logs.length,
  points,
};
writeFileSync(outPath("bridge-history.json"), JSON.stringify(out, null, 2) + "\n");

console.log(`\nbalance now: ${now} wei (${(Number(now) / 1e18).toFixed(4)} IMD)`);
for (const p of points) console.log(`  ${p.label.padEnd(4)} block ${String(p.block).padEnd(10)} ${(Number(p.value) / 1e18).toFixed(4)} IMD`);
console.log(`\nwrote data/bridge-history.json`);
