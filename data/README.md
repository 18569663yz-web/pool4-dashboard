# data/ 目录说明

> **给接手的人**：这个目录里的文件名不是随意起的。`_` 前缀的文件**不是垃圾** ——
> 它们是 i18n 工具链的输入，页面运行时不读，但 `scripts/merge-i18n.mjs` 会读。
> 删掉它们不会让线上页面出错，但会让「以后加新文案」失去整套可复用的流程。

---

## 一、页面运行时读取（会被部署到线上）

`assets/app.js` 直接 `fetch()` 这几个：

| 文件 | 内容 |
| --- | --- |
| `baseline.json` | 当前链上状态快照（也用于离线交叉验算） |
| `base.json` | Base 链侧数据（Fren Pet / OFTAdapter / 销毁接收器） |
| `bridge-history.json` | BurnExecutor 的 IMD 余额历史 —— 24h / 7d 趋势的唯一来源 |
| `messages.json` | 链上留言原始抓取（按区块号索引） |
| `messages.zh.json` | 留言的中文摘要，`reviewed` 字段可人工校对 |
| `timeline.json` | trim 与 backstop 平仓的事件时间线 |
| `volume.json` | 两个 ETH/IMD 池的 24h 交易量 |

**`history.json`（约 7 MB）不在此列** —— 它是构建期的全量事件索引，被 `.assetsignore`
排除、不部署；CI 通过 `actions/cache` 在两次运行之间携带它，所以每次刷新都是增量的。

---

## 二、i18n 工具链的输入（**不要删**）

`scripts/merge-i18n.mjs` 会读全部 `_*.json` 与 `strings-i18n*.json`（见该脚本 L18 / L28 / L39 / L54）。

| 文件 | 作用（摘自文件自身的 `_note` 字段） |
| --- | --- |
| `strings-i18n.json` · `strings-i18n-2.json` | 「字面量 → 键」骨骼，每轮迁移一批 |
| `_en1.json` ~ `_en5.json` | 对应的英文译文，分批产出 |
| `_extra.json` | 手工写的键 —— 扫描器误匹配的嵌套模板、列表分隔符等 |
| `_html.json` | `index.html` 的静态文案（`data-i18n` / `data-i18n-html` 的初值） |
| `_data-copy.json` | `lib/contracts.js` 里的用户可见文案（合约角色、owner 权限后果、监控来源） |
| `_runtime.json` | 运行期提示（快照过期告警等） |
| `_awaiting-copy.json` | 「待桥接到 Base 销毁」的文案；`scripts/test-bridge.mjs` 也读它 |
| `_proofread.json` | 校对修正值 —— **对 copy block 的键以本文件为准**（权威值） |
| `strings-todo.json` | 迁移清单，由 `scripts/extract-strings.mjs --write` 生成 |

**这套流程是分步、可校对、可回滚的**：

```
extract-strings.mjs --write   →  data/strings-todo.json          （抽清单）
build-i18n-skeleton.mjs       →  data/strings-i18n-K.json        （生成键与参数）
（人工/AI 分批翻译）           →  data/_enK.json                  （分批译文）
merge-i18n.mjs                →  locales/zh.json + en.json       （合并 + 覆盖率校验）
apply-i18n.mjs                →  回写 assets/app.js
check.mjs                     →  断言「app.js 字符串字面量零中文」
```

`check.mjs` 的 i18n 防回归断言是这条链的守门人。**如果把这批中间文件删了，
断言仍在，但重新走一遍流程就没那么容易了。**

---

## 三、原始抓取数据（取证用）

| 文件 | 内容 |
| --- | --- |
| `_txs.json` | Blockscout 返回的原始交易数组（`messages.json` 的原料） |

保留它的理由：**留言面板的每一条都能回溯到原始返回**。如果哪天有人质疑某条留言的
解码结果，这个文件是证据链的起点。
