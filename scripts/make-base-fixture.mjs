// Build the offline fixture for build-data.mjs from data we already trust.
//
// Why this exists: build-data.mjs has a code path that only runs when the chain was
// actually reached. On this machine that path is unreachable (Blockscout times out under
// node), so a ReferenceError in it survived every local run and only appeared on CI —
// where it failed the whole refresh. A test that cannot execute the code it is testing is
// not a test, so the fixture reconstructs the exact shapes the network calls return, out
// of `data/base.json` and `data/timeline.json` (both produced by a run that DID reach the
// chain). No hand-written samples: every block number, timestamp, caller and hash below
// comes from a real event.
//
//   node scripts/make-base-fixture.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { keccak256Hex, utf8ToBytes, Rpc } from "../lib/evm.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => JSON.parse(readFileSync(ROOT + p, "utf8").replace(/^\uFEFF/, ""));

const base = read("data/base.json");
const timeline = read("data/timeline.json");
const history = read("data/history.json");

const BURN_TOPIC = keccak256Hex(utf8ToBytes("BurnExecuted(address,address)"));
const BRIDGE_TOPIC = keccak256Hex(utf8ToBytes("TokensBridgedForBurn(address,uint32,bytes32,uint256,uint256,bytes32)"));
const hx = (n) => "0x" + BigInt(n).toString(16);
const topicAddress = (addr) => "0x" + "0".repeat(24) + String(addr).slice(2).toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// L1 timestamps: the set build-data asks for (timeline.blockTime) plus every bridge block,
// which the summary line needs too.
const l1BlockTimestamps = { ...timeline.blockTime };
for (const b of base.bridges || []) if (b.t) l1BlockTimestamps[String(b.b)] = b.t;

/* data/history.json is the freshest artifact — it is refreshed every hour, while
 * timeline.json is rebuilt from it. Its newest event blocks therefore may not be in
 * timeline.blockTime yet, and a fixture missing them would make build-data crash on the
 * summary line instead of exercising it. Fill the gap from the chain (this generator is
 * allowed to be online; the fixture it produces is what has to work offline). */
const wanted = new Set();
for (const e of Object.values(history.events || {})) {
  const logs = e.logs || [];
  if (logs.length) {
    wanted.add(parseInt(logs[0].blockNumber, 16));
    wanted.add(parseInt(logs[logs.length - 1].blockNumber, 16));
  }
}
for (const name of ["Trimmed", "BackstopSettled"]) {
  for (const l of (history.events?.[name]?.logs) || []) wanted.add(parseInt(l.blockNumber, 16));
}
const missing = [...wanted].filter((b) => l1BlockTimestamps[b] === undefined && l1BlockTimestamps[String(b)] === undefined).sort((a, b) => a - b);
if (missing.length) {
  console.log(`fetching ${missing.length} block timestamps that timeline.json does not have yet…`);
  const rpc = new Rpc(undefined, { timeoutMs: 25000 });
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    const out = await rpc.batch(chunk.map((b) => ({ method: "eth_getBlockByNumber", params: [hx(b), false] })));
    out.forEach((o, k) => {
      if (o.ok && o.result) l1BlockTimestamps[String(chunk[k])] = Number(BigInt(o.result.timestamp));
    });
    await sleep(60);
  }
}

const baseBlockTimestamps = {};
for (const b of base.burns || []) if (b.t) baseBlockTimestamps[String(b.b)] = b.t;

const fixture = {
  _note:
    "build-data.mjs 的离线 fixture。全部数值来自真实事件（data/base.json + data/timeline.json），" +
    "只是换成了各数据源返回的原始形状：blockscout 的日志对象、eth_getLogs 的日志对象、ABI 解码后的读数。" +
    "由 scripts/make-base-fixture.mjs 生成。",
  l1Head: timeline.scannedTo,
  baseHead: base.state.head,
  l1BlockTimestamps,
  baseBlockTimestamps,
  // Blockscout's getLogs shape: hex strings, timeStamp included, caller in topics[1].
  baseLogs: (base.burns || []).map((b) => ({
    blockNumber: hx(b.b),
    timeStamp: b.t ? hx(b.t) : undefined,
    logIndex: "0x0",
    transactionHash: b.tx,
    topics: [BURN_TOPIC, topicAddress(b.caller), topicAddress(base.state.token)],
  })),
  // eth_getLogs shape: hex strings, logIndex present, no timeStamp.
  l1BridgeLogs: (base.bridges || []).map((b) => ({
    blockNumber: hx(b.b),
    logIndex: "0x0",
    transactionHash: b.tx,
    topics: [BRIDGE_TOPIC],
    data: "0x",
  })),
  baseReads: {
    "decimals()": base.state.tokenDecimals,
    "name()": base.state.tokenName,
    "symbol()": base.state.tokenSymbol,
    "totalSupply()": base.state.tokenTotalSupply,
    "adapterBalance()": base.state.adapterBalance,
    "receiverBalance()": base.state.receiverBalance,
  },
};

writeFileSync(ROOT + "data/_fixture-base.json", JSON.stringify(fixture, null, 2) + "\n");

const kb = (v) => (JSON.stringify(v).length / 1024).toFixed(1) + " KB";
console.log("wrote data/_fixture-base.json");
console.log(`  l1Head ${fixture.l1Head}   baseHead ${fixture.baseHead}`);
console.log(`  burn logs      ${fixture.baseLogs.length}   ${kb(fixture.baseLogs)}`);
console.log(`  bridge logs    ${fixture.l1BridgeLogs.length}   ${kb(fixture.l1BridgeLogs)}`);
console.log(`  L1 timestamps  ${Object.keys(l1BlockTimestamps).length}`);
console.log(`  base timestamps ${Object.keys(baseBlockTimestamps).length}`);
console.log(`  total          ${kb(fixture)}`);
