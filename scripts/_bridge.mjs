import { Rpc, fmt18 } from "../lib/evm.js";
import { bridgeHistory, readBridgeTrend, ARCHIVE_RPCS } from "../lib/contracts.js";
const rpc = new Rpc(ARCHIVE_RPCS, { timeoutMs: 30000 });
const headHex = await rpc.call("eth_blockNumber", []);
const head = Number(BigInt(headHex));
const blk = await rpc.call("eth_getBlockByNumber", ["0x" + head.toString(16), false]);
const ts = Number(BigInt(blk.timestamp));
console.log("head:", head, new Date(ts*1000).toISOString());
const hist = await bridgeHistory(rpc, head, ts);
for (const p of hist.points) {
  console.log(`  ${p.label.padEnd(5)} block ${p.block}  ${p.value === null ? "ARCHIVE MISS" : fmt18(p.value, 6) + " IMD"}`);
}
const t = readBridgeTrend(hist);
console.log("\ntrend:", JSON.stringify(t, (k,v) => typeof v === "bigint" ? fmt18(v,6) : v));
