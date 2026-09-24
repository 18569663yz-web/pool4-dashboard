// Wire the static Chinese copy in index.html to the i18n layer.
//
// The page ships Chinese first (that is the default language), so the original text
// stays in place as the initial paint; a data-i18n / data-i18n-html attribute is what
// lets applyStatic() replace it — in English mode, and back again in Chinese.
//
// This is a script rather than sixty hand edits for one reason: it is reviewable and
// re-runnable. Every entry must match exactly once, and anything that does not is
// reported instead of guessed at.
//
//   node scripts/wire-html-i18n.mjs [--dry]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const dry = process.argv.includes("--dry");

/** [needle, replacement] — the needle must be unique in the file. */
const EDITS = [
  // ---- header status line (labels are static, the <b> values are not) ----
  [`<span>区块 <b id="st-block">—</b></span>`, `<span><span data-i18n="html.status.block">区块</span> <b id="st-block">—</b></span>`],
  [`<span>更新于 <b id="st-updated">—</b></span>`, `<span><span data-i18n="html.status.updated">更新于</span> <b id="st-updated">—</b></span>`],
  [`<span>下次 <b id="st-next">—</b></span>`, `<span><span data-i18n="html.status.next">下次</span> <b id="st-next">—</b></span>`],

  // ---- 30-second summary ----
  [`<h3>这意味着什么</h3>`, `<h3 data-i18n="html.sum.impactTitle">这意味着什么</h3>`],
  [`<h3>什么时候会恢复</h3>`, `<h3 data-i18n="html.sum.recoveryTitle">什么时候会恢复</h3>`],
  [`<h3>还有一件你应该知道的事</h3>`, `<h3 data-i18n="html.sum.riskTitle">还有一件你应该知道的事</h3>`],
  [
    `<p class="sum-jump">↓ 以下是全部证据与机制细节，每一项都可点开复核</p>`,
    `<p class="sum-jump" data-i18n="html.sum.jump">↓ 以下是全部证据与机制细节，每一项都可点开复核</p>`,
  ],

  // ---- what is this ----
  [`<h2>这是什么</h2>`, `<h2 data-i18n="html.what.title">这是什么</h2>`],
  [`      <p>\n        <b>IdentityMD（$IMD）</b>`, `      <p data-i18n-html="html.what.p1">\n        <b>IdentityMD（$IMD）</b>`],
  [`      <p>\n        这个机制让 IMD 持续通缩`, `      <p data-i18n-html="html.what.p2">\n        这个机制让 IMD 持续通缩`],
  [`      <p>\n        这个页面回答两个问题：`, `      <p data-i18n-html="html.what.p3">\n        这个页面回答两个问题：`],
  [
    `margin-bottom:8px">\n          设计意图 · 来自项目方的链上留言`,
    `margin-bottom:8px" data-i18n="html.what.quoteLabel">\n          设计意图 · 来自项目方的链上留言`,
  ],
  [
    `        <cite>区块 25,901,450 · 2026-09-04 ·`,
    `        <cite><span data-i18n="html.what.quoteSrc">区块 25,901,450 · 2026-09-04 ·</span>`,
  ],
  [
    `<p class="tiny" style="margin:10px 0 0">\n          <b>也就是说</b>：`,
    `<p class="tiny" style="margin:10px 0 0" data-i18n-html="html.what.quote1Note">\n          <b>也就是说</b>：`,
  ],
  [`<cite>同一区块 25,901,450</cite>`, `<cite data-i18n="html.what.quote2Src">同一区块 25,901,450</cite>`],
  [
    `<p class="tiny" style="margin:10px 0 0">\n          <b>它不只为 IMD 存在</b>：`,
    `<p class="tiny" style="margin:10px 0 0" data-i18n-html="html.what.quote2Note">\n          <b>它不只为 IMD 存在</b>：`,
  ],
  [`      <p class="muted">\n        数据全部从以太坊和 Base`, `      <p class="muted" data-i18n-html="html.what.readonly">\n        数据全部从以太坊和 Base`],

  // ---- on-chain messages ----
  [`<h2>链上留言</h2>`, `<h2 data-i18n="html.msg.title">链上留言</h2>`],
  [
    `margin-bottom:8px">最新一条 · 项目方</div>`,
    `margin-bottom:8px" data-i18n="html.msg.latestLabel">最新一条 · 项目方</div>`,
  ],
  [
    `<button type="button" id="msgf-all" class="preset active">全部<small`,
    `<button type="button" id="msgf-all" class="preset active"><span data-i18n="html.msg.filterAll">全部</span><small`,
  ],
  [`id="msgf-dev" class="preset">项目方<small`, `id="msgf-dev" class="preset"><span data-i18n="html.msg.filterDev">项目方</span><small`],
  [
    `id="msgf-community" class="preset">社区<small`,
    `id="msgf-community" class="preset"><span data-i18n="html.msg.filterCommunity">社区</span><small`,
  ],
  [`id="msgf-key" class="preset">重点<small`, `id="msgf-key" class="preset"><span data-i18n="html.msg.filterKey">重点</span><small`],
  [
    `<summary>给技术读者的细节：数据来源与解码方式</summary>`,
    `<summary data-i18n="html.msg.techSummary">给技术读者的细节：数据来源与解码方式</summary>`,
  ],

  // ---- section bands ----
  [`<div class="band" id="evidence"><span>证据</span></div>`, `<div class="band" id="evidence"><span data-i18n="html.band.evidence">证据</span></div>`],
  [`<div class="band" id="mechanism"><span>机制</span></div>`, `<div class="band" id="mechanism"><span data-i18n="html.band.mechanism">机制</span></div>`],
  [
    `<div class="band" id="governance"><span>权限</span></div>`,
    `<div class="band" id="governance"><span data-i18n="html.band.governance">权限</span></div>`,
  ],
  [`<div class="band" id="data"><span>数据</span></div>`, `<div class="band" id="data"><span data-i18n="html.band.data">数据</span></div>`],

  // ---- current state ----
  [`<h2>现在的状态</h2>`, `<h2 data-i18n="html.verdict.title">现在的状态</h2>`],
  [
    `            点火距离 <span class="src-note">距离重新开始烧毁还差多少 IMD</span>`,
    `            <span data-i18n="html.verdict.gapLabel">点火距离</span> <span class="src-note" data-i18n="html.verdict.gapNote">距离重新开始烧毁还差多少 IMD</span>`,
  ],
  [
    `<div class="labels"><span>0（池子里囤着的 IMD）</span>`,
    `<div class="labels"><span data-i18n="html.verdict.barLeft">0（池子里囤着的 IMD）</span>`,
  ],
  [`<div class="k">池子里囤着的 IMD <span id="src-held">`, `<div class="k"><span data-i18n="html.verdict.held">池子里囤着的 IMD</span> <span id="src-held">`],
  [`<div class="k">烧毁触发线 <span id="src-cap">`, `<div class="k"><span data-i18n="html.verdict.cap">烧毁触发线</span> <span id="src-cap">`],
  [
    `<div class="k">当前待烧毁量 <span id="src-pending">`,
    `<div class="k"><span data-i18n="html.verdict.pending">当前待烧毁量</span> <span id="src-pending">`,
  ],
  [`<div class="k">触发线的下限 <span id="src-floor">`, `<div class="k"><span data-i18n="html.verdict.floor">触发线的下限</span> <span id="src-floor">`],
  [
    `margin-bottom:8px">三种状态的含义</div>`,
    `margin-bottom:8px" data-i18n="html.verdict.statesLabel">三种状态的含义</div>`,
  ],
  [
    `margin-bottom:8px">状态变更历史（本机记录）</div>`,
    `margin-bottom:8px" data-i18n="html.verdict.flipLabel">状态变更历史（本机记录）</div>`,
  ],

  // ---- timeline ----
  [`<h2>熄火时间线</h2>`, `<h2 data-i18n="html.timeline.title">熄火时间线</h2>`],

  // ---- the two doors ----
  [`<h2>烧毁有两道门</h2>`, `<h2 data-i18n="html.doors.title">烧毁有两道门</h2>`],
  [
    `    <p class="lede">\n      <b>这意味着什么：</b>即使第一道门恢复`,
    `    <p class="lede" data-i18n-html="html.doors.lede1">\n      <b>这意味着什么：</b>即使第一道门恢复`,
  ],
  [
    `    <p class="lede">\n      第一道门在以太坊上：`,
    `    <p class="lede" data-i18n-html="html.doors.lede2">\n      第一道门在以太坊上：`,
  ],
  [
    `font-size:14px;margin-bottom:8px">第一道门 · 以太坊上的抽走</div>`,
    `font-size:14px;margin-bottom:8px" data-i18n="html.doors.card1">第一道门 · 以太坊上的抽走</div>`,
  ],
  [
    `font-size:14px;margin-bottom:8px">第二道门 · Base 链上的销毁</div>`,
    `font-size:14px;margin-bottom:8px" data-i18n="html.doors.card2">第二道门 · Base 链上的销毁</div>`,
  ],
  [
    `<summary>给技术读者的细节：跨链与销毁事件如何配对</summary>`,
    `<summary data-i18n="html.doors.techSummary">给技术读者的细节：跨链与销毁事件如何配对</summary>`,
  ],
  [
    `<summary>给技术读者的细节：池 ID 与识别方式</summary>`,
    `<summary data-i18n="html.pools.techSummary">给技术读者的细节：池 ID 与识别方式</summary>`,
  ],

  // ---- current readings ----
  [`<h2>当前数据</h2>`, `<h2 data-i18n="html.panel.title">当前数据</h2>`],
  [
    `    <p class="lede">\n      <b>这意味着什么：</b>下面是这台烧毁引擎的全部关键读数`,
    `    <p class="lede" data-i18n-html="html.panel.lede">\n      <b>这意味着什么：</b>下面是这台烧毁引擎的全部关键读数`,
  ],
  [
    `<summary>给技术读者的细节：全部原始读数（含取不到的项与原因）</summary>`,
    `<summary data-i18n="html.panel.techSummary">给技术读者的细节：全部原始读数（含取不到的项与原因）</summary>`,
  ],

  // ---- simulator ----
  [`<h2>什么时候会重新烧起来</h2>`, `<h2 data-i18n="html.sim.title">什么时候会重新烧起来</h2>`],
  [
    `    <p class="lede">\n      <b>这意味着什么：</b>池子里囤的 IMD 需要涨回触发线以上。`,
    `    <p class="lede" data-i18n-html="html.sim.lede">\n      <b>这意味着什么：</b>池子里囤的 IMD 需要涨回触发线以上。`,
  ],
  [
    `class="preset active">温和流入<small>每天 +1,000 IMD</small>`,
    `class="preset active"><span data-i18n="html.sim.presetCalm">温和流入</span><small data-i18n="html.sim.presetCalmSub">每天 +1,000 IMD</small>`,
  ],
  [
    `class="preset">价格下跌 20%<small>IMD 相对 ETH 贬值</small>`,
    `class="preset"><span data-i18n="html.sim.presetDump">价格下跌 20%</span><small data-i18n="html.sim.presetDumpSub">IMD 相对 ETH 贬值</small>`,
  ],
  [
    `class="preset">什么都不发生<small>维持现状</small>`,
    `class="preset"><span data-i18n="html.sim.presetFlat">什么都不发生</span><small data-i18n="html.sim.presetFlatSub">维持现状</small>`,
  ],
  [
    `class="preset">自定义<small>自己调下面三个滑块</small>`,
    `class="preset"><span data-i18n="html.sim.presetCustom">自定义</span><small data-i18n="html.sim.presetCustomSub">自己调下面三个滑块</small>`,
  ],
  [`<label>每天有多少 IMD 被卖进池子（净流入）</label>`, `<label data-i18n="html.sim.inflowLabel">每天有多少 IMD 被卖进池子（净流入）</label>`],
  [`<div class="hint">有人卖出 IMD，池子里囤的量就增加，离触发线更近</div>`, `<div class="hint" data-i18n="html.sim.inflowHint">有人卖出 IMD，池子里囤的量就增加，离触发线更近</div>`],
  [`<label>假设 IMD 相对 ETH 的价格变动</label>`, `<label data-i18n="html.sim.priceLabel">假设 IMD 相对 ETH 的价格变动</label>`],
  [
    `<div class="hint">IMD 贬值时，池子里囤的 IMD 数量会变多，更容易触发</div>`,
    `<div class="hint" data-i18n="html.sim.priceHint">IMD 贬值时，池子里囤的 IMD 数量会变多，更容易触发</div>`,
  ],
  [`<label>按这个速度持续多少天</label>`, `<label data-i18n="html.sim.daysLabel">按这个速度持续多少天</label>`],
  [
    `<div class="hint">用来估算这段时间里会触发几次、总共烧掉多少</div>`,
    `<div class="hint" data-i18n="html.sim.daysHint">用来估算这段时间里会触发几次、总共烧掉多少</div>`,
  ],
  [`<span class="muted">天</span>`, `<span class="muted" data-i18n="html.sim.daysUnit">天</span>`],
  [
    `<summary>给技术读者的细节：模拟器的数学依据与已知简化</summary>`,
    `<summary data-i18n="html.sim.techSummary">给技术读者的细节：模拟器的数学依据与已知简化</summary>`,
  ],
  [`      <div class="note" style="margin-top:10px">\n        <code>held = L ×`, `      <div class="note" style="margin-top:10px" data-i18n-html="html.sim.techBody">\n        <code>held = L ×`],

  // ---- trim now ----
  [`<h2>如果现在触发，会烧掉多少</h2>`, `<h2 data-i18n="html.trimnow.title">如果现在触发，会烧掉多少</h2>`],
  [
    `    <div class="note">\n      <b>取整说明：</b>`,
    `    <div class="note" data-i18n-html="html.trimnow.note">\n      <b>取整说明：</b>`,
  ],

  // ---- rewards ----
  [`<h2>质押收益为什么是零</h2>`, `<h2 data-i18n="html.rewards.title">质押收益为什么是零</h2>`],
  [
    `    <p class="lede">\n      <b>这意味着什么：</b>烧毁停了，分给质押者的那 15%`,
    `    <p class="lede" data-i18n-html="html.rewards.lede">\n      <b>这意味着什么：</b>烧毁停了，分给质押者的那 15%`,
  ],
  [
    `<summary>给技术读者的细节：三桶分配与滞留原因</summary>`,
    `<summary data-i18n="html.rewards.techSummary">给技术读者的细节：三桶分配与滞留原因</summary>`,
  ],
  [
    `      <div class="note" style="margin-top:10px">\n        <code>RewardDistributor</code> 把奖励按`,
    `      <div class="note" style="margin-top:10px" data-i18n-html="html.rewards.techBody">\n        <code>RewardDistributor</code> 把奖励按`,
  ],

  // ---- sIMD ----
  [`<h2>sIMD 质押凭证</h2>`, `<h2 data-i18n="html.simd.title">sIMD 质押凭证</h2>`],
  [
    `    <p class="lede">\n      <b>这意味着什么：</b>下面这个兑换比例`,
    `    <p class="lede" data-i18n-html="html.simd.lede">\n      <b>这意味着什么：</b>下面这个兑换比例`,
  ],
  [
    `font-size:13.5px;margin-bottom:6px">这个比例是怎么来的</div>`,
    `font-size:13.5px;margin-bottom:6px" data-i18n="html.simd.explainTitle">这个比例是怎么来的</div>`,
  ],

  // ---- history ----
  [`<h2>烧毁的历史</h2>`, `<h2 data-i18n="html.history.title">烧毁的历史</h2>`],
  [
    `      数据来源：对合约完整生命周期的日志扫描，共 <span id="hist-count">—</span> 次事件，覆盖区块 <span id="hist-range">—</span>。`,
    `      <span data-i18n="html.history.srcBefore">数据来源：对合约完整生命周期的日志扫描，共</span> <span id="hist-count">—</span> <span data-i18n="html.history.srcMid">次事件，覆盖区块</span> <span id="hist-range">—</span>。`,
  ],
  [
    `<span><i style="background:var(--dead)"></i>每次抽走并烧毁的 IMD</span>`,
    `<span><i style="background:var(--dead)"></i><span data-i18n="html.history.legend1">每次抽走并烧毁的 IMD</span></span>`,
  ],
  [
    `<span><i style="background:var(--live)"></i>价格下限保护平仓时烧毁的 IMD</span>`,
    `<span><i style="background:var(--live)"></i><span data-i18n="html.history.legend2">价格下限保护平仓时烧毁的 IMD</span></span>`,
  ],
  [`margin-bottom:8px">烧毁速率</div>`, `margin-bottom:8px" data-i18n="html.history.burnrateLabel">烧毁速率</div>`],

  // ---- owner ----
  [`<h2>owner 能做什么</h2>`, `<h2 data-i18n="html.owner.title">owner 能做什么</h2>`],
  [
    `<summary>给技术读者的细节：全部权限函数、源码行号与作者注释原文</summary>`,
    `<summary data-i18n="html.owner.techSummary">给技术读者的细节：全部权限函数、源码行号与作者注释原文</summary>`,
  ],

  // ---- parameter monitor ----
  [`<h2>参数变更监控</h2>`, `<h2 data-i18n="html.monitor.title">参数变更监控</h2>`],
  [
    `    <p class="lede">\n      <b>这意味着什么：</b>只要 owner 改一个参数`,
    `    <p class="lede" data-i18n-html="html.monitor.lede">\n      <b>这意味着什么：</b>只要 owner 改一个参数`,
  ],
  [`<summary>变更历史（本机记录）</summary>`, `<summary data-i18n="html.monitor.techSummary">变更历史（本机记录）</summary>`],

  // ---- data sources ----
  [`<h2>数据从哪来</h2>`, `<h2 data-i18n="html.sources.title">数据从哪来</h2>`],
  [
    `    <p class="lede">\n      <b>这意味着什么：</b>每个数字都能自己复核。`,
    `    <p class="lede" data-i18n-html="html.sources.lede">\n      <b>这意味着什么：</b>每个数字都能自己复核。`,
  ],
  [
    `<summary>给技术读者的细节：源码基准与行号对照</summary>`,
    `<summary data-i18n="html.sources.techSummary">给技术读者的细节：源码基准与行号对照</summary>`,
  ],
  [
    `      <div class="note" style="margin-top:10px">\n        源码行号对应链上已验证的`,
    `      <div class="note" style="margin-top:10px" data-i18n-html="html.sources.techBody1">\n        源码行号对应链上已验证的`,
  ],
  [
    `        <br>池 ID 可自行验证：<code>keccak256(abi.encode(PoolKey))</code>，池 B = <code id="poolid-b">—</code>。`,
    `        <br><span data-i18n="html.sources.techBody2">池 ID 可自行验证：<code>keccak256(abi.encode(PoolKey))</code>，池 B = </span><code id="poolid-b">—</code>。`,
  ],

  // ---- footer ----
  [
    `    <p>\n      <b data-i18n="html.footer.readonly1">只读仪表盘。</b>`,
    `    <p data-i18n-html="html.footer.readonly">\n      <b>只读仪表盘。</b>`,
  ],
  [
    `    <p>\n      <b>只读仪表盘。</b>不连接钱包、不签名、不发交易。`,
    `    <p data-i18n-html="html.footer.readonly">\n      <b>只读仪表盘。</b>不连接钱包、不签名、不发交易。`,
  ],
  [
    `<p class="tiny">独立观察工具，与 IdentityMD / POOL4 项目方无关，未经其审阅。不构成投资建议。</p>`,
    `<p class="tiny" data-i18n="html.footer.disclaimer">独立观察工具，与 IdentityMD / POOL4 项目方无关，未经其审阅。不构成投资建议。</p>`,
  ],
  [
    `<a href="#" id="quote-25901450" data-block="25901450" target="_blank" rel="noopener">在 Etherscan 查看原文 ↗</a>`,
    `<a href="#" id="quote-25901450" data-block="25901450" target="_blank" rel="noopener" data-i18n="html.what.quoteLink">在 Etherscan 查看原文 ↗</a>`,
  ],
];

const target = "index.html";
let html = readFileSync(ROOT + target, "utf8");
const problems = [];
let applied = 0;
let skipped = 0;

for (const [from, to] of EDITS) {
  // idempotent: re-running after a partial application must not fail on the entries
  // that already landed.
  if (html.includes(to)) {
    skipped++;
    continue;
  }
  const first = html.indexOf(from);
  if (first < 0) {
    problems.push(`NOT FOUND: ${from.slice(0, 70).replace(/\n/g, "\\n")}`);
    continue;
  }
  if (html.indexOf(from, first + 1) >= 0) {
    problems.push(`NOT UNIQUE: ${from.slice(0, 70).replace(/\n/g, "\\n")}`);
    continue;
  }
  html = html.slice(0, first) + to + html.slice(first + from.length);
  applied++;
}

if (!dry) writeFileSync(ROOT + target, html);
console.log(`edits applied : ${applied} / ${EDITS.length}  (already in place: ${skipped})`);
if (problems.length) {
  console.log(`problems      : ${problems.length}`);
  for (const p of problems) console.log(`  ${p}`);
}
if (dry) console.log("(dry run — nothing written)");
process.exit(problems.length ? 1 : 0);
