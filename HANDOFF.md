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

## 测试

```bash
node scripts/selftest.mjs            # 36  keccak / ABI 已知答案 + 模板参数提取
node scripts/check.mjs               # 26  id 接线 / 禁用内容 / 只读方法 / 中文字面量归零 / 文案覆盖
node scripts/test-simulate.mjs       # 35  模拟器 + 真实历史 trim 端到端复现
node scripts/test-state-machine.mjs  # 18  状态判定与 capFloor 变更翻转
node scripts/test-bridge.mjs         # 24  第二道门趋势判定 + 文案不得把「待桥接」说成「已销毁」
node scripts/check-html-i18n.mjs     # --  index.html 里会漏进英文模式的中文（应为 0）
node scripts/check-terminology.mjs   # --  术语表跨语言一致性（15 组在用术语，0 不匹配）
node scripts/preview-live.mjs        # 16  合成 LIVE 数据，断言恢复后不残留「已停」
node scripts/test-render.mjs         # 116 无头渲染（DOM stub + 真实网络 + 中英切换后零中文/零裸键名）
```

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
