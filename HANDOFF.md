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

## 快照刷新（GitHub Actions）

页面上所有「历史」——烧毁曲线、24h/7d 趋势、链上留言时间线——都来自 `data/` 下的预生成 JSON。
它们由 `.github/workflows/refresh-snapshots.yml` 每小时刷新一次（cron `17 * * * *`，避开整点；也支持
`workflow_dispatch` 手动触发）。

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
—— 否则仓库每小时长 7 MB。

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

排查中顺手修掉的两个同类问题：

1. **`fetch-bridge-history.mjs` 扫描失败时会写出一份「看起来正常」的快照**：`logs` 为空 → 所有历史点
   都等于今天的余额 → 页面显示「没有变化」。现在 0 条 transfer 直接退出非零，刷新保留旧快照。
2. **`index-logs.mjs` 每小时全量重扫 16 万区块**：`start` 用的是 `scanFrom`（索引地板 25887000），
   而不是上次停下的 `scanTo`。现在从 `scanTo − 200` 续扫（200 区块的重组余量），1 个窗口、约 1 秒；
   `totalLogs` 仍是**整份索引**的条数（页面拿它说「扫描了 N 条」），另加 `scannedLogs` / `carriedLogs`
   两个诊断字段。

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
node scripts/test-build-data.mjs     # 20  build-data 全流程离线跑通（fixture 覆盖本机不可达的 Base 段）
node scripts/verify-snapshots.mjs    # --  快照形状 + 不能倒退（刷新流程的守门人）
node scripts/preview-live.mjs        # 16  合成 LIVE 数据，断言恢复后不残留「已停」
node scripts/test-render.mjs         # 116 无头渲染（DOM stub + 真实网络 + 中英切换后零中文/零裸键名）
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

**没有任何托管凭证。** 本地预览：

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

持久发布（任选，需账号）：

```bash
npx wrangler pages deploy . --project-name pool4-dashboard
npx vercel --prod
```

## 待办

- [ ] 池 A 历史曲线 —— 状态已经翻转（cap 追平池子、状态转 CRITICAL），叙事可以按新状态重写了
- [ ] 持久托管（需用户凭证）
- [ ] 预生成快照的更新频率：`timeline/base/volume/messages/bridge-history` 都靠手动跑脚本，
      自动更新需要 GitHub Actions
- [ ] 危险交易监控（7 个函数，含 `setBaseBurnReceiver` 的事件检测）
- [ ] 数据面（7 个指标 + `originalRequest` 开放度 + `/requests/capabilities` 实时价格）
