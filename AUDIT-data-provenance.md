# pool4-dashboard 数据来源审计（只读）

审计对象：`D:\imd\pool4-dashboard`。审计方式：静态阅读，未修改任何文件，未运行任何写文件脚本。

判定基准：

- **LIVE** = 每次 `tick()` 调用 `collect(rpc, ...)`（`lib/contracts.js:541`），走 `eth_call` / `eth_getBlockByNumber` / `eth_getTransactionCount` / `eth_getBalance` 取链上实时值。
- **STATIC** = `boot()` 在页面加载时 `fetch()` 一次 `data/*.json`，之后**永不重新获取**（`assets/app.js:218-231`）。
- **MIXED** = 同一数据块内混用两者。

---

## 0. 两个决定性的常量

| 常量 | 值 | 位置 | 含义 |
| --- | --- | --- | --- |
| `REFRESH_MS` | `60_000`（60 秒） | `assets/app.js:18` | 实时块的轮询间隔 |
| `BASE_EVERY` | `5` | `assets/app.js:20` | Base 链读数每 5 个 tick（≈5 分钟）读一次 |
| `STALE_AFTER_HOURS` | `3` | `assets/app.js:22` | 快照年龄超过 3 小时才弹横幅 |
| `setInterval(tick, 1000)` | 1 秒 | `assets/app.js:295` | tick 每秒跑，但靠 `state.nextAt` 节流到 60 秒 |
| CI cron | `"17 * * * *"` | `.github/workflows/refresh-snapshots.yml:22` | 静态快照每小时刷新 |

**关键结构事实**：`state.timeline` / `state.baseData` / `state.volume` / `state.messages` / `state.messagesZh` / `state.bridgeSnapshot` 这 6 个字段**只在 `boot()` 里赋值一次**（`app.js:226-231`），此后 `tick()` 循环中**没有任何一处重新 fetch**。它们一旦载入就永久冻结在页面生命周期内。

---

## 1. 逐块判定表

### 1.1 顶部区（`<header class="top">` + 横幅）

| # | block_id | 显示内容 | 来源类型 | 具体来源 | 刷新频率 | 陈旧风险 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `#statusline` → `#st-rpc` / `#st-block` / `#st-updated` | RPC 健康点、最新区块号、本次读数时间 | **LIVE** | `snap.blockNumber`、`snap.fetchedAt`、`snap.errors`（`app.js:1185-1201`）← `collect()` 内 `rpc.getBlock("latest")`（`contracts.js:546`） | 每 60 秒 | 无（RPC 失败时有 `#rpc-banner` 报错） |
| 2 | `#statusline` → `#st-next` | 倒计时秒数 | **LIVE** | `state.nextAt` 本地计时器（`app.js:383-385`） | 每 1 秒重绘 | 不适用 |
| 3 | `#rpc-banner` | RPC 失败 / 部分读数失败 / 渲染器抛错 | **LIVE** | `state.lastError`、`snap.errors`、`snap.base.errors`、`renderFailures`（`app.js:1237-1306`） | 每 60 秒 | 无 |
| 4 | `#stale-banner` | 快照过期告警横幅 | **STATIC（元数据）** | `oldestSnapshot({timeline, base, volume, messages, "bridge-history"})`（`app.js:1215-1221`）→ 读各 JSON 的 `builtAt`/`scannedAt`/`fetchedAt` | 每 60 秒重算，但输入不变 | **这是唯一的陈旧告警机制**，见 §3 |

### 1.2 结论带 `#conclusion` → `#summary`

| # | block_id | 显示内容 | 来源类型 | 具体来源 | 刷新频率 | 陈旧风险 |
| --- | --- | --- | --- | --- | --- | --- |
| 5 | `#sum-headline` | 一句话结论（"已停止"/"贴着触发线"/"正在烧毁"） | **LIVE** | `snap.derived.state`、`hold`/`cap`/`pendingTrim`（`app.js:864-875`） | 每 60 秒 | 无 |
| 6 | `#state-flip` | 状态翻转横幅 | **LIVE + localStorage** | `state.stateFlip` ← `buildFlipEntry()` 对比前后两次 `snap`（`app.js:342-352`, `478-519`）；持久化在 `pool4.stateflip.v1` | 状态变化时 | 本机记录，依赖页面曾打开过 |
| 7 | `#sum-visual` → 仪表盘（gauge） | 池内 IMD / 触发线 / 下限 / 点火距离条 | **LIVE** | `values["hook.tokensInPool"]`、`["hook.inventoryCap"]`、`derived.floor`（`app.js:739-791`） | 每 60 秒 | 无 |
| 8 | **`#sum-visual` → 燃烧活动条（最近 24 次烧毁柱状图）** | 最近 24 次 trim 的柱状图 | **STATIC** | **`data/timeline.json` → `trims[]`**（`app.js:795-828` 读 `state.timeline.trims`，`const N = 24`） | 跟随 CI 每小时 | **⚠ 危险**：`app.js:816-819` 注释明确承认"句子和柱子都冻结在同一时刻"，但只有 `mayNotBeLatest()` 为真时才追加 "data as of" 小字（`app.js:820-825`）。CI 停摆但未超 3 小时时，柱状图照常显示，**看不出冻结** |
| 9 | `#sum-impact` | "这意味着什么"要点列表 | **LIVE** | `v["dripper.drippable"]`、`d.state`（`app.js:984-1009`） | 每 60 秒 | 无 |
| 10 | `#sum-recovery` | "什么时候会恢复" | **LIVE** | `v["hook.capDecayTokensPerDay"]`、`d.floor` 等 | 每 60 秒 | 无 |
| 11 | `#sum-risk` | 合约权限现状 | **LIVE** | `v["<contract>.owner"]` vs `ZERO_ADDR`（`app.js:1020-1108`） | 每 60 秒 | 无 |

### 1.3 "这是什么" `#what`

| # | block_id | 显示内容 | 来源类型 | 具体来源 | 陈旧风险 |
| --- | --- | --- | --- | --- | --- |
| 12 | `#what` 正文与引用块 | 机制说明、设计意图引文 | **STATIC（硬编码 HTML）** | `index.html:96-144`，文案写死在 HTML + `locales/*.json` | 不会变，但**含写死的比例与日期**，见 §4 |

### 1.4 证据带 `#evidence` → `#verdict-section`

| # | block_id | 显示内容 | 来源类型 | 具体来源 | 刷新频率 | 陈旧风险 |
| --- | --- | --- | --- | --- | --- | --- |
| 13 | `#verdict-lede` | 状态一句话 | **LIVE** | `d.state` + `onTheLine(d)`（`app.js:1443-1452`） | 60 秒 | 无 |
| 14 | `#v-title` / `#v-state` / `#v-answer` | 标题、徽章、详细答复 | **LIVE** | `d.state`、`v["hook.tokensInPool"/"inventoryCap"/"pendingTrim"]`（`app.js:1334-1421`） | 60 秒 | 无 |
| 15 | **`#v-gap`（点火距离）** | 距重新点火还差多少 IMD | **LIVE** | `d.gapRaw` = `inventoryCap − tokensInPool`（`app.js:1455`；`contracts.js:778`） | 60 秒 | 无 |
| 16 | `#v-gap-alt` | 距离的 ETH / USD 折算 | **LIVE** | `d.gapEth`、`d.gapUsd`、`d.ethUsd` ← `poolB.slot0` + `chainlink.latestRoundData`（`app.js:1458-1464`） | 60 秒 | 无 |
| 17 | `#v-held` / `#v-cap` / `#v-pending` / `#v-floor` | 池内 IMD、触发线、待烧毁量、下限 | **LIVE** | `v["hook.tokensInPool"]` / `["hook.inventoryCap"]` / `["hook.pendingTrim"]` / `["hook.capFloor"]`（`app.js:1466-1471`） | 60 秒 | 无 |
| 18 | `#v-fill` / `#v-cap-label` | 进度条填充与刻度标签 | **LIVE** | `held`/`cap` 比（`app.js:1471-1474`） | 60 秒 | 无 |
| 19 | **`#verdict-section` 内的 `trimAge`** | "上次烧毁在 X 之前" | **STATIC（经 LIVE 判据修饰）** | `state.timeline.blockTime[lastTrim]`（`app.js:1313-1314`），即 `data/timeline.json → blockTime{}` 与 `last.Trimmed` | CI 每小时 | **⚠ 危险**：用 `agoBounded()` 包裹，仅当 `mayNotBeLatest()` 为真才加"或更近"限定。冻结但未越阈值时不加限定 |
| 20 | `#states` | 三种状态的含义卡片 | **LIVE**（数值部分） | `d.held`/`d.cap`/`d.floor`/`d.pendingTrim`（`app.js:1488-1594`） | 60 秒 | 无 |
| 21 | `#state-note` | 状态说明注脚 | **LIVE** | 同上 | 60 秒 | 无 |
| 22 | `#fliplog` | 状态变更历史（本机记录） | **本地 localStorage** | `pool4.fliplog.v1`（`app.js:528-582`） | 事件驱动 | 浏览器本地，非链上 |

### 1.5 链上留言 `#messages-section`

| # | block_id | 显示内容 | 来源类型 | 具体来源 | 刷新频率 | 陈旧风险 |
| --- | --- | --- | --- | --- | --- | --- |
| 23 | `#messages-lede` | 留言数量与最新项目方留言距今天数 | **STATIC** | `state.messages.messages`（`app.js:2505-2518`）← `data/messages.json` | CI 每小时 | **⚠⚠ 最危险项之一**，见 §3 |
| 24 | `#messages-latest` / `#messages-latest-card` | 最新一条项目方留言卡片 | **STATIC** | `data/messages.json → messages[]` 中 `isDev` 第一条（`app.js:2521-2527`） | CI 每小时 | 同上 |
| 25 | `#msgf-all-n` / `-dev-n` / `-community-n` / `-key-n` | 四个筛选器的计数 | **STATIC** | 对 `data/messages.json` 数组做 filter（`app.js:2492-2503`） | CI 每小时 | 同上 |
| 26 | `#messages-list`（链上留言面板） | 留言正文列表（分页 6 条） | **STATIC** | `data/messages.json → messages[]`（`app.js:2530-2537`） | CI 每小时 | 同上 |
| 27 | 留言条目内的时间 | `iso(m.ts)` + `ago(m.ts)` | **STATIC** | 留言自带 `ts`（`app.js:2572-2573`） | CI 每小时 | **无告警包装**：`ago()` 直接算，数字会随时间增长，读起来像"刚刚"之外的自然流逝 |
| 28 | 留言条目的中文摘要 | 中文翻译块 | **STATIC** | `data/messages.zh.json[block].summary`（`app.js:2589-2593`） | CI 每小时 | 仅 `getLang()==="zh"` 时显示 |
| 29 | `#messages-tech` | 抓取计数、dev 地址、抓取时间 | **STATIC** | `data/messages.json → address`/`counts`/`devAddresses`/`fetchedAt`（`app.js:2558-2568`） | CI 每小时 | 会显示 `fetchedAt`，属自曝 |
| 30 | `#howto` | 教程与十六进制转换器 | **纯前端** | `initHexTool()` 本地计算（`app.js` 内） | 即时 | 无 |

> **重大发现**：仓库内存在一整套**已实现但未被接线**的留言实时读取链路 ——
> `lib/messages-live.js`（`scanMessages()` / `mergeMessages()`）与 `lib/messages-follow.js`（`startMessageFollower()`，`POLL_MS = 30_000`）。
> 但 `assets/app.js` **没有 import 它们中的任何一个**（`app.js:8-12` 的 import 列表可证），
> 全仓库对 `startMessageFollower` 的搜索**只有定义处与测试/脚本**，**零生产调用点**。
> `messages-follow.js:105` 会写 `state.messagesLive`，而 `renderMessages()` 读的是 `state.messages`——
> 即使被调用也不会生效。**结论：留言面板 100% 是 STATIC，尽管仓库里有一份"本该是 LIVE"的代码。**

### 1.6 熄火时间线 `#timeline-section`

| # | block_id | 显示内容 | 来源类型 | 具体来源 | 刷新频率 | 陈旧风险 |
| --- | --- | --- | --- | --- | --- | --- |
| 31 | `#timeline`（历史时间线） | 9 类事件的最后发生区块与时间 | **MIXED** | 区块号 = `data/timeline.json → last{MarketOpened, Trimmed, CapRatcheted, ...}`；时间 = `data/timeline.json → blockTime{}`；**"X 天前"由 LIVE 的 `s.blockNumber` 反推**（`app.js:1623-1648`） | 区块部分 CI 每小时；天数部分每 60 秒重算 | **⚠ 危险**：`blocksToDays(s.blockNumber - b)` 用**实时区块**减去**冻结的区块号**，于是"X 天前"这个数字**每分钟都在变大**，看起来完全像实时数据 |
| 32 | `#timeline-lede` | 时间线结论句 | **MIXED** | `s.derived.state`（LIVE）+ `t.last.Trimmed`（STATIC）（`app.js:1651-1669`） | 混合 | 同上 |
| 33 | `#timeline-note` | 扫描区间与日志总数 | **STATIC** | `data/timeline.json → totalLogs`、`scannedTo`、`last.Trimmed`（`app.js:1670-1677`） | CI 每小时 | — |

### 1.7 两道门 `#doors-section`

| # | block_id | 显示内容 | 来源类型 | 具体来源 | 刷新频率 | 陈旧风险 |
| --- | --- | --- | --- | --- | --- | --- |
| 34 | `#door1` / `#door1-note` | 第一道门：待烧毁量、burnClaims、burnSink 余额、previewBridge | **LIVE** | `v["hook.pendingTrim"]`、`["hook.burnClaims"]`、`["burnExecutor.tokenBalance"]`、`["burnExecutor.previewBridge"]`（`app.js:1691-1713`） | 60 秒 | 无 |
| 35 | **`#door2`** | 第二道门：Fren Pet 总量、adapter 余额、receiver 余额、桥接次数、销毁次数、最近时间 | **MIXED** | 余额三项 = **LIVE** 的 `s.base.values["base.fp.*"]`（`app.js:1716-1719`，每 5 tick ≈ 5 分钟）；**`bridges.length` / `burns.length` / `lastBridge.t` / `lastBurn.t` = STATIC** 的 `data/base.json → bridges[]`、`burns[]`（`app.js:1720-1734`） | 混合：LIVE 5 分钟 / STATIC 每小时 | **⚠ 危险**：同一张卡片里"余额"是活的、"桥接/销毁次数与最近时间"是冻结的，**外观完全一致** |
| 36 | `#door2-note` | 第二道门注脚，含"两次烧毁间隔 N 天" | **MIXED** | `lastBurn.t`（STATIC，`data/base.json`）+ `state.timeline.blockTime[last.Trimmed]`（STATIC，`data/timeline.json`）（`app.js:1736-1747`） | CI 每小时 | 两个冻结源相减，一个偏移会让比值大幅失真 |
| 37 | `#door2-tech` | 技术说明 | **STATIC（硬编码）** | `BASE.frenPet` 等常量（`contracts.js:58-80`）+ locales | — | — |
| 38 | `#door-table` | 桥接 ↔ 销毁配对表（最近 8 对） | **STATIC** | `data/base.json → bridges[]` 与 `burns[]` 按下标对齐（`app.js:1758-1776`） | CI 每小时 | **⚠⚠ 高危**：按下标配对，若 CI 停摆后两边新增数量不一致，配对本就会错位且无声 |
| 39 | `#awaiting-title` | 卡片标题 | 文案 | locales | — | — |
| 40 | **`#awaiting-stats` → "当前待桥接量"** | BurnExecutor 里的 IMD 余额 | **LIVE** | `s.values["burnExecutor.tokenBalance"]`（`app.js:1792`, `1864-1867`） | 60 秒 | 无 |
| 41 | **`#awaiting-stats` → "24h 净变化"** | `now(live) − 24h(冻结)` | **MIXED — 跨纪元相减** | `bal`（LIVE）+ `data/bridge-history.json → points[label="24h"].value`（STATIC）（`app.js:1872-1876`；`readBridgeTrend` 在 `contracts.js:1019-1023`） | 混合 | **⚠⚠⚠ 最危险项**：`app.js:1801-1822` 的注释自己承认"net24 = now(live) − 24h(frozen) mixes two epochs"。副标题会带 `snapAt`，但仅在 `mayNotBeLatest()` 时变灰 |
| 42 | **`#awaiting-stats` → "7d 净变化"** | 同上，窗口 7 天 | **MIXED** | 同上，取 `points[label="7d"].value`（`app.js:1877-1881`；`contracts.js:1024-1028`） | 混合 | 同上 |
| 43 | **`#awaiting-stats` → "谁在推动" chip** | "在动/在堆积/持平" | **MIXED** | `readBridgeTrend()` 遍历 `snap.points[]`（5 个 STATIC 点）但 `now` 槽被 LIVE 余额覆盖（`app.js:1835-1858`） | 混合 | **结论由 5 个冻结采样点定调**，只有斜率端点被刷新 |
| 44 | `#awaiting-note` | 说明 + 最后一次真实桥接销毁事件 | **MIXED** | `data/base.json → bridges[last].t/.b`（STATIC）+ `bal`（LIVE）（`app.js:1943-1958`） | 混合 | 带 `ledgerAsOf` 标注，相对诚实 |

### 1.8 池对比 `#pools-section`

| # | block_id | 显示内容 | 来源类型 | 具体来源 | 刷新频率 | 陈旧风险 |
| --- | --- | --- | --- | --- | --- | --- |
| 45 | `#pools-headline` | "只有一小部分交易会烧币（约 N 倍）" | **STATIC** | `data/volume.json → hookShareEthPct`（`app.js:1129-1132`） | CI 每小时 | — |
| 46 | `#volume-stats`（3 个 stat） | hooks 池 ETH 占比、非 hooks 占比、两池 ETH 绝对量 | **STATIC** | `data/volume.json → hookShareEthPct`、`pools[A/B].ethAbs`（`app.js:1134-1151`） | CI 每小时 | 副标题带 `vol.hours`，但**不带任何时间戳** |
| 47 | `#pools-lede` | 结论句，含"净流入足以覆盖点火距离 N 倍" | **MIXED** | `A.netImd`（STATIC）+ `s.derived.gapRaw`（LIVE）（`app.js:1153-1167`） | 混合 | **⚠**：分子冻结、分母实时，比值会随池子变化漂移而分子不动 |
| 48 | `#pools-note` | 扫描区间、swap 计数、链上全局 swap 数 | **STATIC** | `data/volume.json → hours`/`fromBlock`/`toBlock`/`chainWideSwaps`/`pools[].swaps`（`app.js:1169-1182`） | CI 每小时 | 会打印 `fromBlock`/`toBlock`，属自曝 |
| 49 | `#pools` 表格 | 两池的费率、tickSpacing、hooks 地址、slot0 tick、liquidity、价格 | **LIVE** | `v["poolA.slot0"]`、`v["poolA.liquidity"]`、`d.priceA/priceB`（`app.js:2842-2872`） | 60 秒 | 无（费率/tickSpacing 来自 `POOLS` 常量，见 §4） |
| 50 | `#pools-tech` | 池 ID 识别说明 | **STATIC（硬编码）** | `ADDR.stateView` + locales | — | — |

### 1.9 机制带 `#mechanism` → `#panel-section`

| # | block_id | 显示内容 | 来源类型 | 具体来源 | 刷新频率 | 陈旧风险 |
| --- | --- | --- | --- | --- | --- | --- |
| 51 | **`#panel`（当前数据 22 个 tile）** | 池内余额、触发线、下限、待烧毁、池内 ETH、流动性、累计销毁、累计奖励、留存 ETH、backstop 系列、费率累计、refTick、deploymentFloorTick、currentTick、再平衡阈值、keeper 奖励、marketOpen、pendingRebalance、owner nonce | **LIVE** | `s.values["hook.*"]`、`s.values["owner.nonce"]`（`app.js:1973-1997`） | 60 秒 | 无 |
| 52 | `#raw-table` | 全部原始读数（含取不到的项与原因） | **LIVE** | `snap.values` + `snap.errors` 全量（`app.js:2000-2021`） | 60 秒 | 无 |

### 1.10 模拟器 `#simulator-section`

| # | block_id | 显示内容 | 来源类型 | 具体来源 | 刷新频率 | 陈旧风险 |
| --- | --- | --- | --- | --- | --- | --- |
| 53 | `#sim-out` 第一组 4 个 tile | 未来池内量、未来触发线、未来点火距离、未来状态 | **LIVE（输入）+ 纯函数推演** | `protocolParams(snap)` 取 `hook.positionLiquidity`/`tokensInPool`/`inventoryCap`/`capFloor`/`currentSqrtPriceX96`/`ratchetBps`/`capDecayTokensPerDay`/`lastCapDecayAt`/`minTrimTokens`/`rewardShareBps`（`app.js:2027-2042`） | 60 秒（且滑块变化即时） | 无 |
| 54 | `#sim-out` 横幅 | 触发/不触发的条件说明 | **LIVE** | 同上 | 60 秒 | 无 |
| 55 | `#sim-out` 第二组（N 天内触发次数/总烧毁/总奖励/剩余距离） | 多日推演 | **LIVE + 本地** | `simulateHorizon(protocolParams(s), {...})`（`app.js:2146-2155`） | 输入变化时 | 无（明示为估算） |
| 56 | `#preset-hint` / 滑块初值 | 预设参数 | **硬编码** | `PRESETS`（`app.js:2906-2926`）：`calm` = 1000/0/30 | — | 见 §4 |

### 1.11 如果现在触发 `#trimnow-section`

| # | block_id | 显示内容 | 来源类型 | 具体来源 | 刷新频率 | 陈旧风险 |
| --- | --- | --- | --- | --- | --- | --- |
| 57 | `#trim-now` → 第 1 个 tile | 现在触发会烧掉多少 | **LIVE** | `d.pendingTrim`、`d.pendingBurn`（`app.js:2183-2188`） | 60 秒 | 无 |
| 58 | `#trim-now` → 第 2/3 个 tile | 销毁量 / 奖励量及其百分比 | **LIVE** | `d.pendingBurn`、`d.pendingReward`、`v["hook.rewardShareBps"]`（`app.js:2189-2193`） | 60 秒 | 无 |
| 59 | **`#trim-now` → 第 4 个 tile（上限）** | 写死的 **"30%"** | **硬编码常量** | `app.js:2217` `statTile(tr("s.536"), "30%", ...)`，即 `MAX_REWARD_SHARE_BPS = 3000` | 永不变化 | **伪实时**：与左右两个实时百分比并排，看起来像当前配置。`app.js:2194-2216` 的注释承认了这一点并"刻意"保留为无 srcKey 的上限标注 |
| 60 | `#trim-now-lede` | 结论句 | **LIVE** | `d.pendingTrim`、`share`（`app.js:2223-2229`） | 60 秒 | 无 |
| 61 | `#trimnow-section` note | 1499 bps / 1500 bps 取整说明 | **硬编码** | `index.html:424-428` | — | 见 §4 |

### 1.12 质押收益 `#rewards-section`、sIMD `#simd-section`

| # | block_id | 显示内容 | 来源类型 | 具体来源 | 刷新频率 | 陈旧风险 |
| --- | --- | --- | --- | --- | --- | --- |
| 62 | `#rewards`（11 个 tile） | drippable、dripper IMD 余额、日滴速、lastDripAt、canDrip、minDrip、heldBonding、heldNft、两桶合计、stakingEarned、三分桶 bps | **LIVE** | `v["dripper.*"]`、`v["bal.imd.dripper"]`、`v["distributor.*"]`（`app.js:2240-2293`） | 60 秒 | 无 |
| 63 | `#rewards-section` note | 三桶分配与滞留原因 | **硬编码** | `index.html:440-445` | — | 见 §4 |
| 64 | `#simd`（6 个 tile） | sIMD 总资产、总量、兑换比例、占 IMD 供应量比、paused、decimals | **LIVE** | `d.totalAssets`、`d.totalSupply`、`d.simdRate`、`d.simdShareOfSupply`、`v["simd.paused"]`（`app.js:2301-2333`） | 60 秒 | 无 |
| 65 | `#simd-explain` | "这个比例是怎么来的"解释 | **LIVE（插值）+ 文案** | `v["hook.totalRewarded"]`、`v["distributor.stakingEarned"]` 插入固定文案（`app.js:2334-2354`） | 60 秒 | 无 |

### 1.13 烧毁历史 `#history-section`

| # | block_id | 显示内容 | 来源类型 | 具体来源 | 刷新频率 | 陈旧风险 |
| --- | --- | --- | --- | --- | --- | --- |
| 66 | `#hist-count` / `#hist-range` | 事件总数、覆盖区块区间 | **STATIC** | `data/timeline.json → trims[]`+`backstopSettles[]` 长度、`scannedFrom`/`scannedTo`（`app.js:2771-2772`） | CI 每小时 | — |
| 67 | **`#spark`（烧毁 sparkline）** | 每次烧毁的量（对数刻度柱） | **STATIC** | `data/timeline.json → trims[]`、`backstopSettles[]`（`app.js:2774-2796`） | CI 每小时 | **⚠**：整个 SVG 无时间戳，无过期标记 |
| 68 | `#hist-stats`（4 个 tile） | 抽走次数、累计销毁、累计奖励、单次最大销毁 | **STATIC** | 对 `data/timeline.json` 的 `trims[]`/`backstopSettles[]` 求和（`app.js:2798-2816`） | CI 每小时 | **⚠**：标题写着"累计销毁"，但只是快照区间内的累计 |
| 69 | `#history-lede` | 历史结论 | **MIXED** | `trims`（STATIC）+ `blocksToDays(s.blockNumber - lastTrim.b)`（LIVE 区块号）（`app.js:2818-2826`） | 混合 | 同 #31，"X 天前"随时间漂移 |
| 70 | `#hist-note` | 历史注脚 | **STATIC + 文案** | `firstTrim.b` / `lastTrim.b`（`app.js:2827-2839`） | CI 每小时 | — |
| 71 | **`#burnrate`（烧毁速率）** | 24h 速率、7d 速率、终身日均、本机观测速率 | **MIXED** | `t.trims`（STATIC）按 `s.blockTimestamp`（LIVE）切窗（`app.js:597-621`）；"本机观测速率"来自 `localStorage` 的 `pool4.burnlog.v1`（LIVE 采样） | 混合 | **⚠⚠ 高危**：`t.trims` 冻结 + `s.blockTimestamp` 实时 → 24h/7d 窗口会**逐渐滑出快照覆盖范围**，导致计数下降甚至归零，而读数仍是 `0 IMD` 这种"看起来像真数据"的值 |
| 72 | `#burnrate` → `devTargetBlock()` | 项目方设想的 25k IMD/日 目标与实际对比 | **MIXED** | `TARGET = imdToWei(25000)`（**硬编码**，`app.js:656`）+ `h24.perDay`/`h168.perDay`（STATIC 派生） | 混合 | 目标值是写死的引文 |

### 1.14 权限带 `#governance` → `#owner-section`、`#monitor-section`

| # | block_id | 显示内容 | 来源类型 | 具体来源 | 刷新频率 | 陈旧风险 |
| --- | --- | --- | --- | --- | --- | --- |
| 73 | `#owner-summary`（3 个 tile） | 已放弃权限数 / 仍活跃数 / 活跃权限函数数 | **LIVE** | `v[c.ownerKey]` vs `ZERO_ADDR`（`app.js:2364-2392`） | 60 秒 | 无 |
| 74 | `#owner-contracts` | 6 个合约的 owner 卡片与权限清单 | **LIVE（owner 值）+ 硬编码（权限清单）** | owner 地址 = LIVE；`OWNER_POWERS`（`contracts.js:284-405`）、`OWNER_CONTRACTS`（`contracts.js:406-462`）是**写死的源码审计结果** | 60 秒 | **⚠**：卡片里的"风险/安全"徽章直接由 owner 判定，但**权限函数列表、严重级别、源码行号是静态的**，不会随链上代理升级更新 |
| 75 | `#owner-lede` | 权限现状结论 | **LIVE** | 同上（`app.js:2435-2448`） | 60 秒 | 无 |
| 76 | `#powers` 表格 | 全部权限函数、源码行号、作者注释原文 | **STATIC（硬编码）** | `OWNER_POWERS`（`contracts.js:284-405`），仅在 owner 为零地址时降低透明度（`app.js:2450-2466`） | 永不 | 源码若升级即失效 |
| 77 | `#monitor-status` | "距上次检查 N 项无变化" | **LIVE + localStorage** | `readWatch(snap)` 读 `WATCHED`（`contracts.js:246-276`）实时值（`app.js:2638-2712`） | 60 秒 | 无 |
| 78 | `#watch-table` | 逐项监控表 | **LIVE** | `snap.values[w.c+"."+w.k]`（`app.js:2714-2726`） | 60 秒 | 无 |
| 79 | `#watch-log` | 变更历史（本机记录） | **本地 localStorage** | `pool4.watchlog.v1`（`app.js:2728-2743`） | 事件驱动 | 仅本机、仅页面打开期间 |

### 1.15 数据带 `#data` → `#sources-section` 与页脚

| # | block_id | 显示内容 | 来源类型 | 具体来源 | 陈旧风险 |
| --- | --- | --- | --- | --- | --- |
| 80 | `#sources-table` | 每个数字的来源合约/函数/行号 | **STATIC（硬编码）** | `SOURCES`（`contracts.js:465-534`）+ `renderSources()`（`app.js:2964-3009`） | 源码升级即失效 |
| 81 | `#poolid-b` | Pool B 的 poolId | **本地计算** | `POOL_IDS.B` = `computePoolId()`（`contracts.js:103-106`） | 无 |
| 82 | `#footer-src` | RPC 端点、区块号、错误数 | **LIVE** | `s.endpoint`、`s.blockNumber`、`s.base.blockNumber`、错误计数（`app.js:2885-2895`） | 无 |

---

## 2. 汇总统计

| 类别 | 数量 | 说明 |
| --- | --- | --- |
| **纯 LIVE** | **42** | 顶部状态条、结论带全部、`#verdict-section` 全部、`#door1`、`#awaiting-stats` 当前量、`#pools` 表格、`#panel`、`#raw-table`、`#simulator-section`、`#trimnow-section`（除第 4 tile）、`#rewards`、`#simd`、`#owner-summary`、`#monitor-section`、`#footer-src`、`#states`/`#state-note` |
| **纯 STATIC** | **15** | `#sum-visual` 活动条、`#messages-section` 全部渲染块（lede/最新卡片/筛选计数/列表/时间/中文摘要/tech）、`#timeline-note`、`#door-table`、`#pools-headline`、`#volume-stats`、`#pools-note`、`#hist-count`/`#hist-range`、`#spark`、`#hist-stats`、`#hist-note`、`#sources-section`、`#powers`、`#what`、`#howto` 文案 |
| **MIXED** | **13** | `#timeline`、`#timeline-lede`、`#door2`、`#door2-note`、`#awaiting-stats` 的 net24/net7d/whoPushes、`#awaiting-note`、`#pools-lede`、`#history-lede`、`#burnrate`、`devTargetBlock`、含 `trimAge` 的 `#v-answer` 分支 |
| **本地 localStorage** | **3** | `#fliplog`、`#watch-log`、`#burnrate` 的"本机观测速率" |
| **硬编码常量** | 若干 | 见 §4 |

### 最危险的前 3 项

> **第 1 名 —— `#awaiting-stats` 的 24h/7d 净流量（`app.js:1872-1881` + `contracts.js:1019-1028`）**
> `net24 = tokenBalance(LIVE, 此刻) − points["24h"].value(STATIC, 可能是几小时前)`。
> 这是**两个不同纪元的数据做减法**。CI 停摆后，被减数是活的（余额会动），减数冻结在旧区块上，
> 差值于是变成一个既不是"24h 变化"也不是"自快照以来的变化"的第三个数。
> 它显示的形态是 `+1,234.56 IMD`，**与真实趋势的外观毫无区别**。
> 代码注释（`app.js:1801-1822`）自己承认了这个混纪元问题，缓解手段只是"让受影响的 tile 变灰"——
> 而变灰的条件是 `mayNotBeLatest()`，需要快照超过 3 小时。**3 小时内的停摆完全隐形。**

> **第 2 名 —— 链上留言面板整体（`#messages-section`，`app.js:2483-2605`）**
> 页面上写着"链上留言带区块时间戳、事后改不了，是最原始的一手记录"（`index.html:219-222`），
> 并承诺"本页每 60 秒重新读取一次链上数据"（`index.html:265`）。
> 实际上**整个面板读的是页面加载时 fetch 一次的 `data/messages.json`，60 秒读的是同一个内存对象**。
> 更糟的是：仓库里**已经有** `lib/messages-live.js` + `lib/messages-follow.js` 实现了 30 秒轮询的真实时读取，
> `messages-follow.js:6-11` 的注释甚至描述了"开发者刚发消息但页面一小时不更新"这个缺陷——
> **但 `app.js` 从未 import 它们，`startMessageFollower` 零调用点**。修复代码在库里躺着没接线。
> 用户在新留言发出后最长要等一个 CI 小时（CI 挂掉则永远看不到），而页面文案承诺 60 秒。

> **第 3 名 —— `#burnrate` 烧毁速率（`app.js:597-621`）**
> `t.trims` 来自 `data/timeline.json`（冻结），切窗基准 `nowSec = s.blockTimestamp` 来自链上实时。
> CI 停摆后，实时时间轴继续前进，24 小时窗口会**滑出快照覆盖范围**，
> 于是 `h24.count` 从真实值逐渐衰减到 `0`，tile 渲染成 `0 IMD` + `sub: "0 次抽走"`。
> 模块注释（`app.js:86-87`）明确定下规矩"读不到的数绝不能渲染成 0 —— 0 是一个断言"，
> 但这里 0 不是"读不到"，而是"窗口滑出去了"，**绕过了这条规矩**。
> 同样：`#spark`、`#hist-stats`、`#hist-count` 也全部来自这份冻结的 `trims[]`，且**都没有任何时间戳**。

### 告警机制的实际覆盖范围

`#stale-banner`（`app.js:1212-1235`）是唯一的陈旧告警，它：

- 监控 5 个源：`timeline`、`base`、`volume`、`messages`、`bridge-history`（`app.js:1215-1221`）；
- **不监控** `messages.zh.json`、`baseline.json`（后者甚至根本不在运行时读取链路上）；
- 阈值 `STALE_AFTER_HOURS = 3`，即 **CI 停摆后前 3 小时完全不告警**；
- 一旦某个源缺 `builtAt`/`scannedAt`/`fetchedAt`/`generatedAt` 字段（`snapshots.js:15`），该源被静默跳过；
- `oldestSnapshot()` 只报**最老**的一个源，所以只要有一个源在刷新，横幅就不会亮——
  即使另一个源已经冻了一周。

---

## 3. 用静态 JSON 却看起来像实时数据的块（重点标记）

按危险程度排序：

| 危险级 | block_id | 行号 | 为什么看起来像实时 |
| --- | --- | --- | --- |
| 🔴🔴🔴 | `#awaiting-stats` net24/net7d | `app.js:1872-1881` | LIVE 减 STATIC，跨纪元减法，形态是普通正负数 |
| 🔴🔴🔴 | `#messages-section` 全块 | `app.js:2483-2605` | 页面文案承诺 60 秒刷新；LIVE 实现已存在但未接线 |
| 🔴🔴 | `#burnrate` 24h/7d | `app.js:597-621` | 冻结 `trims` × 实时时间戳，衰减到 `0` 而不报错 |
| 🔴🔴 | `#door-table` 配对表 | `app.js:1758-1776` | 按下标配对，错位无声 |
| 🔴🔴 | `#door2` 桥接/销毁次数与最近时间 | `app.js:1720-1734` | 同卡片内余额是 LIVE，计数是 STATIC，外观一致 |
| 🔴 | `#sum-visual` 活动条 | `app.js:795-828` | 柱子无时间戳，只有超阈值才加 "as of" |
| 🔴 | `#timeline` + `#history-lede` 的 "X 天前" | `app.js:1642`, `2820` | 实时区块减冻结区块，数字持续增长 |
| 🟠 | `#v-answer` 内的 trimAge 分支 | `app.js:1313-1314`, `1380` | 用 `agoBounded()` 包装但阈值未到时不加限定 |
| 🟠 | `#spark` / `#hist-stats` | `app.js:2774-2816` | 7 MB 事件的聚合结果，标题称"累计"，无时间戳 |
| 🟠 | `#volume-stats` / `#pools-note` | `app.js:1134-1182` | 有 `hours` 副标题但无绝对时间；`scannedAt` 未被渲染 |
| 🟠 | `#pools-lede` 覆盖倍数 | `app.js:1153-1167` | 分子 STATIC、分母 LIVE |
| 🟡 | `#trim-now` 第 4 tile `"30%"` | `app.js:2217` | 硬编码常量紧邻两个 LIVE 百分比 |

---

## 4. 硬编码在 HTML / JS 里的常量数字

### 4.1 `index.html`（写死的结论、日期、比例）

| 行号 | 内容 | 风险 |
| --- | --- | --- |
| `index.html:101` | "其中 85% 永久销毁，15% 分给质押者" | 实际由 `rewardShareBps` 决定（当前 1500 bps）。owner 改费率后此句失效 |
| `index.html:116` | 引文内 "burns 85%" | 属原文引用，合理 |
| `index.html:119` | "区块 25,901,450 · 2026-09-04" | 写死的区块号与日期 |
| `index.html:124` | "烧掉 85%，把剩下的分给长期持有者" | 同 #101 |
| `index.html:130` | "同一区块 25,901,450" | 写死 |
| `index.html:153` | "85% 永久销毁" / "15% 分给质押者" 流程条 | 同 #101，**这是流程图上的比例，最像实时事实** |
| `index.html:254` | 收款地址 `0x200E710aCAA6A93bbc77146026328C40F1d60fB1` | 与 `lib/messages-live.js:53` 的 `MESSAGE_ADDRESS` 重复定义 |
| `index.html:411-413` | 源码行号 `L339-341`、`L963-969`、`L997`、`L1033-1034` | 指向链上已验证源码的行号，源码升级即失效 |
| `index.html:426-427` | "加起来会得到 **1499 bps** 而不是配置的 1500 bps"、"单次拆分精确等于 1500 bps" | **写死的计算结果**。若 owner 改 `rewardShareBps`，这句就变成假话，而它读起来像一个实测值 |
| `index.html:434` | "分给质押者的那 15% 也就断了" | 同 #101 |
| `index.html:443-444` | `emergencyWithdraw()`（L92-99）、`BONDING_LIVE`、"不存在该开关"、`rescueERC20()`（L178-181） | 源码级断言，写死 |
| `index.html:543-544` | "`CappedBurnHook.sol`（1285 行，solc 0.8.30，Blockscout 验证于 2026-09-19）" | 写死的版本与验证日期 |

### 4.2 `assets/app.js`（写死的常量与"结论"）

| 行号 | 内容 | 风险 |
| --- | --- | --- |
| `app.js:18` | `REFRESH_MS = 60_000` | 配置常量，正常 |
| `app.js:20` | `BASE_EVERY = 5` | 配置常量 |
| `app.js:22` | `STALE_AFTER_HOURS = 3` | 陈旧阈值 |
| `app.js:193` | `blocksToDays = (n) => (n * 12) / 86400` | **硬编码 12 秒/区块**。合并后区块时间若变化，所有 "X 天前" 估计都偏 |
| `app.js:656` | `const TARGET = imdToWei(25000)` | 项目方的 **设计目标**，非链上值，但被当分母算出百分比 |
| `app.js:659-676` | 三个硬编码引文块：区块 `25901450` / `25892951` / `25890127`，日期 `2026-09-04` / `2026-09-02`，原文含 "25k IMD per day"、"2700 imd of rewards" | 写死的日期与引文；这些区块号**也在 `data/messages.json` 里**，两处独立维护 |
| `app.js:711` | `[25901450, 25892951, 25890127]` | 同上，用于 `wireQuoteLinks()` 挂链 |
| `app.js:2217` | `statTile(tr("s.536"), "30%", ...)` | **`MAX_REWARD_SHARE_BPS = 3000` 写死为 "30%"**，与左右两个实时百分比并排 |
| `app.js:2906-2926` | `PRESETS`：`calm` = `{inflow: 1000, price: 0, days: 30}`，`dump` = `{price: -20}` | 预设参数写死 |
| `app.js:923`, `925` | `7 * 86400000` | "7 天内"的翻转/参数变更新鲜度窗口 |
| `app.js:2584` | `m.text.length > 220` | 留言折叠阈值 |
| `app.js:2481` | `MSG_PAGE = 6` | 分页大小 |
| `app.js:796` | `const N = 24` | 活动条显示的烧毁次数 |

### 4.3 `lib/contracts.js`（写死的链上事实）

| 行号 | 内容 | 风险 |
| --- | --- | --- |
| `contracts.js:16-29` | 11 个合约地址 `ADDR` | 硬编码；代理升级后失效 |
| `contracts.js:32-35` | `POOLS`：费率 10000、tickSpacing 200/60 | **写死的费率与 tickSpacing**，而 `#pools` 表格把它们当事实渲染（`app.js:2848-2849, 2858-2859`），旁边却是 LIVE 的 slot0/liquidity |
| `contracts.js:58-80` | `BASE`：chainId 8453、adapter、frenPet、burnReceiver 地址、eid 30184 | 硬编码 |
| `contracts.js:284-405` | `OWNER_POWERS`（约 120 行）：全部权限函数、严重级别、源码行号、作者注释原文 | **渲染进 `#owner-contracts` 和 `#powers` 表格**，是静态审计结论 |
| `contracts.js:406-462` | `OWNER_CONTRACTS`：6 个合约的角色与备注 | 同上 |
| `contracts.js:465-534` | `SOURCES`：来源合约/函数/行号映射 | 渲染进 `#sources-table` 与每个 `srcTag()` tooltip |
| `contracts.js:985-990` | `ARCHIVE_RPCS` | 运行时未使用（`readBridgeTrend` 改为读快照），死代码 |

---

## 5. `state.*` 使用点逐点判定（要求项）

| 字段 | 赋值处 | 读取处（行号） | 判定 |
| --- | --- | --- | --- |
| `state.timeline` | `app.js:226`（boot，`fetch data/timeline.json`） | `165-166`（`snapshotBehindChain`）、`172-173`（`asOf`）、`591`（renderBurnRate）、`795`（renderSummaryVisual 活动条）、`838`、`1216`（stale banner）、`1313-1314`（renderVerdict trimAge）、`1609`（renderTimeline）、`1740-1741`（door2-note）、`2766`（renderHistory） | **STATIC**，全部 |
| `state.baseData` | `app.js:227`（`fetch data/base.json`） | `1682`（renderDoors door2）、`1217`（stale banner）、`1943`（renderAwaiting 的 bridge ledger） | **STATIC**，全部 |
| `state.volume` | `app.js:228`（`fetch data/volume.json`） | `1117`（renderVolume）、`1218`（stale banner） | **STATIC** |
| `state.messages` | `app.js:229`（`fetch data/messages.json`） | `709`（wireQuoteLinks）、`1219`（stale banner）、`2484`（renderMessages） | **STATIC**（`messages-follow.js:105` 本会写 `state.messagesLive`，但从未被调用） |
| `state.messagesZh` | `app.js:230`（`fetch data/messages.zh.json`） | `2589`（renderMessageBody 中文摘要） | **STATIC**，且**不被 stale banner 监控** |
| `state.bridgeSnapshot` | `app.js:231`（`fetch data/bridge-history.json`） | `1220`（stale banner）、`1823`（renderAwaiting） | **STATIC**（其 `"now"` 槽在 `app.js:1843` 被 LIVE 余额替换 → MIXED） |
| `state.snap` | `app.js:335`（`tick()` 内 `collect()`），`285`（测试 fixture） | `263, 334, 592, 734, 834, 1118, 1186, 1258, 1309, 1489, 1610, 1681, 1790, 1962, 2045, 2085, 2176, 2233, 2297, 2360, 2663, 2767, 2843, 2886` | **LIVE** |
| `state.timeline` 的 `builtAt` | — | `172-173` | 被 stale banner 用作年龄来源 |

**关于 `data/baseline.json`**：它由 `scripts/collect.mjs` 生成并被 CI 提交（`refresh-snapshots.yml:68`），
但 `assets/app.js` **在运行时完全不 fetch 它**（`app.js:218-224` 的六个 fetch 里没有它）。
它只用于离线交叉验算。**页面上没有任何数据块来自 `baseline.json`。**

**关于 `data/history.json`（7 MB）**：被 `.assetsignore` 排除、不部署，仅作 CI 增量缓存。页面不读。

---

## 6. 其他观察（未修改文件）

1. **`#burnrate` 的"本机观测速率"**（`app.js:613-621`）是页面上唯一真正的"此刻速率"，
   但它依赖 `localStorage` 里至少 2 个样本且间隔 > 60 秒 —— 也就是**要求用户页面至少开着 1 分钟以上**。
   首次打开、或每次刷新页面后，它都显示"样本不足"（`s.042`）。
2. **`#monitor-section` 的"一有变化就会高亮"**（`index.html:511-512`）同样是本机语义：
   它比对的是 `localStorage` 里上一次的读数，而不是 CI 后的快照。页面关闭期间发生的参数变更
   **会被静默吞掉**（因为下次打开时 prev 仍是旧值，只是差值一次跳很大，没有告警）。
3. **`AGENTS.md` / `NOTES.md` / `HANDOFF.md`** 已确认存在但未在本次审计的必读清单内，未展开。
4. `app.js:284-289` 的测试 fixture 注入路径（`globalThis.__POOL4_FIXTURE__`）在生产环境不触发，
   但它会**完全跳过 `setInterval(tick)`**，因此 `state.snap` 归 fixture 所有，所有 LIVE 块退化为测试数据。
