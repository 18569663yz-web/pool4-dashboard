# HANDOFF — 项目状态速查

> 给后续会话/协作者的一页速查。完整机制说明见 `NOTES.md`，运行与部署见 `README.md`。

## 这是什么

只读静态站点，回答一个问题：**IMD 的烧毁机制还在工作吗？还差多少才会重新点火？**
零依赖（无 npm 包），浏览器直接 `eth_call`，每 60 秒刷新。不连钱包、不签名、无后端。
**中英双语**：中文为默认语言，右上角切换（`?lang=en` 可直接进英文）。

```
index.html              页面骨架（静态文案全部挂 data-i18n / data-i18n-html）
assets/{app.js,style.css}
locales/{zh,en}.json    全部界面文案，扁平键（s.NNN 为迁移键，语义键为 meta./html./awaiting.…）
lib/evm.js              keccak-256 + ABI 编解码 + 多端点 RPC（batch 逐项容错）
lib/contracts.js        合约注册表 / ABI / collect() / derive() / OWNER_POWERS / OWNER_CONTRACTS
lib/i18n.js             t() / 复数 / 日期与数字本地化 / applyStatic()
lib/simulate.js         前瞻模拟器（纯函数）
lib/html-scan.js        index.html 文案接线扫描（缺 data-i18n 的中文会被 check 挡住）
lib/scan-strings.js     字面量扫描 + 模板 ${} 参数提取
data/*.json             预生成快照（页面运行时只读链上实时值）
scripts/*.mjs           30 个只读脚本
NOTES.md / README.md
```

## 当前链上事实（2026-09-24 07:01 UTC，区块 26,045,701）

| 项 | 值 |
|---|---|
| 引擎状态 | **临界 · 贴着触发线**（`gapRaw = 0`；最后 trim 区块 26044258，2026-09-24 02:10 UTC） |
| 池子状态 | **仍在正常交易**（`FeeCollected` 活跃到当前区块） |
| 点火距离 | `inventoryCap − tokensInPool` = **0**（cap 已棘轮到与池子存量相等：10,482.3882 IMD） |
| inventoryCap / capFloor | 10,482.3882 / **9,000** IMD —— capFloor 已从 20,000 下调到 9,000（owner 操作） |
| ratchetBps / capDecay / rewardShareBps | 10000 / 3000 IMD·天 / 1500 bps |
| totalBurned / totalRewarded | 32,074.259128 / 5,660.163376 IMD |
| 待桥接队列（BurnExecutor） | **830.7263 IMD**；24h 前 5,531.38，7d 前 20,372.36 → 净流出 4,700 / 19,542 IMD |
| 池 B poolId | `0x415829f72e9f54531c26eae76f107618540e898a45d6ae35959e143f5faca704` |

**两道门**：L1 trim（**已恢复工作**，最后 2026-09-24 02:10）+ L1→Base 桥接销毁（活跃，最后 2026-09-23 22:04）。
队列余额在一周内从 20,372 降到 830 IMD，**第二道门确实有人在推**（页面据此判定「有人在推动」）。
`$IMD` 合约名 `BridgedFP`，Base peer 是 OFTAdapter 包装的 Fren Pet。

**只有约 1/17 的成交金额经过烧毁引擎**（池 A `hooks=0x0` 占 94.24%）。

## 双语架构：三条必须遵守的规则

1. **界面里不允许出现中文字面量。** `assets/app.js` 与 `lib/contracts.js` 的字符串字面量中文字符数为 0，
   `index.html` 的静态中文必须挂 `data-i18n` / `data-i18n-html`（或位于 app.js 会覆写的容器内）。
   两条断言分别在 `check.mjs`（静态）与 `test-render.mjs`（英文模式渲染后仍无中文、无裸键名）里。
2. **数据层存键名，不存译文。** `lib/contracts.js` 里用户可见的字段（owner 权限后果、合约角色、监控来源）
   存的是 locale 键（`owner.role.simd`），渲染时经 `td()` 翻译；非文案字段（`capFloor`）原样返回。
   `tr()` **不能在模块顶层调用** —— 那时 `initI18n()` 还没读到字典，会把键名烧进页面（曾发生）。
3. **链上留言的英文原文一个字都不改。** 中文模式在原文下方追加摘要，前缀写明「非官方译文」，
   原文用等宽引用块、摘要用常规小字（字体 + 颜色双重区分）。摘要来自 `data/messages.zh.json`（按区块号索引，可人工校对）。

文案工作流（改动文案时用）：

```bash
node scripts/extract-strings.mjs --write     # 扫描中文字面量 → data/strings-todo.json
node scripts/build-i18n-skeleton.mjs --start N --out data/strings-i18n-K.json   # 生成键与参数
node scripts/merge-i18n.mjs                  # 骨架 + _en*.json + copy block → locales/*.json
node scripts/apply-i18n.mjs --skeleton data/strings-i18n-K.json                 # 回写 app.js
node scripts/wire-html-i18n.mjs              # 给 index.html 的静态文案挂 data-i18n
node scripts/retag-data-strings.mjs          # lib/contracts.js 的中文 → 键名
```

`data/_*.json` 是人工维护的**文案源**（`_html.json` 页面静态文案、`_awaiting-copy.json` 第二道门、
`_data-copy.json` 数据层、`_proofread.json` 术语校对）。merge 时这些文件的值会**覆盖** locales，
所以改文案要改这里，不要直接改 `locales/*.json`。

## 主题与折叠条（改样式前先读）

**浅色是默认主题**，深色是 `localStorage` 里的选择（键 `pool4.theme`）。三条约束：

1. **配色只能走语义变量。** `assets/style.css` 顶部 `:root` 是浅色，`html[data-theme="dark"]`
   一个块覆盖成深色。规则里**不允许出现硬编码颜色**（`#2a1414`、`rgba(255,255,255,.025)` 这类）——
   要用 `--dead-bg` / `--dead-line` / `--tint` 这种语义名。新增一个颜色时先在 `:root` 定义，
   再去深色块里给值；只加一边，另一边就会在某个主题下变成不可读的对比度。
2. **主题必须在首次绘制前应用。** `index.html` 的 `<head>` 里有一段同步内联脚本读
   `localStorage` 并写 `<html data-theme>`；把它挪到 `app.js` 里会让深色用户每次导航先闪一下白。
3. **`assets/*` 的缓存是 1 小时**（见 `_headers`）。改完 CSS/JS 要把 `index.html` 里的
   `?v=` 版本号一起改掉，否则回访的人 1 小时内拿到的还是旧样式 —— 曾经因此被当成"改了没生效"。

折叠条（五个分组 + 每节的「给技术读者的细节」）：

- 分组条 `details.group > summary.band` 与细节条 `details.tech > summary` 都是
  `display: flex`，靠 `::before` 画的三角形和（分组条的）`展开/收起` 胶囊提示可点。
  **`display: flex` 掉了就会退化成一条竖线** —— 三角形是用 border 画的，inline 元素上
  border 会撑满整行高，看起来像"横杠"，这正是第一版被抱怨的原因。
- 点导航胶囊（`.anchors a`）时，`app.js` 的 `initGroups()` 会 `preventDefault()`：
  先 `group.open = true`，再在**下一帧** `scrollIntoView()`，最后短暂加 `.jumped` 高亮。
  顺序不能反 —— 浏览器自己的锚点跳转发生在 `<details>` 展开**之前**，滚动位置按旧布局算，
  结果就是"跳了但看不到内容"。
- 吸顶头部的高度由 `html { scroll-padding-top }` 预留（窄屏 168px）。改头部高度时要同步改它。

**改样式表时的自检（踩过一次）**：`check.mjs` 只审计 id 接线和文案，**不检查 CSS 选择器覆盖**。
整份重写 `style.css` 时漏掉了 `.summary` / `.prose` / `.preset` 等一整段规则，页面照常渲染、
测试全绿，但结论区悄悄退化成没有卡片样式的白底 —— 被读者当成"太单调"。
重写后跑一次选择器对比，剩下的差异必须每一条都能说清是有意删除：

```bash
git show <上一个提交>:assets/style.css | Out-File _old.css -Encoding utf8
node -e "const fs=require('fs');const g=p=>fs.readFileSync(p,'utf8').split(/\r?\n/).filter(l=>l.includes('{')&&/^[.#a-zA-Z*@\[]/.test(l.trim())).map(l=>l.trim().replace(/\s*\{.*$/,''));const o=g('_old.css'),c=g('assets/style.css');for(const s of o.filter(x=>!c.includes(x)))console.log('  '+s)"
```

## 快照刷新（GitHub Actions）

页面上所有「历史」——烧毁曲线、24h/7d 趋势、链上留言时间线——都来自 `data/` 下的预生成 JSON。
它们由 `.github/workflows/refresh-snapshots.yml` **每 2 小时**刷新一次（cron `17 */2 * * *`，避开整点；
也支持 `workflow_dispatch` 手动触发）。

**为什么可以每小时**：托管在 Cloudflare **Workers**（不是 Pages），两者的免费额度计费方式不同 ——
Pages 按**构建次数**（500 次/月，每小时一次 ≈ 730 次会超），Workers Builds 按**构建分钟**
（3,000 分钟/月）。我们一次构建（复制文件 + `wrangler deploy` 上传 29 个文件）约 40 秒，
每小时一次 ≈ 500 分钟/月，只用掉六分之一。**所以频率的约束解除了。**
部署配置在仓库根目录的 `wrangler.jsonc`（`assets.directory = ./dist`，**没有 `main` 入口** —— 纯静态，
Worker 只负责把 `dist/` 从边缘发出去）。页面过期横幅的阈值是 3 小时，所以 1 小时的节奏下它只在
**某次刷新真的失败时**才出现。

本地跑的是**同一套**流程：

```bash
node scripts/refresh-snapshots.mjs            # 生成 → 校验 → 通过才替换
node scripts/refresh-snapshots.mjs --dry-run  # 只生成到临时目录并校验
node scripts/verify-snapshots.mjs             # 只校验 data/ 里现有的快照
```

**为什么不是「跑完就写」**：数据源是公共 RPC，它会**给错而不是报错**（NOTES §16 记录了差六个数量级的
例子）。所以每个产物先写进临时目录，校验通过才替换正式文件：

| 检查 | 拦什么 |
| --- | --- |
| JSON 可解析 | 截断的响应 |
| 关键字段与类型 | 结构被动过、生成器改坏 |
| 数值量级（`sanityCheckDerived`） | 单位错误、decimals 错误 |
| **不能倒退**：事件数不减少、`headBlock`/`scannedTo`/`toBlock` 不回退、留言数不掉 20% 以上 | 抓取被截断（实践中最常见的失败） |

任一步失败 → `data/` 一个字节都不动、退出非零、workflow 不 commit（GitHub 会通知仓库 owner）。
生成器失败会自动**重试一次**（公共端点偶尔断几秒）。

**页面上的过期提示**：任一快照超过 3 小时未更新，页面顶部出现黄色横幅（`stale.banner`），写明最旧的
是哪一份、多久以前。链上实时数字不受影响。

**CI 的端点**：设仓库变量 `POOL4_RPC_URLS`（逗号分隔）即可覆盖所有脚本的端点优先级，不改变默认值
（本机不设就用内置列表）。`lib/evm.js` 的 `rpcEndpoints()` 负责合并。

**若本机 node 连不上 Blockscout**（`base.blockscout.com` / `eth.blockscout.com` 在部分网络下对 node
直连超时，而同一 URL 用 PowerShell 能打开）：`base.json` 与 `messages.json` 会因此刷不动，其余快照照常
更新。三种处理方式：

```bash
POOL4_SKIP_BASE=1 node scripts/refresh-snapshots.mjs --skip messages   # 明确跳过，其余照刷
HTTPS_PROXY=http://127.0.0.1:7890 NODE_USE_ENV_PROXY=1 node scripts/refresh-snapshots.mjs   # Node 24 走代理
node scripts/refresh-snapshots.mjs                                    # 交给 CI（GitHub runner 可达）
```

被跳过的快照不会被动过，页面上的过期横幅会开始计时 —— 这是设计好的降级路径，不是静默失败。

**`data/history.json`（7 MB 原始事件索引）**：它进仓库是为了让 CI 的第一次运行是增量
而不是全量重扫（16 万区块）。workflow 用 `actions/cache` 在运行之间传递它的更新，**不**把它提交进 git
—— 否则仓库每小时长 7 MB。推论：**仓库里那份是「永远不动的冷启动基线」**，本地跑过索引后它会显示为
`modified`，这是预期的（不必提交；CI 靠 cache 推进它）。

**「输出走 staging」不等于「输入也走 staging」。** 每个产物先写临时目录，但读的时候要分清两种输入：

| 生成器 | 该读哪份 | 为什么 |
| --- | --- | --- |
| `index-logs.mjs` | **上一版** `data/history.json` | 它是增量起点，就该是仓库/缓存里那份 |
| `build-data.mjs` | **本轮 staging 里刚写出的** `history.json` | 它是 `index-logs` 的下游消费者 |

后者用 `lib/snapshot-out.js` 的 `stagedPath(name)`（优先 staging，缺失才回退 `data/` 并打警告）。
两者搞混的代价是连续三次 CI 失败，见「已修正的错误」#15。

## 只在「抓到链上数据后」才执行的分支

这张表是一次事故的产物：`build-data.mjs` 的 summary 引用了 Base 段**块内**声明的 `bridgeBlocks`，
每个不传 `--skip-base` 的运行都会崩 —— 也就是 CI 的每一次。而本机因为 Blockscout 被阻，一直传
`--skip-base`，那行代码**从未执行过**：「本机跑得通」这句话是真的，但毫无意义。

判据：**新写一个分支时，问它「抓不到数据时会不会执行」。不会，就必须给它一个 fixture。**

| 脚本 | 分支 | 本机可达？ | 依据 |
| --- | --- | --- | --- |
| `build-data.mjs` | timeline 段全部 | ✅ | 读本地 `history.json` + L1 RPC |
| | **Base 段全部**（blockscout 抓取、burn callers、bridge 窗口扫描） | ❌ | 本机 node 连不上 `base.blockscout.com` |
| | `bs()` 的重试与 `No logs found` 分支 | ❌ | 同上 |
| | `missing.length` → 用 Base RPC 补时间戳 | ❌ | 只有 blockscout 没给 `timeStamp` 时才走 |
| | Base 段的 `bridgeLogs` 窗口扫描 | ⚠️ 代码可达，但 3–5 分钟 | L1 RPC 可用 |
| | **summary 的 `baseSummary` 分支** | ❌ | ← 出事的这一条，现由 fixture 覆盖 |
| `index-logs.mjs` | 全量扫描路径（无 `history.json` 或 `--force`） | ⚠️ 可达但极慢 | 160 个窗口 |
| | 增量路径（`resume at scanTo − 200`） | ✅ | 每小时实际走这条 |
| | `window partial: …` | ⚠️ 偶发 | 某窗口 `eth_getLogs` 失败时 |
| `scan-swaps.mjs` | 窗口全部失败 → 写出空结果 | ✅ 可达 | 由 `verify-snapshots` 的「scan actually saw swaps」拦住 |
| `fetch-messages.mjs` | 整个脚本（分页抓取、`important` 缺失警告） | ❌ | 同样依赖 blockscout |
| `fetch-bridge-history.mjs` | 窗口扫描 | ✅ | L1 RPC |
| | 0 条 transfer | ⚠️ 现在会**失败退出** | 一周内不可能没有转账，0 条即抓取失败 |
| `collect.mjs` | 逐项读数失败（`errors` 分支） | ✅ | RPC 抖动时 |
| | Base 侧读数 | ✅ | Base RPC 可达（与 blockscout 不同） |

排查中顺手修掉的同类问题：

1. **`fetch-bridge-history.mjs` 扫描失败时会写出一份「看起来正常」的快照**：`logs` 为空 → 所有历史点
   都等于今天的余额 → 页面显示「没有变化」。现在 0 条 transfer 直接退出非零，刷新保留旧快照。
2. **`index-logs.mjs` 每小时全量重扫 16 万区块**：`start` 用的是 `scanFrom`（索引地板 25887000），
   而不是上次停下的 `scanTo`。现在从 `scanTo − 200` 续扫（200 区块的重组余量），1 个窗口、约 1 秒；
   `totalLogs` 仍是**整份索引**的条数（页面拿它说「扫描了 N 条」），另加 `scannedLogs` / `carriedLogs`
   两个诊断字段。

### 增量索引的三条边界规则

合并逻辑抽在 `lib/log-index.js`，由 `scripts/test-log-index.mjs`（31 项）逐条覆盖。三条都不是格式问题，
而是数据丢失边界：

| 规则 | 写法 | 漏掉会怎样 |
| --- | --- | --- |
| **carry-over 用「实际扫描覆盖的区间」** | `block < start \|\| block > head` 才保留 | 只写 `block < start`：当 `head < start` 时扫描循环**一次都不执行**，而那段旧日志已被排除在 carry 之外 → 索引静默少一截。测试用例：`start=250, head=240` 必须保留全部 |
| **`scanTo` 不能倒退** | `nextScanTo(head, prevScanTo) = max(head, prevScanTo)` | 链头瞬时偏低（端点滞后 / 重组）会让下次从更低处续扫，也谎报索引覆盖范围 |
| **`head < scanTo − 200` 判定为异常** | `classifyHead()` → `ok` / `lagging` / `behind` | 端点滞后几个区块是常态（保留 `scanTo` 继续即可，容差 200）；差出几百上千区块不是滞后，是选错了链或端点坏了 —— 这时**保留旧索引并非零退出**，绝不重写历史 |

### 端点选择：为什么不问「第一个答复的」

`Rpc.blockNumber()` 返回**第一个答复的端点**的高度。对仪表盘没问题，对索引器是个陷阱：一个落后几千区块
的节点也会正常答复，于是「本次扫描范围」由一个坏端点决定。索引器现在用
`Rpc.highestBlockNumber()`：**并发问所有端点，取最高的那个**，日志里打印来源与端点间高度差：

```
head block 26046301 from https://gateway.tenderly.co/public/mainnet
  4 endpoints answered; spread 0 block(s) between the highest and the lowest
```

高度差大于 200（重组余量）时会额外提示 —— 那说明若按「第一个答复」走，这次就真的会少扫一段。

## 已修正的错误（不要再犯）

1. **sIMD 已 renounce ownership** —— 区块 26014063，tx `0x519fdbdd…`。
   页面曾硬编码「未调用」。现按合约分组渲染：StakedIMD 已放弃，其余 5 个仍 EOA 控制，**8 项权限有效**。
2. 四个下游合约（BurnExecutor / StakedIMD / RewardDistributor / $IMD）**都已验证**，不是未验证。
3. BurnExecutor **不做 burn**，它把 IMD 桥到 Base。页面上的数字是**待桥接销毁**的队列，不是已销毁量。
4. **不要用 `eth_call` 查历史区块。** 那需要 archive 节点：公共 RPC 时好时坏，而它给出答案时会与
   Transfer 日志相差数千 IMD（实测 7d 前：日志 20,372 IMD vs archive 0.0000003 IMD）。
   队列历史走 `scripts/fetch-bridge-history.mjs`（Transfer 日志重建），产物 `data/bridge-history.json`。
5. `previewBridge()` **不 revert**。此前的 revert 是 ABI 签名写成 `previewBridge()()` 的 bug。
6. 源码里**没有** `BONDING_LIVE`；两个滞留桶是设计如此。
7. 状态机曾有一个 `ARMED` 值不在三态定义内，已删除。
8. `page-sub` 曾在 LIVE 状态下仍显示「已停 N 天」，已修（由 `preview-live.mjs` 抓出）。
9. **模板字面量参数提取不能用正则。** `/\$\{([^}]*)\}/` 会在嵌套模板处截断
   （`` `地址：${list.map((a) => `<code>${esc(a)}</code>`)}` `` → 半截表达式），
   拼进 `tr()` 调用就是语法错误。`lib/scan-strings.js` 的 `templateToZh()` 是花括号 + 引号感知的走查，
   并有 `isBalanced()` 在 `apply-i18n.mjs` 里做安全阀。
10. **`process.exit()` 会截断未 flush 的 stdout**（Windows 管道下尤其明显）：测试全绿却只打印一行。
    测试脚本在 exit 前 `await process.stdout.write("")`。
11. **`daysOfBuffer` 把秒当成了天**：算出「秒数」后又**乘** 86400，而应该**除以** 86400。
    结果是一个只够 304 秒的缓冲被写成 26,270,609 天（差 86400² ≈ 7.46×10⁹ 倍）。
    量纲表现在在 NOTES §17，`sanityCheckDerived()` 会拦下 > 365 天的值。
12. **`ethInPoolUsd` 把 ETH 又当成 IMD 定价了一次**：`ethInPool` 本来就是 ETH，却又过一次
    `valueInEth()`（IMD→ETH），于是 $57,039 被写成 $115.75（差 ≈ 493 倍 = 1/ethPerImd）。
    量级检查现在要求它与 `ethInPool × ethUsd` 相差不超过 10 倍。
13. **量级断言本身会形同虚设**：`sanityCheckDerived()` 第一版的 `num()` 只认 bigint/number，
    而快照里的数值全是 JSON 字符串 → 每条检查都静默跳过，检查"全绿"。自测（用已知错误值反向验证）
    当场抓出来了。**断言必须被证明会失败**。
14. **位置参数会被新选项污染**：`scan-swaps.mjs` 用 `process.argv[2]` 当小时数，
    加上 `--out-dir <tmp>` 后它读到的是 `--out-dir`，`Number("--out-dir")` = NaN，
    于是「扫描 0 笔交易」被当成成功结果写出。选项现在先被剥离。
15. **下游生成器读了「提交进仓库的旧输入」，而不是本轮 staging 的产物。** `build-data.mjs` 直接
    `readFileSync(new URL("../data/history.json", …))`，无视 `index-logs.mjs` 几分钟前刚写进 staging 的
    新索引。而 workflow **故意不提交** `data/history.json`（靠 `actions/cache` 传递），所以仓库里那份是
    永不前进的冷启动基线：每次定时运行都用同一份冻结索引重建 timeline，得到同一个 `scannedTo`
    （26044665）和同一个 `trims`（256），而仓库里的 `timeline.json` 是 261 —— `verify-snapshots.mjs`
    每次都正确地判「history went backwards」，**连续三次失败，数字逐字节相同**。
    **「两次运行报同一个块高」这个巧合才是线索**：实时端点不可能相隔一小时报同一个 head，而同一轮里
    不读索引的 `bridge-history.json` 反而通过了它自己的「不回退」检查（head ≥ 26046189）。
    **看起来像端点滞后，实际是路径。** 修法：`stagedPath()` + `scripts/test-staged-input.mjs`
    （同时断言「读到 staging」与「回退时答案不同」，证明断言会失败）。
16. **`git update-index --skip-worktree` 会让 `git status` 撒谎。** `data/history.json` 曾被设上这个位
    （大概是为了让本地跑完索引后工作区保持干净），于是它本地是 26046305、git 里是 26044665，而
    `git status` 与 `git diff` 都报「无改动」。定位 #15 时正是被这点误导，先怀疑了 RPC 端点。
    位已清除：**这个文件的本地改动现在会显示出来，这是有意的** —— 它不进 git 是 CI 的设计
    （见「快照刷新」），不是因为它没变。
17. **`catch {}` 让「被限流的窗口」伪装成「链上事件变少了」。** `build-data.mjs` 的 L1 bridge 扫描
    每轮发 247 个 `eth_getLogs` 窗口，失败被 `catch {}` 静默吞掉：无日志、无重试、无痕迹。CI 上
    有一个窗口被限流，于是 `base.json` 的 bridges 从 62 变成 61 —— `verify-snapshots.mjs` 正确地
    拦下了它，但报的是「bridge count did not shrink (62 → 61)」，**读起来像链上变化，不像一次失败的
    HTTP 请求**。本机同样 247 个窗口跑出 62 条、0 失败，说明是 CI 侧限流（runner 的出口 IP）。
    修法：扫描逻辑提取到 `lib/log-scan.js` 的 `scanLogWindows()` —— 每窗口重试 3 次（每次 `call`
    自身还会遍历所有端点）、计数并上报失败窗口；`build-data.mjs` 只要有任何窗口没答复就**抛错**，
    宁可不发布，也不发布一份缺事件的 `base.json`。`scripts/test-log-scan.mjs`（19 条）里的
    「the failure reaches the caller」正是旧行为会挂掉的那条。
    同一段还把 `l1.blockNumber()`（第一个答复的端点）换成 `highestBlockNumber()`，避免滞后端点
    截短扫描范围。**凡是「拉取失败」和「数据真的变少了」无法区分的地方，都要按这个模式处理。**
18. **`optionalOutputs` 只说明「可以缺」，不说明「不要发布」—— 但 promote 循环只遍历了 `outputs`。**
    `refresh-snapshots.mjs` 的发布阶段写的是 `for (const file of step.outputs)`，而 `base.json` 在
    `optionalOutputs` 里（因为 `--skip-base` 时它不产出）。后果：**CI 每轮都生成了新鲜的
    `base.json`、`verify` 也校验了它，然后连同 staging 目录一起删掉** —— `data/base.json` 永远停在
    本地最后一次手动生成的那份（当天凌晨 03:36）。**整件事没有任何东西失败**：job 全绿、commit
    干净、`base.json` 只是不再更新，唯一迹象是页面的过期横幅。
    识别方法：CI 成功后 `git show --stat` 里没有 `base.json`，而它带 `builtAt`、本该每轮都变。
    修法：发布逻辑提取到 `lib/snapshot-promote.js`，遍历 `[...outputs, ...optionalOutputs]`；
    `scripts/test-promote.mjs`（16 条）里有一条直接断言「旧代码用的 outputs-only 清单会漏掉
    base.json」。**与 #15、#17 同类：某个步骤在沉默中降级，而不是报错。**

## 测试

```bash
node scripts/selftest.mjs            # 46  keccak / ABI / 模板参数提取 / 快照新鲜度
node scripts/check.mjs               # 26  id 接线 / 禁用内容 / 只读方法 / 中文字面量归零 / 文案覆盖
node scripts/check-derived.mjs       # 13  derived 量级审计 + 已知错误值反向验证 + 未使用字段
node scripts/test-simulate.mjs       # 35  模拟器 + 真实历史 trim 端到端复现
node scripts/test-state-machine.mjs  # 18  状态判定与 capFloor 变更翻转
node scripts/test-bridge.mjs         # 24  第二道门趋势判定 + 文案不得把「待桥接」说成「已销毁」
node scripts/check-html-i18n.mjs     # --  index.html 里会漏进英文模式的中文（应为 0）
node scripts/check-terminology.mjs   # --  术语表跨语言一致性（15 组在用术语，0 不匹配）
node scripts/check-summaries.mjs     # --  留言原文与中文摘要并列，供人工校对
node scripts/test-build-data.mjs     # 21  build-data 全流程离线跑通（fixture 覆盖本机不可达的 Base 段）
node scripts/test-staged-input.mjs   #  8  下游生成器读本轮 staging 产物，而不是仓库里的旧索引
node scripts/test-log-index.mjs      # 31  事件索引的增量边界（carry-over / scanTo / 链头异常）
node scripts/test-log-scan.mjs       # 19  L1 日志分窗扫描：重试、失败必上报、绝不静默丢窗口
node scripts/test-promote.mjs        # 16  发布清单（optionalOutputs 必须与 outputs 一起发布）
node scripts/verify-snapshots.mjs    # --  快照形状 + 不能倒退（刷新流程的守门人）
node scripts/preview-live.mjs        # 16  合成 LIVE 数据，断言恢复后不残留「已停」
node scripts/test-render.mjs         # 128 无头渲染（DOM stub + 真实网络 + 中英切换后零中文/零裸键名）
```

`npm test` 依次跑上面全部（除取证类与 `verify-snapshots`，后者需要一份待校验的产物）。

截图（交付用，需要本机 Chrome/Edge）：

```bash
node scripts/serve.mjs 5173
node scripts/shoot.mjs --out shots --url http://127.0.0.1:5173     # → shots/pool4-{zh,en}.png
```

取证类（需网络，慢）：`verify-ownership.mjs`、`audit-owner-powers.mjs`、`verify-two-doors.mjs`、
`replay.mjs`、`simd-ratio-history.mjs`、`scan-swaps.mjs`、`fetch-messages.mjs`、`fetch-bridge-history.mjs`。

## 部署

**线上**：**`https://imd.kymmppee.xyz`**（自定义域，直连可访问）与
`https://pool4-dashboard.18569663yz.workers.dev`（Worker 默认域）—— Cloudflare **Workers + 静态资源**，
由 Workers Builds 的 Git 集成自动部署（push → 构建 → `npx wrangler deploy`）。

| 项目 | 值 |
| --- | --- |
| Worker 名 | `pool4-dashboard` —— **必须与 `wrangler.jsonc` 的 `name` 一致**，改一个就要改另一个 |
| 构建命令 | `rm -rf dist && mkdir -p dist && cp -r index.html _headers README.md assets lib locales data dist/ && rm -f dist/data/history.json dist/data/_*.json dist/data/strings-*.json dist/data/README.md` |
| 部署命令 | `npx wrangler deploy`（默认值，读仓库根的 `wrangler.jsonc`） |
| 根目录 | `/` |
| 一次构建 | ~21 秒（初始化 2s + 克隆 2s + 安装 0.5s + 构建 0.25s + 部署 17s） |

**为什么是 Workers 而不是 Pages**：两者免费额度计费方式不同 —— Pages 按**构建次数**
（500 次/月），每小时一次 ≈ 730 次会在月中静默停掉；Workers Builds 按**构建分钟**
（3,000 分钟/月），每小时一次 ≈ 255 分钟，只用掉 8.5%。**「部署频率 = 数据新鲜度」这个旋钮，
在 Workers 下不再受额度限制。**

**可达性（实测，2026-09-24）**：`*.workers.dev` 在中国大陆**直连不通**（`000`，走代理才 `200`）；
绑上 `imd.kymmppee.xyz` 之后**直连返回 `200`** —— 两者走的是 Cloudflare 不同的 IP 段
（自定义域落在 `188.114.96.11` / `188.114.97.11`）。**所以绑自定义域不只是让链接好看，它实际决定了
中文用户能不能打开。** 域名解析：A `188.114.96.11`、`188.114.97.11`，AAAA `2a06:98c1:3120::b`、
`2a06:98c1:3121::b`；MX 走 Cloudflare Email Routing，与 Worker 互不影响。

**`_headers` 的实测行为**（部署后逐条验证过）：`/*`、`/assets/*`、`/lib/*`、`/data/*`、`/*.md`
全部按写生效。**HTML 故意不写规则** —— Workers 把 `/index.html` 以 307 重定向到 `/`，键在
`/index.html` 上的规则永远不会命中（旧版就有一条，从未生效过），而 `/` 的默认值
`public, max-age=0, must-revalidate` 正是想要的：页面永远拿最新代码。

本地预览：

```bash
node scripts/serve.mjs 5173
```

⚠️ **后台 job 会在每一轮对话结束时被清理**，进程跟着死。要让它跨轮次存活，
必须用 WMI 独立创建进程：

```powershell
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = "node scripts/serve.mjs 5173"   # 工作目录需自行处理
}
# cloudflared 同理，用 --logfile 拿 URL（避免 shell 重定向）
```

## 待办

- [ ] 池 A 历史曲线 —— 状态已经翻转（cap 追平池子、状态转 CRITICAL），叙事可以按新状态重写了
- [ ] 危险交易监控（7 个函数，含 `setBaseBurnReceiver` 的事件检测）
- [ ] 数据面（7 个指标 + `originalRequest` 开放度 + `/requests/capabilities` 实时价格）
