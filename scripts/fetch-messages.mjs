// The dev's only public announcement channel: plain-text calldata sent to a
// dedicated address. No Twitter, no docs site — just self-sends on Ethereum.
//
// Source: the chain itself, via eth_getBlockByNumber(tag, true).
//
// This used to read Blockscout's `/api/v2/addresses/<addr>/transactions` (free, no key). When
// that host stopped answering from CI, this step failed, and because the refresh job treated
// every step as required, the other five snapshots aged behind it — one upstream of six took out
// six of six. Reading the chain directly removes the dependency.
//
// eth_getLogs is NOT an option here and never was: the board is a plain EOA, so it emits no logs
// and getLogs returns [] at any range. A message is the CALLDATA of a transfer, which lives in
// the transaction, not in a receipt or a log. Anything that reads this board must walk blocks and
// look inside their transactions — see lib/messages-live.js for the same reasoning, and
// lib/messages-scan.mjs for what build time needs on top of it.
//
// Build time differs from the runtime scanner in the way that matters: nobody is waiting, so the
// window is set by "close the gap since the last scan" rather than by "do not block first paint".
// A job that stopped for a day must not silently lose that day, which is what a short fixed
// window would do.
//
//   node scripts/fetch-messages.mjs
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { decodeMessage } from "../lib/decode-message.js";
import { outPath } from "../lib/snapshot-out.js";
import { Rpc, rpcEndpoints } from "../lib/evm.js";
import { scanRange, scanCeiling, nextScannedTo, mergeMessages, scanMessageRange, COLD_START_CAP } from "../lib/messages-scan.mjs";

export const MESSAGE_ADDRESS = "0x200E710aCAA6A93bbc77146026328C40F1d60fB1";

export { decodeMessage } from "../lib/decode-message.js";

/**
 * Blocks per batch, measured rather than assumed.
 *
 * The runtime scanner uses 25 because a BROWSER answers HTTP 200 while marking individual entries
 * "response too large" once a batch gets big — a partial read that looks like success. Node does
 * not show that behaviour, but "Node is different" is not a reason to guess: 300 was measured on
 * Node with every entry answered (`ok 300/300`, zero missed over 12 consecutive chunks).
 *
 * WHAT THIS COSTS. A full block is ~200 transactions, and a 300-block batch measured 131 MB of
 * response body. Chunk size does NOT change the total transferred — the same block range is the
 * same bytes whether it arrives in 10 requests or 100; chunking only trades request count against
 * batch hostility. At 12,000 blocks a run therefore downloads ~5 GB, which is the single largest
 * cost in this design and the reason the cap exists. The lever for cost is COLD_START_CAP, not
 * this constant.
 */
const CHUNK = 300;

/**
 * The published snapshot, for its watermark and its messages.
 *
 * Everything the snapshot holds is kept: it is the authoritative record of everything before the
 * range this run scans, and the merge is by transaction hash so nothing is lost or duplicated.
 */
function prevMessages() {
  try {
    const j = JSON.parse(readFileSync(new URL("../data/messages.json", import.meta.url), "utf8").replace(/^\uFEFF/, ""));
    return {
      messages: Array.isArray(j.messages) ? j.messages : [],
      counts: j.counts || {},
      scannedTo: Number.isFinite(j.scannedTo) ? j.scannedTo : null,
      fetchedAt: j.fetchedAt || null,
    };
  } catch {
    return { messages: [], counts: {}, scannedTo: null, fetchedAt: null };
  }
}

/* Endpoints are chosen for BATCH capability, which is not the same thing as "works".
 *
 * This scan sends ~300 `eth_getBlockByNumber(full=true)` requests in one JSON-RPC batch, and the
 * project's DEFAULT_RPCS list was selected for other request shapes (single calls, eth_getLogs
 * windows). Measured per endpoint with a 50-block batch:
 *
 *   ok 50/50   ethereum-rpc.publicnode.com, rpc.mevblocker.io, eth-mainnet.public.blastapi.io
 *   REJECTED   eth.drpc.org            "Batch of more than 3 requests are not allowed on free plan"
 *   REJECTED   gateway.tenderly.co     "rate limit exceeded"
 *   REJECTED   rpc.flashbots.net       "too many RPC calls in batch request"
 *   BROKEN     eth-pokt.nodies.app     connect timeout;  1rpc.io/eth  non-JSON response
 *
 * `Rpc.batch` walks the pool from its current position until one endpoint answers, so a pool that
 * is mostly batch-hostile means every chunk pays several timeouts before reaching a working node —
 * which is what made a first run of this script stall for minutes with no progress.
 *
 * The list is deliberately short and ordered: two endpoints verified to accept the full batch.
 * Note that verifying "the endpoint works" with a single eth_blockNumber is NOT sufficient — all
 * eight answer that, and five cannot serve the batch this scan actually issues. */
const BATCH_RPC = ["https://rpc.mevblocker.io", "https://ethereum-rpc.publicnode.com"];
const rpc = new Rpc(rpcEndpoints(BATCH_RPC), { timeoutMs: 60_000 });

const previous = prevMessages();
const head = Number(await rpc.call("eth_blockNumber", []));
const snapshotMax = previous.messages.length ? Math.max(...previous.messages.map((m) => m.block || 0)) : 0;

const { from, reason } = scanRange({ head, snapshotMaxBlock: snapshotMax, scannedTo: previous.scannedTo });
console.log(`  ${reason}`);
if (previous.scannedTo) {
  console.log(`  (snapshot holds ${previous.messages.length} messages, newest at block ${snapshotMax})`);
}

/* One run is capped so the hourly job cannot be killed mid-scan. When the gap exceeds the cap,
 * `to` lands below the head and the watermark records only what was actually read — the rest is
 * carried into the next run. Scanning the newest N blocks and discarding the remainder would
 * instead leave a permanent hole, which is the one outcome this design refuses. */
const { to, truncated } = scanCeiling({ from, head });
if (truncated) {
  console.log(`  gap exceeds the ${COLD_START_CAP}-block cap — scanning ${from}..${to}, the rest continues next run`);
}

const t0 = Date.now();
const scan = await scanMessageRange({ rpc, from, to, chunk: CHUNK, log: (m) => console.log(`  ${m}`) });
console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s`);

/* The watermark only advances over blocks that were genuinely read. A partial scan leaves it
 * where it was, so the resume margin re-covers the hole; advancing would convert a transient
 * failure into permanently missing history — invisible, because a shorter list of messages looks
 * exactly like a quiet week. */
const scannedTo = nextScannedTo({ previous: previous.scannedTo, to: scan.covered ? to : from - 1, covered: scan.covered });
if (!scan.covered) {
  console.log(`  ⚠ ${scan.missed.length} block(s) were never read — watermark held (stays at ${scannedTo ?? "none"})`);
}

/* Merge, then recompute the derived fields. Counts are recomputed rather than carried over
 * because they describe the list, and a stale count would contradict it. */
const merged = mergeMessages(previous.messages, scan.messages);

/**
 * Threads the dashboard must surface regardless of position.
 *
 * Applied to the merged list by block number rather than during the scan, because most of these
 * are far older than any single run scans — they come from the snapshot, and the flag has to keep
 * working on messages this run never read.
 */
const IMPORTANT = {
  26038179: "宣布已改设置、恢复烧毁，并发放奖励（解释了链上那次翻转）",
  26026706: "预告要改 pool4 设置，让烧毁与奖励恢复",
  26014070: "renounce 了 staking 合约的 ownership",
  26014063: "（renounce 交易的区块，见 ownership 面板）",
  25793366: "burnExecutor 已改成任何人可调用，鼓励做 bot",
  26021512: "imd.fun 上线，100 个任务并发",
  26021507: "imd.fun 上线（同一公告，owner 地址发出）",
  25965646: "创建 awesome-imd",
  26022802: "白名单抽奖用了第三方工具",
  25892458: "社区讨论 StakedIMD 的 SameBlockRedeem grief 问题",
  25892774: "社区讨论 SameBlockRedeem（续）",
};
for (const m of merged) m.important = IMPORTANT[m.block] || null;

const DEV_ADDRESSES = [
  "0x200e710acaa6a93bbc77146026328c40f1d60fb1", // the message board itself — dev self-sends here
  "0x047f606fd5b2baa5f5c6c4ab8958e45cb6b054b7", // the protocol owner EOA (also posts)
];
const isDev = (m) => DEV_ADDRESSES.includes(String(m.from || "").toLowerCase());
/* `txs` counts every transaction the board received, decoded or not. The old scanner knew it
 * because it paged all of them; a block walk only sees the ones it decodes, so the previous count
 * is the floor and this run can only add. Reported separately from `decoded`, which is the number
 * of actual messages. */
const newTxs = scan.messages.filter((m) => !previous.messages.some((p) => p.tx === m.tx)).length;
const counts = {
  txs: (previous.counts.txs || 0) + newTxs,
  decoded: merged.length,
  undecodable: previous.counts.undecodable || 0,
  fromDev: merged.filter(isDev).length,
  devAnnouncements: merged.filter((m) => isDev(m) && m.selfSend).length,
  fromCommunity: merged.filter((m) => !isDev(m)).length,
  important: merged.filter((m) => m.important).length,
};

const messages = merged;

const dev = messages.filter((m) => m.isDev);
const community = messages.filter((m) => !m.isDev);
const devAnnouncements = messages.filter((m) => m.isDev && m.selfSend);

console.log(`\ntotal txs       ${counts.txs}`);
console.log(`decoded msgs    ${messages.length}`);
console.log(`from dev        ${dev.length}  (of which self-send announcements: ${devAnnouncements.length})`);
console.log(`from community  ${community.length}`);
if (messages.length) {
  const lastDev = dev[0];
  console.log(`earliest block  ${messages[messages.length - 1].block}  ${new Date(messages[messages.length - 1].ts * 1000).toISOString()}`);
  console.log(`latest any      ${messages[0].block}  ${new Date(messages[0].ts * 1000).toISOString()}`);
  if (lastDev) console.log(`latest from dev ${lastDev.block}  ${new Date(lastDev.ts * 1000).toISOString()}`);
}

mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
writeFileSync(
  outPath("messages.json"),
  JSON.stringify(
    {
      address: MESSAGE_ADDRESS,
      fetchedAt: new Date().toISOString(),
      /* How far the scan has read, which is NOT the newest message.
       *
       * Messages arrive ~0.55/day (one per ~13,155 blocks), so the newest message can trail a
       * completed scan by a long way; and after a partial scan it is AHEAD of the real progress.
       * Resuming from the message in that case would skip the blocks in between, permanently and
       * invisibly. Same reasoning and same field name as base.json's scannedTo. */
      scannedTo,
      devAddresses: DEV_ADDRESSES,
      counts,
      messages,
    },
    null,
    2
  )
);
console.log("\nwrote data/messages.json");
