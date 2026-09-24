// Turn the user-visible Chinese in lib/contracts.js into locale keys.
//
// The registry is data, not presentation: it is read by the page AND by the forensic
// scripts. So the value becomes a key ("owner.role.simd") and the renderer calls tr()
// on it — the file stays free of any language, and the copy lives in locales/*.json
// with everything else.
//
//   node scripts/retag-data-strings.mjs [--dry]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const dry = process.argv.includes("--dry");

const MAP = [
  // WATCHED[..].src
  ["Ownable — renounceOwnership() 会把 owner 设为 0x0", "watch.src.renounceOwnership"],
  // OWNER_POWERS[..].what
  ["抽走整个市场头寸（全部 IMD + ETH），且 marketOpen 无法回到 true（L580 注释：Terminal）", "owner.what.closeMarket"],
  ["提取全部累计 LP 费（token + ETH 两侧）", "owner.what.withdrawFees"],
  ["提取待部署到 backstop 的 retainedEth", "owner.what.withdrawRetainedEth"],
  ["扫走全部奖励缓冲（IMD）——即滞留待释放的 staking 奖励", "owner.what.dripperRescue"],
  ["扫走任意 ERC20 余额——<b>包括质押者的全部 IMD（totalAssets）</b>", "owner.what.simdRescue"],
  ["冻结全部存款、铸造、提款与赎回（renounce 被禁止在 paused 状态执行，L165-168）", "owner.what.simdPause"],
  ["抽走本合约全部 IMD 余额（含滞留的 heldBonding + heldNft）", "owner.what.distributorWithdraw"],
  // The stale "当前 20.26 IMD" is dropped here rather than translated: the queue has
  // grown past 800 IMD since, and a hard-coded number in a capability description is
  // exactly the kind of unsourced figure this dashboard forbids.
  ["抽走待桥接到 Base 的 IMD（当前 20.26 IMD）", "owner.what.burnExecutorRescue"],
  ["改跨链对端：可以把 Base 侧的接收合约改成任意地址，从而改变跨链销毁的落点", "owner.what.imdSetPeer"],
  ["改 LayerZero 配置代理，可进一步修改跨链消息库与安全配置", "owner.what.imdSetDelegate"],
  // OWNER_CONTRACTS[..]
  ['role: "质押金库"', 'role: "owner.role.simd"'],
  ['role: "烧毁引擎本体"', 'role: "owner.role.hook"'],
  ['role: "奖励缓释器"', 'role: "owner.role.dripper"'],
  ['role: "奖励分账"', 'role: "owner.role.distributor"'],
  ['role: "跨链销毁中转"', 'role: "owner.role.burnExecutor"'],
  ['role: "代币本体（LayerZero OFT）"', 'role: "owner.role.imd"'],
  [
    '"已 renounce：owner = 0x0，rescueERC20 与 setPaused 均已失效。质押者的 IMD 不再可以被任何管理员单方面取走或冻结。"',
    '"owner.note.simd.renounced"',
  ],
  ['liveNote: "owner 仍是 EOA —— 质押资金可被提取，且可一键冻结全部存取。"', 'liveNote: "owner.note.simd.live"'],
  [
    'liveNote: "owner 仍是 EOA —— 可随时抽走整个市场头寸（全部 IMD + ETH），且该操作不可逆。"',
    'liveNote: "owner.note.hook.live"',
  ],
  ['liveNote: "owner 仍是 EOA —— 可扫走全部奖励缓冲。"', 'liveNote: "owner.note.dripper.live"'],
  [
    'liveNote: "owner 仍是 EOA —— 可抽走本合约全部 IMD 余额（含滞留的两个桶）。"',
    'liveNote: "owner.note.distributor.live"',
  ],
  ['liveNote: "owner 仍是 EOA —— 可抽走待桥接的 IMD，也可改跨链目标地址。"', 'liveNote: "owner.note.burnExecutor.live"'],
  ['liveNote: "owner 仍是 EOA —— 可改跨链对端配置，从而改变跨链落点。"', 'liveNote: "owner.note.imd.live"'],
];

const target = "lib/contracts.js";
let src = readFileSync(ROOT + target, "utf8");
const problems = [];
let done = 0;

for (const [from, to] of MAP) {
  const first = src.indexOf(from);
  if (first < 0) {
    problems.push(`NOT FOUND: ${from.slice(0, 60)}`);
    continue;
  }
  if (src.indexOf(from, first + 1) >= 0) {
    problems.push(`NOT UNIQUE: ${from.slice(0, 60)}`);
    continue;
  }
  src = src.slice(0, first) + to + src.slice(first + from.length);
  done++;
}

if (!dry) writeFileSync(ROOT + target, src);
console.log(`retagged : ${done} / ${MAP.length}`);
if (problems.length) {
  console.log(`problems : ${problems.length}`);
  for (const p of problems) console.log(`  ${p}`);
}
if (dry) console.log("(dry run — nothing written)");
process.exit(problems.length ? 1 : 0);
