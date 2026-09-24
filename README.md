# POOL4 · 烧毁引擎状态仪表盘

一个**只读**的静态站点，回答一个官方页面没有回答的问题：

> **POOL4 的烧毁引擎还在工作吗？如果停了，还差多少才会重新点火？**

以太坊主网上 IMD 的 Uniswap v4 hook `CappedBurnHook` 会在池内 IMD 超过 `inventoryCap` 时，
把超出部分移出并按 **85% 永久烧毁 / 15% 奖励分账** 拆分。这个仪表盘把该机制的**当前状态**、
**点火距离**、**历史轨迹**和**风险面**全部摊开，每个数字都能溯源到合约地址 + 函数名 + 源码行号。

**不连接钱包、不签名、不发交易。** 全部数据来自 `eth_call` 与公共 RPC。

---

## 快速开始

```bash
# 需要 Node 20+。项目零运行时依赖，不需要 npm install。
node scripts/serve.mjs          # → http://127.0.0.1:5173/
```

打开浏览器即可。页面每 60 秒自动刷新，显示最后更新时间和区块号。

也可以直接部署 `index.html` / `assets/` / `lib/` / `data/` 这四个路径到任何静态托管
（Cloudflare Pages、Vercel、Netlify、S3、GitHub Pages 均可），无需构建步骤。

---

## 部署

站点是**纯静态**的，没有构建步骤、没有服务端逻辑。把仓库根目录整体部署即可。

### Cloudflare Pages

```bash
npx wrangler pages deploy . --project-name pool4-dashboard
```

根目录的 `_headers` 会被自动读取（缓存策略 + 安全头）。

### Vercel

```bash
npx vercel --prod
```

### 任意静态托管 / 自建 nginx

上传 `index.html`、`assets/`、`lib/`、`data/`、`_headers` 即可。
注意 **`lib/` 与 `data/` 必须保持在根目录下的同名路径** —— 页面用相对路径 `../lib/…` 引用它们。

### 立即公开预览（无需任何账号）

```bash
node scripts/serve.mjs 5173
# 另开一个终端：
npx cloudflared tunnel --url http://127.0.0.1:5173
```

云隧道会打印一个 `https://xxx.trycloudflare.com` 地址，任何人可访问。
**这是临时的**：进程退出即失效，Cloudflare 不保证可用性。持久发布请用上面的 Pages / Vercel。

### 部署后必须确认三件事

1. 页面顶部状态条显示**区块号在推进** —— 说明浏览器成功连上了 RPC。
2. 浏览器控制台**没有 CORS 报错**。内置的 8 个 L1 端点与 8 个 Base 端点都返回
   `Access-Control-Allow-Origin: *`（已逐一实测），但如果你换成自建节点，需要自己开 CORS。
3. 若显示「读不到链上数据」，说明当前网络屏蔽了这些公共 RPC —— 换成自己的节点（见下一节）。

---

## 更换 RPC

页面在浏览器里直接调用公共 RPC。端点列表定义在 **`lib/evm.js` 的 `DEFAULT_RPCS`**：

```js
export const DEFAULT_RPCS = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.drpc.org",
  "https://gateway.tenderly.co/public/mainnet",
  "https://eth-mainnet.public.blastapi.io",
  "https://rpc.mevblocker.io",
  "https://eth-pokt.nodies.app",
  "https://1rpc.io/eth",
  "https://rpc.flashbots.net",
];
```

读取时按顺序尝试：第一个成功的端点会被记住，后续请求优先用它；失败则自动切到下一个。
页面顶部的状态条会显示当前端点与失败项数量。

**换成自己的 RPC**：直接编辑这个数组，把自建节点（Alchemy / Infura / QuickNode / 本地 geth）
放在第一位即可。不需要 API key 的公共端点在上面这些之外还有若干，但注意：

- `eth_getLogs` 在多数免费端点上受限（`publicnode` 403、`drpc` 400、`1rpc`/`pokt` 50 区块上限）。
  历史索引脚本因此使用 `tenderly` / `mevblocker` 的 ~1000 区块窗口并自适应分块。
- **归档查询**（对历史区块做 `eth_call`）只有 `drpc` / `tenderly` / `blastapi` / `mevblocker` / `pokt` 支持；
  `publicnode` 需要付费 token，`1rpc` 不支持。回放脚本用的是这份列表。
- Base 侧的端点在 **`lib/contracts.js` 的 `BASE.rpcs`**。官方 `mainnet.base.org` 限流很严，放在最后。

命令行脚本接受额外端点作为参数，会插到列表最前面：

```bash
node scripts/collect.mjs https://your-own-node.example.com
```

---

## 页面在说什么

六条核心结论（都能在页面上找到出处）：

1. **引擎熄火，但池子活着。** 最后一次 trim 在区块 25964166（约 10 天前），
   而 `FeeCollected` / `DeploymentFloorUpdated` 一直活跃到当前区块。
2. **烧毁有两道门。** 以太坊侧的 trim 是第一道（当前熄火）；真正的 `burn()` 发生在 Base 侧，
   需要有人主动调用 `bridgeToBaseBurnReceiver()` 再调 `burn()`。**即使引擎恢复，销毁也不会自动发生。**
3. **owner 权限按合约分别认定，不能笼统概括。** StakedIMD 已于 2026-09-19 放弃所有权
   （`owner() = 0x0`，经**交易回执 + 归档 `owner()` + 当前值**三重验证），质押资金不再可被提取或冻结；
   但**其余 5 个合约仍由一个普通钱包控制，共 8 项提取/冻结类权限仍然有效**，含 `closeMarket()`。
4. **sIMD 的 7.92 是账面比率，不是收益率。** 其中约 96.8% 来自金库部署初期的一次性注入。
5. **Σrewarded/Σtotal 会 floor 到 1499 bps**，但单次拆分精确等于 1500 bps —— 页面就地注明原因。
6. **有一笔待桥接的钱。** `BurnExecutor` 持有约 20.26 IMD 尚未桥到 Base。

另有一块 **链上留言面板**：项目方没有 Twitter 公告、官网文档仍是 “Coming soon”，
他只在链上发留言（并公开鼓励别人做监控工具）。面板按时间倒序展示全部可读留言，
区分项目方与社区、高亮与参数/权限/经济相关的条目 —— 其中最新一条（2026-09-21）明确预告了要改 pool4 设置。

面板下面附一节 **「教程：怎么给项目方发一条链上留言」**：留言板是一个普通 EOA，
留言就是一笔发往它的、data 里写着 UTF-8 文本的 0 ETH 转账。教程写清了四步
（写文本 → 钱包发起转账到 `0x200E…0fB1`、金额 0 → 把文本填进钱包的 *Hex data* 字段 → 发送、gas 自付）、
三条注意（公开永久、发送地址会被记录、本页只读不代发），并带一个**纯前端**的
「文本 → calldata 十六进制」转换器（`assets/app.js` 的 `initHexTool()`，用 `TextEncoder`，
不联网、不上传）。

**留言列表默认只渲染最新 6 条**，其余收在「显示全部 N 条」按钮后面（`MSG_PAGE`）——
70 多条、每条都是多行英文原文，全展开会把「证据」变成一场没有尽头的滚动。
上面的筛选器（全部 / 项目方 / 社区 / 重点）始终作用于**全集**，切换筛选会重新折叠。

源码级机制说明（含每条的源码行依据、交叉验算、历史回放对账、以及 §12 的更正记录）在 **[`NOTES.md`](NOTES.md)**。

---

## 数据来源清单

页面上的每个数字都带一个 ⓘ 标记，悬停/聚焦会显示来源。汇总如下。

### 以太坊主网（chainId 1）

| 数据 | 合约 | 函数 | 源码行 |
| --- | --- | --- | --- |
| 池内 IMD / ETH | CappedBurnHook `0xc6c9…2840` | `tokensInPool()` / `ethInPool()` | L337-350 |
| **点火距离（权威值）** | 同上 | `pendingTrim()` | L352-357 |
| cap / 地板 / 衰减 | 同上 | `inventoryCap()` / `capFloor()` / `capDecayTokensPerDay()` | L224 / L138 / L152 |
| 棘轮参数 | 同上 | `ratchetBps()` | L136 |
| 烧毁 / 奖励账本 | 同上 | `totalBurned()` / `totalRewarded()` | L227-228 |
| 85/15 比例 | 同上 | `rewardShareBps()` | L126（硬上限 L127） |
| backstop 状态 | 同上 | `backstopIsFilled()` / `backstopConvertedEth()` / `backstopEthPrincipal()` | L393 / L362 / L176 |
| 参考价 | 同上 | `refTick()` / `deploymentFloorTick()` | L195 / L211 |
| 待桥接余额 | BurnExecutor `0xe293…c750` | `tokenBalance()` | L126-128 |
| 桥接预览 | 同上 | `previewBridge()` | L208-214 |
| 奖励可释放量 | RewardDripper `0xe6D3…0884` | `drippable()` / `canDrip()` | L105-118 |
| 三桶分配 | RewardDistributor `0x9046…CA30` | `stakingEarned()` / `heldBonding()` / `heldNft()` | L28-33 |
| sIMD 账面比率 | StakedIMD `0x9efa…7247` | `totalAssets()` / `totalSupply()` / `decimals()` | ERC4626 / L68-70 |
| IMD 总供应 | $IMD (`BridgedFP`) `0xD34a…3B7` | `totalSupply()` | ERC20 |
| 池价与流动性 | StateView `0x7ffe…7227` | `getSlot0(poolId)` / `getLiquidity(poolId)` | — |
| ETH/USD | Chainlink `0x5f4e…8419` | `latestRoundData()` | — |
| owner 行为 | EOA `0x047F…54B7` | `eth_getTransactionCount` | — |

### Base（chainId 8453）

| 数据 | 合约 | 函数 |
| --- | --- | --- |
| 被销毁的代币总量 | Fren Pet `0xff0c…e105` | `totalSupply()` |
| OFT 适配器锁定余额 | 同上 | `balanceOf(0xab15…690a)` |
| 销毁接收器余额 | 同上 | `balanceOf(0xf9d7…6793)` |

### 预生成的历史数据（静态 JSON）

| 文件 | 内容 | 生成方式 |
| --- | --- | --- |
| `data/timeline.json` | 全部 trim 与 backstop 平仓事件、关键里程碑、区块时间戳 | `node scripts/index-logs.mjs && node scripts/build-data.mjs` |
| `data/base.json` | Base 侧 51 次销毁与 L1 侧 59 次桥接的时间线 | 同上 |
| `data/volume.json` | 过去 24h 两个 IMD 池的 Swap 笔数与 ETH 侧流量 | `node scripts/scan-swaps.mjs 24` |
| `data/messages.json` | 链上留言全量（项目方 + 社区），含重点标记 | `node scripts/fetch-messages.mjs` |
| `data/messages.zh.json` | 留言的中文摘要（按区块号索引，`reviewed` 可人工校对；**不是**抓取产物） | 人工 / AI 预生成 |
| `data/bridge-history.json` | 待桥接队列的 6 个历史采样点（由 Transfer 日志重建，不依赖 archive 节点） | `node scripts/fetch-bridge-history.mjs` |
| `data/baseline.json` | 最近一次完整快照（用于离线核对，含 `derived` 全量字段） | `node scripts/collect.mjs` |
| `data/history.json` | 原始事件索引（7 MB，`timeline.json`/`base.json` 的上游） | `node scripts/index-logs.mjs` |

页面在运行时轮询的是**链上实时值**；历史曲线与交易量来自这些预生成文件，并标注了扫描截止区块。

这些文件由 GitHub Actions 每小时刷新一次，**校验通过才会替换**；本地跑同一套流程：

```bash
node scripts/refresh-snapshots.mjs          # 生成到临时目录 → 校验 → 通过才替换
node scripts/verify-snapshots.mjs           # 只校验 data/ 里现有的快照
```

细节（校验规则、失败行为、页面上的过期横幅、CI 端点覆盖）见 `HANDOFF.md` 的「快照刷新」一节。

---

## 两种语言

中文是默认语言，右上角切换；`?lang=en` 直接进英文，选择记在 `localStorage`。

- 全部界面文案在 `locales/zh.json` 与 `locales/en.json`，键一一对应（`check.mjs` 断言两边键集相同、
  占位符数量相同、英文值里没有中文）。
- `index.html` 的静态文案（标题、导语、表头）用 `data-i18n` / `data-i18n-html` 接线；
  `check-html-i18n.mjs` 会列出任何「切换英文后仍然是中文」的节点。
- `assets/app.js` 与 `lib/contracts.js` 的字符串字面量里**不允许出现中文**：
  数据层存的是键名（`owner.role.simd`），渲染时由 `td()` 翻译。这条断言在 `check.mjs` 里。
- **链上留言是证据，英文原文一字不改**：两种语言下都显示原文；中文模式在下方追加摘要，
  前缀写明「非官方译文」，原文用等宽引用块、摘要用常规小字（字体 + 颜色双重区分，手机上也能分辨）。
  摘要存放在 `data/messages.zh.json`，按区块号索引，可人工校对。
- 切换语言会重渲染整页，`test-render.mjs` 在切换后扫描整份 DOM：不允许残留中文，也不允许出现裸键名。

新增一句话的流程：改 `data/_*.json` 文案源（人工维护，merge 时覆盖 locales）→ `node scripts/merge-i18n.mjs`。
新增一段界面文案的流程见 `HANDOFF.md` 的「双语架构」一节。

---

## 主题

页面**默认浅色**（白天模式）。右上角「深色 / 浅色」按钮切换，选择记在 `localStorage`
（键名 `pool4.theme`），并由 `<head>` 里一段同步内联脚本在**首次绘制之前**应用 ——
否则选了深色的人每次导航都会先看到一次白闪。

配色全部走 `assets/style.css` 顶部的语义变量：`:root` 是浅色，
`html[data-theme="dark"]` 一个覆盖块就是深色主题。没有第二份样式表，
也没有按组件写的深色特例 —— 新增一个颜色时，先在 `:root` 定义语义变量，再在深色块里给值。

---

## 页面是怎么组织的

读者是 IMD 持币者与 sIMD 质押者，不是合约开发者。所以页面**默认只显示结论**，
源码级细节全部收进折叠区，一个都没删。

从上到下的层级：

1. **30 秒摘要** —— 发生了什么 / 影响我什么 / 什么时候恢复 / 一件该知道的风险，
   外加一张**位置图**：池内 IMD 相对烧毁触发线的进度条（标出棘轮下限），
   下面是最近 24 次烧毁的柱状图 —— 引擎一停，这张图就是平的，不用读任何数字就能看出来
2. **这是什么** —— 一段大白话交代背景，不假设读者读过合约
3. **证据**（现状、熄火时间线、两道门、池 A 对照、链上留言 + 发消息教程）
4. **机制**（当前数据、模拟器、拆分、奖励流、sIMD、历史）
5. **权限**（owner 能做什么、参数变更监控）
6. **数据**（来源清单 + 源码基准）

这六块被收进**五个默认收起的折叠条**（结论 / 证据 / 机制 / 权限 / 数据）：
带边框、阴影、左侧三角和右侧「展开 / 收起」胶囊，悬停会高亮。
点顶部导航胶囊不只是跳转 —— 它**先展开对应分组**，再把分组滚到吸顶头部下方，
并短暂高亮一次（`scroll-padding-top` 负责让标题不落在头部底下）。

约定：

- 每个区块开头都有一句「**这意味着什么**」。
- 术语默认用人话，源码名放进括号或折叠区（例如「烧毁触发线（源码：`inventoryCap`）」）。
- 每个数字旁的 <span>i</span> 标记可点开，显示合约地址 + 函数名 + 源码行号。
- 技术细节用「+ / −」的折叠块收在同一页里，收起时也是一条明显的可点条，不是一条灰字。
- 取不到的数据显示「取不到」并说明原因 —— 不显示 0，因为 0 是一个具体的断言。

---

## 项目结构

```
index.html              页面骨架（无框架；静态文案挂 data-i18n，见下）
assets/style.css        浅色主题（默认）+ 深色覆盖块，移动端优先
assets/app.js           渲染 + 60s 轮询 + 参数变更监控
locales/zh.json         中文文案（默认语言）
locales/en.json         英文文案，键与 zh 一一对应
lib/evm.js              零依赖 EVM 工具：keccak-256、ABI 编解码、多端点 RPC 客户端
lib/contracts.js        合约注册表、ABI、数据采集、owner 权限清单、来源映射
lib/i18n.js             语言解析 / t() / 复数 / 日期与数字本地化 / applyStatic()
lib/simulate.js         前瞻模拟器（纯函数，可单元测试）
lib/html-scan.js        扫描 index.html 里没接线的中文（英文模式会漏出来的那些）
lib/scan-strings.js     字面量扫描与模板 ${} 参数提取（i18n 迁移工具链的底座）
scripts/serve.mjs            本地静态服务器
scripts/shoot.mjs            整页截图（中英各一份，走 DevTools 协议）
scripts/refresh-snapshots.mjs    刷新五份快照：生成到临时目录 → 校验 → 通过才替换
scripts/verify-snapshots.mjs     快照校验：形状 + 数值量级 + 「不能倒退」
scripts/make-base-fixture.mjs    从真实事件生成离线 fixture（data/_fixture-base.json）
scripts/test-build-data.mjs      用 fixture 在无网络环境下跑通 build-data 的完整路径
scripts/verify-live-site.mjs     打开部署站点，把页面显示的数字与链上直读逐项对比
scripts/collect.mjs          实时快照 → data/baseline.json
scripts/index-logs.mjs       分块 eth_getLogs 全历史索引 → data/history.json
scripts/build-data.mjs       生成前端用的精简数据 → data/timeline.json, data/base.json
scripts/scan-swaps.mjs       过去 24h 两个池的 Swap 流量 → data/volume.json
scripts/fetch-messages.mjs   链上留言全量抓取 → data/messages.json
scripts/fetch-bridge-history.mjs  Transfer 日志重建待桥接队列历史 → data/bridge-history.json
scripts/check-derived.mjs        derived 字段量级审计（含对已知错误值的反向验证）
scripts/check-summaries.mjs      留言原文与中文摘要的对照单
scripts/extract-strings.mjs      扫描中文字面量 → data/strings-todo.json
scripts/build-i18n-skeleton.mjs  字面量 → 键与参数骨架
scripts/merge-i18n.mjs           骨架 + data/_*.json 文案源 → locales/*.json
scripts/apply-i18n.mjs           把 tr("键") 写回 app.js
scripts/wire-html-i18n.mjs       给 index.html 的静态文案挂 data-i18n
scripts/retag-data-strings.mjs   lib/contracts.js 里的中文 → 键名
scripts/check-terminology.mjs    术语表跨语言一致性
scripts/replay.mjs           用归档 eth_call 回放真实 trim 并对账
scripts/verify-ownership.mjs     三重验证各合约的 owner 状态
scripts/audit-owner-powers.mjs   逐项核对权限清单是否与链上所有权一致
scripts/simd-ratio-history.mjs  sIMD 账面比率成因的归档采样（NOTES §13 的证据）
scripts/verify-two-doors.mjs    两道门管线的链上取证（NOTES §6 的证据）
scripts/selftest.mjs         keccak / ABI 已知答案自测（向量由 ethers v6 独立生成）
scripts/test-simulate.mjs    模拟器单测 + 真实历史 trim 端到端复现
scripts/test-state-machine.mjs  状态机断言（熄火 ⇄ 恢复 的翻转条件）
scripts/test-bridge.mjs      第二道门趋势判定 + 「待桥接 ≠ 已销毁」的措辞断言
scripts/test-render.mjs      无头渲染测试（最小 DOM stub + 真实网络 + 中英切换）
scripts/check.mjs            静态一致性检查 + 只读保证审计 + 文案覆盖
scripts/check-html-i18n.mjs  index.html 静态文案的 i18n 覆盖率
scripts/preview-live.mjs     合成 LIVE 数据，断言恢复后不残留「已停」
```

---

## 验证

```bash
node scripts/selftest.mjs            # keccak-256 / ABI 编解码 / 模板参数提取 / 快照新鲜度（46 项）
node scripts/check.mjs               # id 接线、禁用内容、只读方法、中文字面量归零、文案覆盖（26 项）
node scripts/check-derived.mjs       # derived 字段的量级审计 + 用已知错误值反向验证检查本身（13 项）
node scripts/test-simulate.mjs       # 模拟器数学 + 用真实历史 trim 复现链上事件（35 项）
node scripts/test-state-machine.mjs  # 状态机：熄火 ⇄ 恢复 的翻转条件（18 项）
node scripts/test-bridge.mjs         # 第二道门趋势判定 + 「待桥接 ≠ 已销毁」措辞（24 项）
node scripts/check-html-i18n.mjs     # index.html 中会漏进英文模式的中文（应为 0）
node scripts/check-terminology.mjs   # 术语表跨语言一致性（--sample 打印 10 组中英对照）
node scripts/check-summaries.mjs     # 链上留言原文与中文摘要并列，供人工校对
node scripts/test-build-data.mjs     # build-data 全流程离线跑通（fixture 覆盖本机不可达的 Base 段）
node scripts/verify-snapshots.mjs    # 快照形状 + 「不能倒退」（刷新流程的守门人）
node scripts/preview-live.mjs        # 合成 LIVE 数据，确认恢复后不残留「已停」（16 项）
node scripts/test-render.mjs         # 无头渲染：每个区块都产出内容 + 切到英文后无中文、无裸键名（126 项）
node scripts/verify-ownership.mjs    # 三重验证各合约 owner（含 sIMD 的 renounce）
node scripts/audit-owner-powers.mjs  # 权限清单与链上所有权逐项比对
node scripts/replay.mjs 3            # 归档回放最近 3 次 trim 并与 totalBurned() 对账
node scripts/verify-two-doors.mjs    # 两道门管线的链上取证
node scripts/simd-ratio-history.mjs  # sIMD 账面比率的成因采样
```

`npm test` 跑上面除取证类之外的全部。

交付截图（本机需有 Chrome / Edge）：

```bash
node scripts/serve.mjs 5173
node scripts/shoot.mjs --out shots --url http://127.0.0.1:5173
# → shots/pool4-zh-full.png（整页长图）、shots/pool4-zh-1..N.png（全分辨率分段）以及英文各一份
```

验证**已部署的站点**（页面显示值 vs 链上直读，逐项对比；容差写在脚本里）：

```bash
node scripts/verify-live-site.mjs                                   # 默认 https://imd.kymmppee.xyz
node scripts/verify-live-site.mjs --url http://127.0.0.1:5173
```

当前状态：**399 项断言全部通过**（13 个套件：46 + 26 + 13 + 21 + 8 + 31 + 19 + 16 + 35 + 18 + 24 + 16 + 126，
另加 `check-html-i18n.mjs` / `check-terminology.mjs` 的覆盖率报告与各取证脚本的自校验）。

`check.mjs` 会审计所有脚本用到的 JSON-RPC 方法，确保只有
`eth_call` / `eth_getLogs` / `eth_getBlockByNumber` / `eth_getTransactionCount` /
`eth_getBalance` / `eth_getCode` / `eth_blockNumber` / `eth_chainId`
—— 没有任何签名或写入路径。

### 手工复核

每个数字都可以在 Etherscan 的 Read Contract 页面直接核对：点数字旁的 ⓘ 拿到合约地址，
打开 `https://etherscan.io/address/<地址>#readContract`，调用对应函数。

池 ID 也可以自己验证：

```
PoolKey = {currency0: 0x0, currency1: 0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7,
           fee: 10000, tickSpacing: 60, hooks: 0xc6c965bd164c483e87d0b550671798e9a3602840}
poolId  = keccak256(abi.encode(PoolKey))
        = 0x415829f72e9f54531c26eae76f107618540e898a45d6ae35959e143f5faca704
```

---

## 明确不做的事

- ❌ 不写合约、不连钱包、不发交易 —— 只读
- ❌ 不使用官网的 782,132% APR（那是前端 bundle 里的常量 `APR_LAUNCH_RATE`，站点自己标注 "not what stakers earn today"）
- ❌ 不把 sIMD 的 7.92 账面比率当收益率
- ❌ 不做 swap 界面
- ❌ 不用占位数字填满版面 —— 取不到就显示「取不到」并说明原因

---

## 免责声明

这是一个**独立**的只读观察工具，与 IdentityMD / POOL4 项目方无关，未经其审阅。
所有数据来自公开的链上状态与已验证源码；结论都可以按上面「手工复核」一节自行验证。
本页不构成投资建议。
