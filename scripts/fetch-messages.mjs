// The dev's only public announcement channel: plain-text calldata sent to a
// dedicated address. No Twitter, no docs site — just self-sends on Ethereum.
//
// Source: Blockscout's free address-transactions endpoint (no API key).
//   GET /api/v2/addresses/<addr>/transactions
// Paging: feed the response's next_page_params back as a query string.
// NOTE: do NOT add `filter=to|from` — it returns an empty list.
//
//   node scripts/fetch-messages.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { decodeMessage } from "../lib/decode-message.js";
import { outPath } from "../lib/snapshot-out.js";

export const MESSAGE_ADDRESS = "0x200E710aCAA6A93bbc77146026328C40F1d60fB1";
const BASE = `https://eth.blockscout.com/api/v2/addresses/${MESSAGE_ADDRESS}/transactions`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export { decodeMessage } from "../lib/decode-message.js";

async function fetchPage(url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" } });
      if (r.status === 429) {
        await sleep(3000 * (attempt + 1));
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (attempt === 4) throw e;
      await sleep(2000 * (attempt + 1));
    }
  }
}

const items = [];
let url = BASE;
let page = 0;
while (url && page < 20) {
  const j = await fetchPage(url);
  const batch = j.items || [];
  items.push(...batch);
  page++;
  console.log(`  page ${page}: ${batch.length} txs (total ${items.length})`);
  const npp = j.next_page_params;
  if (!npp || batch.length === 0) break;
  url = BASE + "?" + new URLSearchParams(npp).toString();
  await sleep(700);
}

const DEV_ADDRESSES = [
  "0x200e710acaa6a93bbc77146026328c40f1d60fb1", // the message board itself — dev self-sends here
  "0x047f606fd5b2baa5f5c6c4ab8958e45cb6b054b7", // the protocol owner EOA (also posts)
];
/** Threads the dashboard must surface regardless of position. */
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

const messages = [];
let undecodable = 0;
for (const it of items) {
  const text = decodeMessage(it.raw_input);
  if (text === null) {
    undecodable++;
    continue;
  }
  const from = (it.from && it.from.hash) || "";
  const to = (it.to && it.to.hash) || "";
  const fromLc = from.toLowerCase();
  messages.push({
    block: it.block_number,
    ts: Math.floor(new Date(it.timestamp).getTime() / 1000),
    tx: it.hash,
    from,
    to,
    selfSend: fromLc === to.toLowerCase(),
    isDev: DEV_ADDRESSES.includes(fromLc),
    important: IMPORTANT[it.block_number] || null,
    text,
  });
}
messages.sort((a, b) => b.block - a.block);

const dev = messages.filter((m) => m.isDev);
const community = messages.filter((m) => !m.isDev);
const devAnnouncements = messages.filter((m) => m.isDev && m.selfSend);

console.log(`\ntotal txs       ${items.length}`);
console.log(`decoded msgs    ${messages.length}`);
console.log(`undecodable     ${undecodable}`);
console.log(`from dev        ${dev.length}  (of which self-send announcements: ${devAnnouncements.length})`);
console.log(`from community  ${community.length}`);
console.log(`flagged important ${messages.filter((m) => m.important).length}`);
if (messages.length) {
  const lastDev = dev[0];
  console.log(`earliest block  ${messages[messages.length - 1].block}  ${new Date(messages[messages.length - 1].ts * 1000).toISOString()}`);
  console.log(`latest any      ${messages[0].block}  ${new Date(messages[0].ts * 1000).toISOString()}`);
  if (lastDev) console.log(`latest from dev ${lastDev.block}  ${new Date(lastDev.ts * 1000).toISOString()}`);
}
const missing = Object.keys(IMPORTANT).filter((b) => !messages.some((m) => m.block === Number(b)));
if (missing.length) console.log(`⚠ important blocks not found: ${missing.join(", ")}`);

mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
writeFileSync(
  outPath("messages.json"),
  JSON.stringify(
    {
      address: MESSAGE_ADDRESS,
      fetchedAt: new Date().toISOString(),
      devAddresses: DEV_ADDRESSES,
      counts: {
        txs: items.length,
        decoded: messages.length,
        undecodable,
        fromDev: dev.length,
        devAnnouncements: devAnnouncements.length,
        fromCommunity: community.length,
        important: messages.filter((m) => m.important).length,
      },
      messages,
    },
    null,
    2
  )
);
console.log("\nwrote data/messages.json");
