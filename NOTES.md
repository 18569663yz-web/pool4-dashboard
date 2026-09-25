# NOTES.md — POOL4 `CappedBurnHook` 机制源码级说明

> **结论先行**：烧毁引擎**已熄火约 10 天**。池子仍在正常交易（最新一笔 swap 在 31 个区块前），
> 但自区块 **25964166** 之后再没有发生过一次 trim。原因是持续的净买入把市场头寸里的 IMD
> 抽到了 `inventoryCap` 以下，而 cap 已被 `capFloor` 锁死在 20,000 IMD，**不会因为库存回升而上调**。
>
> 点火距离（当前链上实测）= `inventoryCap − tokensInPool` = **6,594.16 IMD**（随交易实时波动）。

本文所有结论都对应到具体源码行。行号基准见下节。

---

## 0. 源码基准与可复现性

| 项 | 值 |
| --- | --- |
| 主源码 | `_imd_research/verified/hook/CappedBurnHook.sol`，**1285 行** |
| 来源 | Blockscout `api/v2/smart-contracts/0xc6c965bd164c483e87d0b550671798e9a3602840` |
| 验证时间 | `verified_at = 2026-09-19T20:42:55Z` |
| 编译器 | `solc 0.8.30+commit.73712a01`，optimizer on，200 runs，EVM `osaka` |
| 代理 | **无**（`proxy_type = null`，不可升级） |

**源码一致性核对**：仓库里另有一份早期从 Etherscan 侧缓存的 `_imd_research/CappedBurnHook.sol`（1286 行）。
两份做规范化 diff（忽略行尾空白）后**没有任何内容差异**，唯一区别是末尾多一个空行
（68424 vs 68419 字节）。因此 Etherscan 与 Blockscout 的验证源码是同一份编译输入，
本文行号对两者都成立。

> **与提示词快照的冲突 #1**：提示词称 `BurnExecutor` / `RewardDistributor` / `StakedIMD` / `$IMD`
> 「未验证」。实测这四个**全部已在链上验证**（Blockscout，见下表）。因此本说明的机制分析
> **不依赖任何反编译或猜测**，四个下游合约的源码同样可读。

| 合约 | 地址 | 验证 | 源码行数 |
| --- | --- | --- | --- |
| CappedBurnHook | `0xc6c965bd164c483e87d0b550671798e9a3602840` | ✅ | 1285 |
| RewardDripper | `0xe6D3De6daEAf327fCA42745f1998FcD989e00884` | ✅ | 196 |
| BurnExecutor | `0xe29386719C155B6847aD5a4E97C6674f10ffc750` | ✅ | 314 |
| RewardDistributor | `0x9046739E1535B40EfBe6AB3f45d0024b690eCA30` | ✅ | 107 |
| StakedIMD (sIMD) | `0x9efa934d9fad4ae28c998a40195646b965a97247` | ✅ | 169 |
| $IMD (`BridgedFP`) | `0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7` | ✅ | 2937 字符 |

**池 B 的 poolId**（本仓库计算，用 ethers v6 独立交叉验证）：

```
PoolKey = {currency0: 0x0, currency1: 0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7,
           fee: 10000, tickSpacing: 60, hooks: 0xc6c965bd164c483e87d0b550671798e9a3602840}
poolId B = 0x415829f72e9f54531c26eae76f107618540e898a45d6ae35959e143f5faca704
poolId A = 0xb07d640fd9e2eb9dc81b953c8e4fd006bdfeaf276010fb5418eb763ca15abfb3   ← 与提示词给定值一致
```

池 A 的 poolId 与提示词给的已知值吻合，这同时验证了我们的 keccak-256 实现与 ABI 编码。
`CappedBurnHook.poolId()`（L324-326）在链上也返回同一个值，可用于页面上复核。

---

## 1. `pendingTrim()` 的完整实现与返回值语义

**源码 L352-357：**

```solidity
function pendingTrim() public view returns (uint256) {
    uint256 held = tokensInPool();
    uint256 excess = held > inventoryCap ? held - inventoryCap : 0;
    // Mirror _applyCap: an excess below minTrimTokens is not trimmed by the next swap, so report 0.
    return excess < minTrimTokens ? 0 : excess;
}
```

依赖 `tokensInPool()`（L337-342）：

```solidity
function tokensInPool() public view returns (uint256) {
    if (positionLiquidity == 0) return 0;
    return SqrtPriceMath.getAmount1Delta(
        TickMath.getSqrtPriceAtTick(tickLower), currentSqrtPriceX96(), positionLiquidity, false
    );
}
```

**语义回答：**

- **单位**：IMD 的 **wei**（uint256，18 位小数）。不是人类可读的代币数。页面显示前必须除以 1e18。
- **是「超出 cap 的 IMD 数量」吗**：**是，但要加一个限定**。它是 `max(0, held − inventoryCap)`，
  再被 `minTrimTokens` 门限截断。当前 `minTrimTokens = 0`（链上实测），
  所以 `excess < 0` 恒为假，返回值就是纯粹的 `max(0, held − cap)`。
- **它是「预测下一次 swap 会烧多少」吗**：**不是**。它是**当前区块状态下**的静态读数。
  `_applyCap()`（L952）在 `afterSwap` 里用的是 swap **结算之后**重算的 `held`（L957-958），
  与 `pendingTrim()` 读到的值不同。`pendingTrim()` 的意义是「**此刻**池子超出 cap 多少」——
  只要它 > 0，**下一笔经过这个 hook 的 swap 就会触发 trim**（因为 `_applyCap` 在每笔 swap 后都跑）。
- **它会在没有交易时自己变化吗**：会。`held` 依赖 `currentSqrtPriceX96()`，
  而 v4 的 slot0 价格只有在 swap 时才变，所以实际上它**只在 swap 后跳变**。
  但注意 `pendingTrim()` 是 view，任何时候调用都会用当时的价格重算。

**页面应直接调用 `pendingTrim()` 作为权威值**，而不是自己算 `cap − held`：
两者在 `minTrimTokens > 0` 时会分叉（owner 可以把它改成非零）。

---

## 2. `inventoryCap` 在哪些地方被写入

`inventoryCap` 声明在 **L224**：`uint256 public inventoryCap;`

全部**写入点**共 5 处（grep 全文件确认）：

| # | 行号 | 函数 | 调用者 | 条件 / 语义 |
| --- | --- | --- | --- | --- |
| 1 | **L986** | `_applyCap()` | **任何人（经 swap 触发）** | ratchet 下调：`inventoryCap = next`，仅在 `next < inventoryCap` 时（L971） |
| 2 | **L406** | `setCapFloor()` | `onlyOwner` | `if (inventoryCap < newFloor) inventoryCap = newFloor;` — **只能上调** |
| 3 | **L527** | `openMarket()` | `onlyOwner` | `inventoryCap = tokensDeposited;` 开盘冻结为实际存入量 |
| 4 | **L532** | `openMarket()` | `onlyOwner` | `if (inventoryCap < capFloor_) inventoryCap = capFloor_;` 保证不变量 |
| 5 | **L557** | `fundInventory()` | `onlyOwner` | `inventoryCap += tokensDeposited;` 注入库存时同额上调 |

**关键点：只有 L986 这一条路径不需要 owner 签名。** 其余四条全部是 `onlyOwner`。

对应源码：

```solidity
// L403-407
function setCapFloor(uint256 newFloor) external onlyOwner {
    emit CapFloorUpdated(capFloor, newFloor);
    capFloor = newFloor;
    if (inventoryCap < newFloor) inventoryCap = newFloor;
}

// L548-565（节选）
function fundInventory(uint128 liquidity, uint256 maximumTokenAmount) external payable onlyOwner {
    ...
    positionLiquidity += liquidity;
    inventoryCap += tokensDeposited;        // L557
    lastCapDecayAt = block.timestamp;       // L561
    capDecayRemainder = 0;                  // L562
    ...
}
```

**注意 `fundInventory` 不会制造 trim**：它同时把 `positionLiquidity`（L556）和
`inventoryCap`（L557）增加同样的 `tokensDeposited`，所以 `held` 与 `cap` 同步上升，
`excess` 不变。它唯一的效果是把 cap 抬高，从而**重置点火距离**。

**owner 也无法单方面点火**：`setCapFloor` 只会抬高 cap（L406），永远不会把 cap 降到 `held` 以下。
所以**没有任何 owner 调用可以让 trim 立刻发生**——trim 只能由真实的卖出交易推动。

---

## 3. ratchet 是单向的吗

**是，严格单向向下。** 三条证据：

1. **公式本身只减不增**（L963）：
   ```solidity
   uint256 next = inventoryCap - ((inventoryCap - held) * ratchetBps) / BPS_DENOMINATOR;
   ```
   `(inventoryCap − held) * ratchetBps / 10000 ≥ 0`，所以 `next ≤ inventoryCap`。
   当 `ratchetBps = 10000`（满棘轮，当前值）时 `next = held`；当 `ratchetBps = 0` 时 `next = inventoryCap`（不动）。

2. **写入被守卫**（L971）：`if (next < inventoryCap) { ... inventoryCap = next; }` —— 相等或更大都不写。

3. **整个分支只在 `held < inventoryCap` 时进入**（L960）。库存上升到 cap 以上时走的是 trim 分支（L991+），
   **cap 完全不动**。

**回答「库存上升时 cap 会跟着上调吗」：不会。** 库存上升（买入）只会让 `held` 更低，
从而**继续压低** cap（直到 `capFloor` 或日衰减限额拦住）。要抬高 cap，**只有 owner 调 `fundInventory()`
（L557）或 `setCapFloor()`（L406）两条路**。

**当前状态正是 ratchet 的终点**：`inventoryCap == capFloor == 20,000 IMD`（链上实测两者相等）。
此时 L969 的 `if (next < capFloor) next = capFloor;` 会把 `next` 拉回 `capFloor`，
于是 `next == inventoryCap`，L971 不成立，**不写入、不发事件、也不消耗衰减额度**。
所以 cap 冻结在 20,000 —— 这正是「棘轮到地板」的确切含义。

---

## 4. trim 的触发点在哪个回调里

**在 `afterSwap` 里，且只在这里。** 没有任何外部调用入口可以触发 trim。

`getHookPermissions()`（**L863-880**）声明：

```solidity
return Hooks.Permissions({
    beforeInitialize: true,
    afterInitialize: false,
    beforeAddLiquidity: true,
    afterAddLiquidity: false,
    beforeRemoveLiquidity: false,
    afterRemoveLiquidity: false,
    beforeSwap: false,          // L871
    afterSwap: true,            // L872
    ...
});
```

`afterSwap`（**L906-927**）的执行顺序：

```solidity
function afterSwap(address, PoolKey calldata key, IPoolManager.SwapParams calldata, BalanceDelta, bytes calldata)
    external returns (bytes4, int128)
{
    _requirePoolManagerAndPool(key);          // L910 只有 PoolManager + 本池能调
    _maybeRedeemMaturedClaims();              // L911 结算「之前区块」的 claim（L1126-1130）
    if (positionLiquidity != 0) _collectFees(tickLower, tickUpper);  // L915 先把本次 LP 费收进费账本
    _applyCap();                              // L919 ★ trim / ratchet 在这里
    _updateDeploymentFloor(currentTick());    // L924 放置地板（向上即时、向下限速）
    _observeTick();                           // L925 维护区块滞后参考价
    return (IHooks.afterSwap.selector, int128(0));
}
```

**trim 的确切条件**（`_applyCap`，**L991-992**）：

```solidity
uint256 excess = held - inventoryCap;
if (excess == 0 || excess < minTrimTokens) return;
```

所以严格条件是 **`held > inventoryCap` 且 `excess ≥ minTrimTokens`**。
`held == inventoryCap` 时 `excess == 0` → 直接 return，**不 trim**。

`held` 是在**本次 swap 结算后**重算的（L956-958），且 `_collectFees`（L915）先跑，
把本次手续费单独收走，所以 trim 烧的是**纯本金**，不会把 LP 费一起烧掉。

**顺序上的一个细节**：L911 的 `_maybeRedeemMaturedClaims()` 只结算**早于当前区块**的 claim
（L1127：`if (block.number <= lastClaimBlock) return;`），因为同一区块里 swap 的代币还没真正到 PoolManager。

---

## 5. `capDecayTokensPerDay` 与 `ratchetBps` 如何共同决定一次调整的幅度

**完整公式**（`_applyCap` 的 ratchet 分支，**L960-989**，逐行）：

```solidity
if (held < inventoryCap) {                                                  // L960
    uint256 next = inventoryCap - ((inventoryCap - held) * ratchetBps) / BPS_DENOMINATOR;  // L963
    uint256 elapsed = block.timestamp - lastCapDecayAt;                     // L965
    uint256 allowance = (capDecayTokensPerDay * elapsed) / 1 days;          // L966
    uint256 rateFloor = inventoryCap > allowance ? inventoryCap - allowance : 0;  // L967
    if (next < rateFloor) next = rateFloor;                                 // L968
    if (next < capFloor) next = capFloor;                                   // L969
    if (next < inventoryCap) {                                              // L971
        uint256 used = inventoryCap - next;                                 // L972
        if (capDecayTokensPerDay != 0) {                                    // L980
            uint256 numerator = used * 1 days + capDecayRemainder;          // L981
            lastCapDecayAt += numerator / capDecayTokensPerDay;             // L982
            capDecayRemainder = numerator % capDecayTokensPerDay;           // L983
        }
        emit CapRatcheted(inventoryCap, next);                              // L985
        inventoryCap = next;                                                // L986
    }
    return;
}
```

**逐项语义：**

| 量 | 行 | 含义 |
| --- | --- | --- |
| `next_raw` | L963 | ratchet 的**目标**：把 gap `(cap − held)` 的 `ratchetBps/10000` 让出去。满棘轮 = 直接跟到 `held` |
| `allowance` | L966 | 自 `lastCapDecayAt` 以来**时钟允许**的最大降幅（线性速率上限） |
| `rateFloor` | L967 | 由 `allowance` 反推的 cap 下限 |
| `next` | L968-969 | 三重 clamp：`max(next_raw, rateFloor, capFloor)` |
| `used` | L972 | 本次实际降幅 `cap − next` |
| `lastCapDecayAt` | L982 | **按 `used` 反推推进时钟**，不是按 `elapsed` |
| `capDecayRemainder` | L983 | 亚量子余数（单位 token·day），跨调用累积 |

**一句话公式：**

```
newCap = max( cap − (cap − held) · ratchetBps / 10000 ,
              cap − capDecayTokensPerDay · min(elapsed, ∞) / 86400 ,
              capFloor )
```

**两个参数的分工：**
- **`ratchetBps`（当前 10000）** 决定**单次**跟随的激进程度 —— 是「想让 cap 走多远」。
- **`capDecayTokensPerDay`（当前 3000 IMD/天）** 决定**速率上限** —— 是「时钟允许走多远」。
- 两者取**更保守的那个**（即降得更少），再由 `capFloor` 兜底。

**为什么时钟要用 `used` 反推（L981-983）**：如果按 `elapsed` 推进，攻击者可以把一次大幅降低
拆成无数次极小的 ratchet，每次都把时钟推进 0 秒，从而绕过日限额。用 `used` 反推 +
`capDecayRemainder` 累积余数，保证**任意窗口内的总降幅不超过 `capDecayTokensPerDay × 天数`**，
无论碎片化到什么程度。源码注释在 L974-979 明确写了这个动机。

**`capDecayTokensPerDay = 0` 的特殊行为**：L980 的 `if` 会跳过时钟推进，
但 L963 的 ratchet **仍然会执行**（`rateFloor` 在 L967 因 `allowance = 0` 而等于 `inventoryCap`，
所以 `next` 被拉回 `inventoryCap`，L971 不成立）—— 实际上**等价于关闭 ratchet**。
源码注释 L146 也确认：「Zero disables ratcheting entirely」。

**当前状态下这段代码的实际行为**（这是理解「熄火」的关键）：
`cap == capFloor == 20,000`。只要 `held < 20,000`，L969 就把 `next` 钉在 `capFloor`，
L971 判定 `next < inventoryCap` 为**假**，于是**什么都不发生**。
**cap 已经到底，无论库存怎么跌都不会再降。**

---

## 6. `previewBridge()` 的语义，以及它与 BACKSTOP 的关系

> **这是一个需要纠正的前提。** 提示词把 `previewBridge()` 与 `ethInPool` / `backstopEthPrincipal` /
> `retainedEth` 放在一起问，暗示它们属于同一套机制。**它们完全无关，是两个合约、两种资产、两条独立管线。**

### `previewBridge()` 属于 `BurnExecutor`，不属于 `CappedBurnHook`

`CappedBurnHook.sol` **全文没有 `previewBridge`**。它是 `BurnExecutor.sol` 的函数（**L191-205**）：

```solidity
/// @notice Non-reverting view of what a bridge of `requested` would move and cost.
function previewBridge(uint256 requested)
    public view
    returns (uint256 amountToSend, uint256 minAmountToReceive, uint256 nativeFee)
{
    try this.resolveSendParam(requested) returns (SendParam memory sendParam) {
        try IOFT(oft).quoteSend(sendParam, false) returns (MessagingFee memory fee) {
            return (sendParam.amountLD, sendParam.minAmountLD, fee.nativeFee);
        } catch { return (0, 0, 0); }
    } catch { return (0, 0, 0); }
}

/// @notice Non-reverting preview of bridging everything currently held.
function previewBridge() external view returns (uint256, uint256, uint256) {
    return previewBridge(type(uint256).max);       // L213
}
```

- **资产**：**IMD 代币**（`token`，L89），不是 ETH。
- **语义**：把本合约当前持有的 IMD 经 **LayerZero OFT** 桥到 **Base 主网**的 `baseBurnReceiver`
  （L226-250 `bridgeToBaseBurnReceiver`），返回 `(发出的 IMD, 最少到账的 IMD, 需要支付的 LayerZero 原生费)`。
- **不 revert**：内部两层 `try/catch`，没有可桥内容时返回 `(0,0,0)`。
- **它不预测未来**：只反映**此刻**余额与 OFT 实时限额（`resolveSendParam` L133-171）。

**链上实测（本次）**：
```
BurnExecutor.oft              = 0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7  ← $IMD 自己就是 OFT
BurnExecutor.tokenBalance     = 20.263118 IMD
previewBridge()               = (20.263118 IMD, 20.263118 IMD, 0.00019392 ETH)
minBridgeAmount               = 0
dstEid                        = 30184  (Base mainnet)
baseBurnReceiver              = 0xf9d7cbf5bef2f5c9ba93a70f31ddca6457716793
```
注意 `$IMD` 合约名是 `BridgedFP`，它**同时是 ERC-20 和 LayerZero v2 OFT**——
这解释了它为什么带一套 LayerZero/OApp 依赖。

### `ethInPool` / `backstopEthPrincipal` / `retainedEth` 是 hook 的 **ETH 侧**账本

| 量 | 行 | 含义 |
| --- | --- | --- |
| `ethInPool` | L345-350 | **市场头寸**在当前价格下的 ETH 数量（`getAmount0Delta(price, tickUpper, positionLiquidity)`） |
| `retainedEth` | L226 | trim 时按比例带出的 ETH，**待 keeper 部署**到 backstop |
| `backstopEthPrincipal` | L176 | 已部署到 backstop band 的 ETH 本金 |
| `backstopConvertedEth` | L362-381 | backstop 中**已被价格买走**（换成 IMD）的 ETH 本金 |

`_claimEth`（L1043-1049）是 `retainedEth` 的唯一入口，由 trim（L1003）和 backstop 平仓（L740）调用。

### 两条管线的完整对照

```
【IMD 侧 — 85% 烧毁】
  swap 卖出 IMD
    → _applyCap() L991-1007 移除超额流动性
    → _disperse() L1031-1041  记 burnClaims / rewardClaims
    → settleClaims() L1134-1137（permissionless）
    → poolManager.take(token → burnSink) L1062      burnSink = BurnExecutor
    → BurnExecutor.bridgeToBaseBurnReceiver() L226  ★ 需要有人主动调用
    → LayerZero → Base 的 baseBurnReceiver → 真正销毁

【ETH 侧 — 回收再利用】
  _applyCap() L1003 _claimEth(ethRemoved) → retainedEth
    → rebalance() L638-650（permissionless keeper）
    → _deployBackstop() L752-761 放到价格上方的单边 ETH band
    → 价格涨进 band → backstopConvertedEth 增长 → backstopIsFilled 变 true
    → 下一次 rebalance() 平掉 band，买到的 IMD 走 _disperse() L741 再烧一遍
```

**页面必须分开呈现这两条线。** 把 `previewBridge()` 的数字和 `retainedEth` 放在一起会误导读者。

> **一个重要且容易被忽略的点**：`settleClaims()` 只是把 IMD 从 PoolManager 转给 `burnSink`
> （= BurnExecutor）。**真正的销毁还需要有人调用 `bridgeToBaseBurnReceiver()`**（L226，permissionless 但必须有人付 gas + LayerZero 费）。
> 当前 `BurnExecutor` 里躺着 **20.263118 IMD** 未桥接，而历史累计「账面烧毁」是 **29,254.215090 IMD**。
> 所以严格说，**「已烧毁」这个数字是账面的**；端到端是否真的销毁，取决于桥接这一步有没有被持续执行。

---

## 7. `refTick` 与 `deploymentFloorTick` 如何参与参考价；`backstopIsFilled` 何时为真

### 两个参考量

| 量 | 行 | 定义 |
| --- | --- | --- |
| `refTick` | **L195** | 上一区块收盘 tick 的**速率限制跟随者** |
| `deploymentFloorTick` | **L211** | backstop band 允许的**最低** lower tick |

**`refTick` 的维护**（`_observeTick`，**L934-945**）：

```solidity
function _observeTick() internal {
    if (block.number != refBlock) {          // L935 只在跨区块时推进
        int24 target = curBlockTick;         // 上一区块内最后观察到的 tick
        int24 step = maxRefStep;             // L937
        int24 delta = target - refTick;
        if (delta > step) target = refTick + step;        // L939
        else if (delta < -step) target = refTick - step;  // L940
        refTick = target;                    // L941
        refBlock = uint64(block.number);     // L942
    }
    curBlockTick = currentTick();            // L944
}
```

所以 `refTick` **至少滞后一个区块**，且**每区块最多移动 `maxRefStep`**（L200，当前实测值见页面）。
单笔交易无法影响它 —— 这正是抗单块操纵的设计。

**`deploymentFloorTick` 的维护**（`_updateDeploymentFloor`，**L833-857**），**非对称**：

```solidity
int24 target = _tickAbove(refTick);          // L839  decay 目标 = refTick + 1
if (target < floor) {
    if (elapsed > 1 days) elapsed = 1 days;                        // L841 上限一天，闲置不累积
    uint256 numerator = floorDecayTicksPerDay * elapsed + floorDecayRemainder;  // L842
    uint256 allowed = numerator / 1 days;                          // L843
    floorDecayRemainder = numerator % 1 days;                      // L844
    uint256 gap = uint256(int256(floor) - int256(target));
    floor = allowed >= gap ? target : floor - int24(int256(allowed));  // L846
} else {
    floorDecayRemainder = 0;                                       // L848 不累积
}
int24 raise = _tickAbove(observedTick);                            // L851
if (raise > floor) floor = raise;                                  // L852 ★ 向上：即时
```

- **向上（`observedTick + 1`）：立即**（L851-852）。理由见 L825-827 注释：更高的地板只会把 bid 推到更便宜的 IMD，是安全方向。
- **向下（朝 `refTick + 1`）：每天最多 `floorDecayTicksPerDay`**（当前实测 400 ticks/天 ≈ 4%/天），
  且 `elapsed` 被裁剪到 1 天（L841），余数按 tick·second 累积（L844）。
- **没有 owner 重置入口**（L210 注释：「Nothing lowers it faster; there is no owner reset」）。

**band 的 lower tick 最终怎么定**（`_rebalanceGuarded`，**L668-677**）：

```solidity
int24 spot = currentTick();            // L670
_updateDeploymentFloor(spot);          // L671
int24 lower = spot + 1;                // L672
if (lower < deploymentFloorTick) lower = deploymentFloorTick;   // L673
lower = _alignUp(lower);               // L674
```

即 **`lower = alignUp( max(spot + 1, deploymentFloorTick) )`**。
现货只能把 band **往上推**；`deploymentFloorTick` 是**硬下限**，防止有人在一个交易里把现货拉低、
从而把 retained ETH 部署到一个市场从未待过的低价位。

**`refTick` 与 `deploymentFloorTick` 是「band 放在哪」的参考，不是「band 是否被填满」的判据。**

### `backstopIsFilled()` 何时为真

**L393-396：**

```solidity
function backstopIsFilled() public view returns (bool) {
    uint256 threshold = backstopFillThreshold();
    return threshold != 0 && backstopConvertedEth() >= threshold;
}
```

**L385-390：**

```solidity
function backstopFillThreshold() public view returns (uint256) {
    uint256 principal = backstopEthPrincipal;
    if (principal == 0) return 0;
    uint256 threshold = rebalanceEthThreshold;
    return threshold < principal ? threshold : principal;   // = min(rebalanceEthThreshold, principal)
}
```

**L362-381（几何）：**

```solidity
if (sqrtPriceX96 <= sqrtLowerX96) {
    ethRemaining = getAmount0Delta(sqrtLowerX96, sqrtUpperX96, b.liquidity, false);   // 未动：converted = 0
} else if (sqrtPriceX96 < sqrtUpperX96) {
    ethRemaining = getAmount0Delta(sqrtPriceX96, sqrtUpperX96, b.liquidity, false);  // 部分成交
}
// sqrtPrice >= sqrtUpper 时 ethRemaining 保持默认 0 → converted = principal（完全成交）
return principal > ethRemaining ? principal - ethRemaining : 0;
```

**所以 `backstopIsFilled() == true` 需要同时满足三个条件：**

1. `backstopEthPrincipal > 0`（L387）—— 得先真的部署过一个 band；
2. `rebalanceEthThreshold > 0`（L388-389）—— 阈值和本金都非零，`threshold` 才非零；
3. **价格涨进 band**，使得 `backstopConvertedEth() ≥ min(rebalanceEthThreshold, backstopEthPrincipal)`。

**注意 `refTick` 完全不参与这个判断。** `backstopIsFilled()` 只看当前 `slot0` 价格与 band 几何。
`refTick` / `deploymentFloorTick` 的作用是**间接**的：它们决定 band 的 `tickLower` 放在哪，
因而决定「价格要涨多少才能把它填满」。

**链上实测（本次，区块 26036436）**：

```
backstop                 = (tickLower 69300, tickUpper 887220, liquidity 801225892433361378152)
backstopEthPrincipal     = 25.061082 ETH
backstopConvertedEth     = 0.000000 ETH
backstopIsFilled         = false
backstopFillThreshold()  = 0.1 ETH          (rebalanceEthThreshold)
currentTick() 池 B        = 61352
currentTick() 池 A        = 61412
deploymentFloorTick      = 65022
refTick                  = 61338
```

**读法**：band 的 `tickLower = 69300` **高于**当前 tick 61352 —— band **完全位于现价上方，从未被触及**，
所以 `backstopConvertedEth()` 读作 0、`backstopIsFilled()` 为 false，二者自洽。

价格（`IMD per ETH`，即 v4 的 `currency1/currency0`）需要**上涨约 121%**
（`1.0001^(69300−61352) ≈ 2.21×`）才会开始填充这个 band。
注意该池方向：`currency0 = ETH, currency1 = IMD`，所以「价格上升」= **IMD 相对 ETH 贬值**，
即 backstop 是在**砸盘时用 ETH 承接 IMD**，随后在 `rebalance()` 时把这些 IMD 烧掉（L741）。

`deploymentFloorTick = 65022` 高于现价 61352，说明地板目前**不是**约束（`lower = max(spot+1, floor) = 65022 < 69300`），
band 的位置是由上一次 `rebalance()` 时的现货决定的。

页面上应把 `backstopConvertedEth()` 作为权威读数，而不是自己从 tick 推断 ——
band 在每次 `rebalance()` 时会整体重建（`_closeBackstop` L737-738 清空、`_deployBackstop` L757-758 重设）。

---

## 8. 交叉验算 ①：点火距离 ≈ 6,456 IMD 是否成立

**成立。**

用提示词给定的快照值代入 L354 的语义：

```
held = tokensInPool   = 13,544.04 IMD
cap  = inventoryCap   = 20,000.00 IMD   (== capFloor，链上实测两者相等)
minTrimTokens         = 0               (链上实测)

excess = held > cap ? held - cap : 0 = 0            ← held < cap，所以没有超额
pendingTrim() = excess < minTrimTokens ? 0 : excess = 0     ← 引擎无货可烧 ✓
点火距离 = cap - held = 20,000.00 - 13,544.04 = 6,455.96 IMD ≈ 6,456 IMD   ✓
```

**同时验证了「引擎已熄火」的判据**：`held < cap` ⇒ `_applyCap` 进入 L960 的 ratchet 分支而非 trim 分支；
又因为 `cap == capFloor`，L969 把 `next` 钉回 `capFloor`，L971 判定为假 ⇒ **cap 不动、不烧、不发事件**。
`pendingTrim()` 返回 0 与之自洽。

**本次实测的实时值**（区块 26036436，独立于提示词快照）：

```
inventoryCap        = 20,000.000000 IMD
capFloor            = 20,000.000000 IMD
tokensInPool        = 13,405.840989 IMD
pendingTrim()       = 0.000000 IMD
点火距离             = 6,594.159010 IMD
```

与提示词的 6,456 IMD 差 138 IMD —— **这不是矛盾，而是池子在实时波动**：
`tokensInPool` 随每一笔 swap 变化（见 §10 的采样曲线，库存在 13,400–18,600 之间来回摆动）。
提示词的 13,544.04 与本次的 13,405.84 都落在同一区间内，**公式完全一致**。

> **对「点火距离」语义的一个必要澄清**：`held` 高于 cap 时距离为 0，但那时**不是「已经点火」而是「随时会点火」**——
> 下一笔 swap 结算后 `_applyCap` 就会 trim。真正需要区分的是三态，见 §9 状态机。

---

## 9. 状态机：哑火 / 临界 / 活跃

严格按 L960 / L991-992 的**代码分支**划分（而不是按距离的任意阈值）：

| 状态 | 充要条件（源码级） | 行号 | 下一笔 swap 会怎样 |
| --- | --- | --- | --- |
| **LIVE 活跃** | `held > inventoryCap` 且 `excess ≥ minTrimTokens` | L991-992 | **必然 trim**，烧掉 `excess` |
| **CRITICAL 临界** | `held ≤ inventoryCap` 且 `held > capFloor` | L960 成立，L971 成立 | ratchet 触发，cap 下调（消耗日额度） |
| **DORMANT 哑火** | `held ≤ inventoryCap` 且 `inventoryCap == capFloor` | L960 成立，L971 **不**成立 | **什么都不会发生**（当前状态） |

**关键**：`capFloor` 是「哑火」与「临界」的分界。只有 `inventoryCap == capFloor` 时才是真正的哑火，
因为此时 ratchet 已经无处可去。若 `inventoryCap > capFloor`，买入仍会让 cap 继续下降，
从而**主动缩短**点火距离 —— 那是「临界」，不是「哑火」。

页面上可以再叠一层**距离刻度**（如距 cap 的百分比）作为视觉提示，但**状态判定必须用上面的分支条件**，
不能用任意阈值。

---

## 10. 交叉验算 ②：用真实历史 trim 回放模型

**做到了。** 我们不依赖任何索引服务：用 `eth_getLogs` 以 1000 区块为窗口、多端点轮换，
扫完了合约**从开盘到当前的全部 9,478 条日志**（`scripts/index-logs.mjs`，39 秒）。
再对选定的 trim 用**归档 `eth_call`** 读取 trim **前一个区块**的真实状态，逐条比对公式。

### 10.1 单次 trim 回放（最近一次，区块 25964166）

`Trimmed(uint128 liquidityRemoved, uint256 tokensBurned, uint256 tokensRewarded, uint256 ethRetained)`（L88）实测：

```
liquidityRemoved = 552179706059744783
tokensBurned     = 15.045736... IMD
tokensRewarded   = 2.655129... IMD
ethRetained      = 0.01722528 ETH
```

归档读到的状态：

```
区块 25964165（trim 前）: tokensInPool=19,992.222380  cap=20,000.000000  L=624453517566320695601  tick=69327
区块 25964166（trim 后）: tokensInPool=20,000.000000  cap=20,000.000000  L=623901337860260950818  tick=69353
```

**逐条校验结果（全部 PASS，Δ = 0 wei）：**

| 校验 | 公式出处 | 结果 |
| --- | --- | --- |
| `rewarded = floor(removed × 1500 / 10000)`，`burned = removed − rewarded` | **L1033-1034** | PASS，精确到 wei |
| `positionLiquidity_after = L_before − liquidityRemoved` | **L1001** | PASS，精确 |
| `liquidityRemoved == floor(L × excess / held)` | **L991 + L997** | PASS，**Δ = 0 wei** |
| trim 不移 cap | **L960 / L971** | PASS，20,000 → 20,000 |
| trim 后 `held ≈ cap`（仅剩向下取整残差） | **L994-1001** | PASS，残差 **24 wei** |
| trim 移走的代币量 == 超出的量 | **L991 + L997** | PASS，`excess = 17.700866228`，`removed = 17.700866228`，相对误差 0 |

**这一条最有说服力**：trim 移除的 IMD **恰好等于**超出 cap 的部分（17.700866 IMD），
到小数点后 9 位完全一致。这就是机制的核心语义，被真实链上数据证实。

### 10.2 累计对账（210 次 trim + 107 次 backstop settle）

```
Σ Trimmed.tokensBurned          = 24,947.930980 IMD
Σ Trimmed.tokensRewarded        =  4,402.576055 IMD
Σ BackstopSettled.tokensBurned  =  4,306.284109 IMD     ← 第二条烧毁路径
Σ BackstopSettled.tokensRewarded=    759.932489 IMD
────────────────────────────────────────────────────
合计 burned                     = 29,254.215090 IMD
链上 totalBurned()              = 29,254.215090 IMD     Δ = 0 wei  ✅
合计 rewarded                   =  5,162.508545 IMD
链上 totalRewarded()            =  5,162.508545 IMD     Δ = 0 wei  ✅
合计 burn/reward                = 5.666667  (85/15 = 5.666667)  ✅
```

> **这是一处重要的机制修正**：`totalBurned` / `totalRewarded` **不是只由 trim 累加**。
> `_closeBackstop()`（**L741**）在平掉 backstop 时也调用 `_disperse()`，
> 把 band 买到的 IMD 按同样的 85/15 拆分。所以累计对账必须把 `BackstopSettled` 一并计入。
> 只用 trim 对账会差 4,306 IMD —— 我们第一次跑就撞上了这个差异，它反过来证实了对源码的理解。

**关于「观测到的 rewardShareBps = 1499」**：这是**取整的必然结果，不是配置被改过**。
每次 `_disperse` 各自向下取整（L1033），210 次累加后 `Σrewarded/Σtotal` 略低于 1500 bps。
**单次**拆分精确等于 1500 bps（见 §10.1 第一条校验）。页面若显示「实测费率」必须说明这一点，
否则会被误读成「owner 偷改了费率」。

### 10.3 熄火时间线（head = 26036508）

| 机制 | 最后一次发生 | 距今 |
| --- | --- | --- |
| 市场开盘 | 区块 25887100 | 149,408 区块 ≈ 20.8 天 |
| **一次 trim（85/15 烧毁）** | **区块 25964166** | **72,342 区块 ≈ 10.0 天** |
| cap ratchet 下调 | 区块 25959734 | 76,774 区块 ≈ 10.7 天 |
| backstop 平仓（第二条烧毁路径） | 区块 25963188 | 73,320 区块 ≈ 10.2 天 |
| keeper rebalance | 区块 25963188 | 73,320 区块 ≈ 10.2 天 |
| claims 结算到 sink/recipient | 区块 25964244 | 72,264 区块 ≈ 10.0 天 |
| owner 提取 LP 费 | 区块 25972798 | 63,710 区块 ≈ 8.8 天 |
| **一笔 swap 支付了 1% LP 费** | **区块 26036477** | **31 区块 ≈ 0.0 天** |
| 放置地板变动 | 区块 26036477 | 31 区块 ≈ 0.0 天 |

**这张表就是「引擎熄火」最直接的证据**：`FeeCollected` 与 `DeploymentFloorUpdated`
一直活跃到**当前区块**（池子在正常交易、有人在做 swap），而 `Trimmed` 已经停了 **10 天**。
**池子活着，烧毁引擎死了** —— 两者不是一回事，官网把这两件事混为一谈了。

### 10.4 库存衰减曲线（归档 `eth_call` 采样，最后 trim 之后）

```
#25964166  held= 20,000.0000  cap= 20,000.00  gap=     0.0000   ← trim 刚结束，距离为 0
#25971400  held= 16,073.4050  cap= 20,000.00  gap= 3,926.5949
#25978634  held= 16,466.0576  cap= 20,000.00  gap= 3,533.9423
#25985869  held= 18,133.9382  cap= 20,000.00  gap= 1,866.0617
#25993103  held= 18,622.1820  cap= 20,000.00  gap= 1,377.8179   ← 最接近复燃
#26000337  held= 17,009.9408  cap= 20,000.00  gap= 2,990.0591
#26007571  held= 17,162.4722  cap= 20,000.00  gap= 2,837.5277
#26014805  held= 15,880.7349  cap= 20,000.00  gap= 4,119.2650
#26022040  held= 14,920.9374  cap= 20,000.00  gap= 5,079.0625
#26029274  held= 15,356.0599  cap= 20,000.00  gap= 4,643.9400
#26036508  held= 13,418.2193  cap= 20,000.00  gap= 6,581.7806   ← 当前
```

**读法**：trim 结束时距离为 0；此后**净买入**持续把 IMD 抽离市场头寸，距离单调扩大（中间有波动）。
注意 `cap` 全程是 20,000 —— **它一次都没动过**，因为已经在地板上。
曲线在 #25993103 处曾缩到 1,378 IMD，随后又扩大。

**因果链**：净买入 → `held` 下降 → 距离扩大；`cap` 因触底无法跟随 → **没有任何机制能把距离拉回来，
除非出现净卖出把 IMD 推回 20,000 以上**。

---

## 11. 与提示词快照的冲突与更正清单

| # | 提示词说法 | 实测 / 源码 | 处置 |
| --- | --- | --- | --- |
| 1 | `BurnExecutor`/`RewardDistributor`/`StakedIMD`/`$IMD` **未验证** | **四个全部已在 Blockscout 验证** | **更正**，机制分析全部基于真源码 |
| 2 | 「疑似内部函数 `_applyCap()`」 | **确认就是 `_applyCap()`**，L952-1008 | 确认 |
| 3 | 「cap 调整逻辑」 | 完整公式见 §5，含 L963/L966-969/L971-987 | 已给出 |
| 4 | 「`totalBurned/totalRewarded` 来自 trim」 | **还包含 backstop 平仓路径**（L741） | **补充**，见 §10.2 |
| 5 | 「`BONDING_LIVE = false`、两个 depository 都是 `0x0`」 | 源码里**没有**这两个概念。`RewardDistributor` 的设计就是「**只有 staking 桶被路由**」（L8-12 注释），bonding/NFT 桶**故意**只记账滞留，等以后 `emergencyWithdraw`（L92-99）迁移 | **更正**：不是「开关关着」，是「设计如此」 |
| 6 | 「RewardDripper 注释说 10% reward share」 | 源码注释 L12 写「10%」，但**链上 `rewardShareBps = 1500`（15%）**，且实测拆分精确 1500 bps | **注释过时**，以链上参数为准 |
| 7 | 「trim → 85% → BurnExecutor → 真 burn()」 | BurnExecutor **不做 burn**，它把 IMD 经 LayerZero **桥到 Base**（L226-250）。真正销毁发生在 Base 侧 | **更正**，见 §6 |
| 8 | 「点火距离 ≈ 6,456 IMD」 | **成立**，公式见 §8 | 确认 |
| 9 | `capDecayTokensPerDay = 3000` | 链上原始值 `3000000000000000000000`（18 位小数），人类单位 **3000 IMD/天** | 确认（注意单位） |
| 10 | sIMD `decimals = 24` | 确认；来源是 `_decimalsOffset() = 6`（StakedIMD.sol **L68-70**）叠加 IMD 的 18 位小数 | 确认并补充成因 |

**本次实测的完整参数快照**（区块 26036436，全部来自 `eth_call`）：

```
inventoryCap            20,000.000000 IMD
capFloor                20,000.000000 IMD      ← 两者相等 = 棘轮到地板
ratchetBps              10000                  ← 满棘轮
capDecayTokensPerDay    3000 IMD/day
minTrimTokens           0
rewardShareBps          1500  (15%)            ← 硬上限 MAX_REWARD_SHARE_BPS = 3000 (L127)
tokensInPool            13,405.840989 IMD
pendingTrim()           0
ethInPool               29.036065 ETH
totalBurned             29,254.215090 IMD
totalRewarded            5,162.508545 IMD
backstopEthPrincipal    25.061082 ETH
backstopConvertedEth    0.000000 ETH
backstopIsFilled        false
retainedEth             0.078317 ETH
refTick                 61338
deploymentFloorTick     65022
rebalanceEthThreshold   0.1 ETH                (源码默认 L298)
keeperReward            0.002 ETH              (源码默认 L299)
pendingRebalance()      false
marketOpen              true
totalFeeEth             3.513680 ETH          ← owner 可提取
```

---

## 12. 风险：owner 的权限边界（按合约分别认定）

> ### ⚠️ 更正记录：本节曾被写错
>
> **本文档早先的版本在这里写道**：「`RewardDripper.renounceOwnership()` 与 `StakedIMD.renounceOwnership()`
> ……**两者当前都未 renounce**（owner 仍是 EOA）」，页面也因此显示「renounceOwnership 是否已调用：未调用」。
>
> **这是错的。** 页面当时把「未调用」**硬编码**了，根本没有读 `simd.owner()`。
> 而 `data/baseline.json` 里 `simd.owner` 一直是 `0x0000000000000000000000000000000000000000`，
> 数据与结论自相矛盾。
>
> **更正依据（三重验证，`scripts/verify-ownership.mjs` 可复现）**：
>
> | # | 验证方式 | 结果 |
> | --- | --- | --- |
> | 1 | 读 tx `0x519fdbdd5b504476efe91f31a20b4091aeb15cb7caed51071151d3ee87b81851` 的 receipt | 区块 **26014063**，`to = StakedIMD`，calldata = `0x715018a6`（`renounceOwnership()`），status = success，发出 `OwnershipTransferred(0x047f…54B7 → 0x0)` |
> | 2 | 归档 `eth_call` 读该交易前后的 `owner()` | 区块 26014062 = `0x047f…54B7`；区块 26014063 = `0x0`；区块 26014064 = `0x0` |
> | 3 | 当前 `owner()` | `0x0000000000000000000000000000000000000000` |
>
> 项目方也于区块 **26014070** 在链上留言确认：「renounced ownership of the staking contract so no
> admin (me or if hacked) can never emergency withdraw on behalf of users」。
>
> 教训：**权限状态必须逐个合约读 `owner()`，不能靠推断，更不能硬编码。**
> 页面现在按合约分别渲染，并对每一项权限标注「有效 / 已失效」（`scripts/audit-owner-powers.mjs` 会逐项验证）。

### 12.1 逐个合约的 owner 现状

| 合约 | 角色 | `owner()` | 状态 |
| --- | --- | --- | --- |
| **StakedIMD (sIMD)** | 质押金库 | **`0x0000…0000`** | **已 renounce** —— 提取与冻结权限永久失效 |
| CappedBurnHook | 烧毁引擎本体 | `0x047f…54B7` | 仍是 EOA |
| RewardDripper | 奖励缓释器 | `0x047f…54B7` | 仍是 EOA |
| RewardDistributor | 奖励分账 | `0x047f…54B7` | 仍是 EOA |
| BurnExecutor | 跨链销毁中转 | `0x047f…54B7` | 仍是 EOA |
| $IMD (BridgedFP) | 代币本体（LayerZero OFT） | `0x047f…54B7` | 仍是 EOA |

**准确的表述是**：`sIMD` 的质押资金**不再可以被任何管理员单方面取走或冻结**；
但**其余 5 个合约仍然由一个普通钱包控制，共 8 项权限仍然有效**。
不要笼统写成「资金可被 owner 提取」——那是错的一半。

### 12.2 仍然有效的权限（逐项经链上验证）

| 能力 | 合约 | 行号 | 后果 |
| --- | --- | --- | --- |
| **`closeMarket(recipient)`** | CappedBurnHook | **L581-608** | **owner 可随时抽走整个市场头寸**（全部 IMD + ETH），源码注释 L575-578 明确承认「the owner can withdraw the entire position at any moment, including from a healthy market」 |
| `withdrawFees(recipient)` | CappedBurnHook | L622-626 | 提取 LP 费账本（当前约 3.51 ETH） |
| `withdrawRetainedEth` | CappedBurnHook | L610-618 | 提取 retainedEth |
| `rescueERC20` | RewardDripper | **L178-181** | 扫走全部奖励缓冲（当前余额 0） |
| `emergencyWithdraw` | RewardDistributor | L92-99 | 抽走全部余额（含 heldBonding + heldNft ≈ 3,613.76 IMD） |
| `rescueToken` | BurnExecutor | L279-293 | 抽走待桥接的 IMD（当前 20.26 IMD） |
| `setPeer(uint32,bytes32)` | $IMD (BridgedFP) | OAppCore（LayerZero v2） | 改跨链对端，可改变跨链销毁的落点 |
| `setDelegate(address)` | $IMD (BridgedFP) | OAppCore（LayerZero v2） | 改 LayerZero 配置代理 |
| `setBridgeConfig` / `setBaseBurnReceiver` | BurnExecutor | L103-115 | 改跨链目标地址 |

`closeMarket` 是**终结性**的：`marketOpen` 无法回到 true（L580 注释）。

### 12.3 已失效的权限（StakedIMD，owner = 0x0）

| 能力 | 行号 | 现状 |
| --- | --- | --- |
| `rescueERC20(token, to, amount)` | L151-154 | **失效** —— 无地址能满足 `onlyOwner` |
| `setPaused(bool)` | L142-145 | **失效** —— 无法再冻结存取 |
| `rescueETH(to, amount)` | L157-160 | **失效** |

`renounceOwnership()` 本身在 Solady 的 `Ownable` 里是终身的：owner 置零后**没有恢复路径**。
`StakedIMD` 因此成为一个不可升级、无管理员的 ERC-4626。

> **验证方法**：`node scripts/audit-owner-powers.mjs` 会逐个合约读 `owner()`，
> 并用「owner 调用 vs 非 owner 调用」的差异确认 `onlyOwner` 是否仍然生效，
> 最后断言「已 renounce 的合约不得报告任何有效权限」。

---

## 13. 未解释项：sIMD 的 7.92 账面比率 —— **已定位成因**

```
StakedIMD.totalAssets() = 1,617,112.207565 IMD
StakedIMD.totalSupply() =   204,155.741096 sIMD
账面比率                 =         7.920973 IMD / sIMD
sIMD 占 IMD 总供应        = 43.14%   (IMD totalSupply = 3,748,422.402809)
```

### 13.1 机制：这个比率是怎么产生的

`StakedIMD` 继承 Solady 的 `ERC4626`，`totalAssets` 就是 `asset.balanceOf(address(this))`。
`_decimalsOffset() = 6`（StakedIMD.sol **L68-70**）使**首次存款恰好是 1:1**
（IMD 18 位小数 + offset 6 = sIMD 24 位小数）。

**因此：任何直接 `transfer` 到 vault 的 IMD 都会抬高 `totalAssets` 而不增发份额，从而抬高账面比率。**
这是 ERC-4626 的固有性质（不是漏洞），但**不是收益**。

### 13.2 实测：比率的三个来源

用归档 `eth_call` 逐段采样 `totalAssets`/`totalSupply`（`scripts/_simd-ratio.mjs`）：

| 阶段 | 区块 | 账面比率 | 说明 |
| --- | --- | --- | --- |
| vault 初建 | 25887100 | **1.000000** | assets = 1 IMD，supply = 1 sIMD（1:1） |
| **开盘后约 80 分钟** | 25887492 | **7.666666** | assets = 24 IMD，supply = 3.13 sIMD —— **比率已在 1 天内被一次性抬升 7.67 倍** |
| 随后约 1.5 天 | 25888667 | 7.902918 | 继续被注入抬高 |
| 趋于稳定 | 25893367 | 7.904148 | |
| 缓慢爬升 | 25965457 | **7.920973** | 最后到达的比率 |
| **完全冻结** | 25965457 → 现在 | 7.920973 | **71,000+ 区块（≈9.9 天）没有任何变化** |

**反解第一次抬升**：设 vault 当时为 1 IMD / 1 sIMD，先被注入 `Y`，再有人存入 `D`：

```
1 + Y + D = 24            (assets)
1 + D/(1+Y) = 3.1304      (supply)
⇒ 1 + Y = 7.6667,  Y ≈ 6.667 IMD,  D ≈ 16.333 IMD
```

即：**一笔约 6.67 IMD 的注入把比率从 1.0 抬到 7.6667，随后所有存款都按这个被抬高的比率铸币。**

**奖励流贡献了多少？** 比率从 7.904148 走到 7.920973，相对增幅仅 **0.213%**。
按最终 assets 反推，这段时间的全部非存款流入约为：

```
1,617,112 × (1 − 7.904148 / 7.920973) ≈ 3,435 IMD
```

对比：hook **全生命周期**只产出 `totalRewarded = 5,162.51 IMD`，
其中分给 staking 桶的只有 `stakingEarned = 1,548.75 IMD`。

> **结论：7.9210 这个比率里，约 96.8% 来自 vault 早期的一次性注入，奖励流只贡献了约 0.2%。**
> 把它当作收益率展示，等于把一个初始化参数说成业绩。

### 13.3 附带发现：这条曲线是「奖励流已停止」的**独立证据**

`totalAssets` 与 `totalSupply` 的比值**只在有非存款 IMD 流入时才变**。
它最后一次变化是**区块 25965457**：

```
#25965456  ratio=7.920909454  assets=1,368,380.1152  supply=172,755.4295
#25965457  ratio=7.920973463  assets=1,368,391.1731  supply=172,755.4295
                              ↑ +11.0579 IMD，份额不变 = 一次纯奖励流入
```

时间线对照：

```
最后 Trimmed（一次烧毁）       区块 25964166
最后 ClaimsSettled            区块 25964244
★ 最后一笔 IMD 流入 vault      区块 25965457   ← 之后 71,000+ 区块再无变化
最后 owner 提取 LP 费           区块 25972798
当前                           区块 26036500+
```

**这条证据完全独立于 hook 的事件流**：即使不看 `Trimmed`，只看质押金库的账面比率，
也能得出「奖励流已经停止约 9.9 天」的同一结论。

### 13.4 页面处置

只显示 `totalAssets`、`totalSupply` 与「账面比率」，并**明确标注**：

> 这是 ERC-4626 的账面兑换率，**不是**历史收益率。其中约 96.8% 形成于金库部署初期的一次性注入，
> 与奖励流无关。该比率自区块 25965457 起未再变化。

**绝不**把它换算成年化收益率，也**绝不**与官网的 782,132% APR 并列展示。

---

## 14. 给前瞻模拟器的数学依据

模拟器必须严格按源码，不得引入额外假设。以下每一条都对应上面的行号：

1. **trim 触发**：`held_after_swap > inventoryCap` 且 `excess ≥ minTrimTokens`（L991-992）。
2. **trim 数量**：移除的 IMD = `excess`；移除的流动性 = `floor(L × excess / held)`（L997）。
   移除后 `L ← L − liquidityToRemove`（L1001），`held` 回到 cap（余 wei 级残差）。
3. **拆分**：`rewarded = floor(removed × rewardShareBps / 10000)`，`burned = removed − rewarded`（L1033-1034）。
4. **ratchet**：`newCap = max(cap − (cap − held)·ratchetBps/10000, cap − capDecay·elapsed/86400, capFloor)`（L963-969）。
5. **时钟推进**：`lastCapDecayAt += (used·86400 + remainder) / capDecayTokensPerDay`（L981-982）。
6. **`held` 与价格的关系**：`held = L × (sqrtP − sqrtPlower) / 2^96`（L339-341，`getAmount1Delta` 向下取整）。
   池为 `currency0 = ETH, currency1 = IMD`，所以 **价格下跌 ⇒ `sqrtP` 变小 ⇒ `held` 变大 ⇒ 更容易触发 trim**。
7. **cap 不会因为库存回升而上调**（§3）。

**模拟器要显式标注的两个不确定性**：
- 「净流入 IMD」在真实池子里是**交易的结果**，不是可独立设定的量；模拟器把它当作外生输入是一种简化。
- 每笔 swap 都会先 `_collectFees`（L915），所以 LP 费不会进入 trim 的燃烧量。

---

## 15. 可复现的验证命令

```bash
node scripts/selftest.mjs      # keccak/ABI 已知答案自测（向量由 ethers v6 独立生成）
node scripts/collect.mjs       # 实时快照 -> data/baseline.json（纯 eth_call）
node scripts/index-logs.mjs    # 全历史事件索引 -> data/history.json（分块 eth_getLogs）
node scripts/replay.mjs 3      # 用归档 eth_call 回放真实 trim 并对账
node scripts/fetch-bridge-history.mjs  # 第二道门队列历史 -> data/bridge-history.json（见 §16）
node scripts/_simd-history.mjs # sIMD 账面比率历史采样
```

全部脚本**只读**：仅使用 `eth_call` / `eth_getLogs` / `eth_getBlockByNumber` /
`eth_getTransactionCount` / `eth_getBalance` / `eth_getCode`。
**没有任何私钥、签名、钱包连接或写操作。**

---

## 16. 第二道门的队列：一周内 19,542 IMD 被桥走

**结论**：L1→Base 的桥接销毁不是「名义上存在、实际没人用」。截至 2026-09-24 06:57 UTC（区块
26,045,677），BurnExecutor 里只剩 830.73 IMD，而 7 天前是 20,372.36 IMD —— 净流出 **19,541.63 IMD**，
24 小时内流出 4,700.65 IMD。**有人在持续付手续费调用跨链销毁。**

**为什么单独记一节**：一个「待销毁余额」如果只涨不跌，含义恰好相反 —— 那是 IMD 在合约里排队、
第二道门没人在推。所以页面不显示「余额 = X」这一件事，而是**余额 + 24h/7d 净变化 + 谁在推**。

### 方法：为什么用 Transfer 日志，而不是归档 `eth_call`

- 归档 `eth_call`（在历史区块上调用）需要 archive 节点。公共 RPC 时好时坏，实测连续三次尝试全部失败。
- 更糟的是：**能返回时也会给错**。同一次运行中，archive 采样给出的「7 天前余额」是 0.0000003 IMD，
  而 Transfer 日志重建给出 20,372 IMD —— 差 6 个数量级。那段区块的状态显然不在该节点的存档范围内，
  但它返回了 `0` 而不是报错。**一个静默错误的数字比一个明确的失败危险得多。**
- 正确做法是个恒等式：

  ```
  balance(t) = balance(now) − Σ 流入(t…now) + Σ 流出(t…now)
  ```

  Transfer 日志是这段区间的全部事实来源，公共节点都能提供（按区块分片查询即可）。
- 实现：`scripts/fetch-bridge-history.mjs`（10,000 区块一片；两次 topic 过滤 —— `from = BurnExecutor`
  与 `to = BurnExecutor`），产物 `data/bridge-history.json`。页面把实时 `eth_call` 的当前值放进
  `now` 槽位，其余采样点来自快照，并在卡片上标注快照生成时间。

### 数字（区块 26,045,677，2026-09-24 06:57 UTC）

| 采样点 | 余额 |
| --- | --- |
| 现在 | 830.73 IMD |
| 6 小时前 | 1,349.08 IMD |
| 12 小时前 | 3,220.49 IMD |
| 18 小时前 | 3,969.44 IMD |
| 24 小时前 | 5,531.38 IMD |
| 7 天前 | 20,372.36 IMD |

### 判定规则

`lib/contracts.js` 的 `readBridgeTrend()`：序列**跌过至少一次** → 「有人在推动」；**只涨不跌** →
「第二道门目前没有人在推」；**完全不动** → 「没有变化」；可用采样点少于两个 → 「历史取不到」，**不猜**。
（`scripts/test-bridge.mjs` 固定了这四条规则，包括「archive 缺样本不能被当成跌到 0」。）

### 文案约束

这个数字必须写成「**待桥接销毁**」，不能写成「已销毁」。BurnExecutor 自己不烧币，它只是中转；
真正的销毁发生在 Base 侧的 `burnReceiver.burn()`。写成「已销毁」会把两道门的叙事说反。

### 出处

dev 在区块 25793366 的链上留言里公开说过
*"updated the burnExecutor contract so anyone can call it, would be nice if someone creates a bot for it"*
—— 所以「有没有人在推这道门」是可以用链上原文讨论的问题，不是推测。

---

## 17. `derive()` 的字段量纲表

这一节的起因：两个字段长期算错，而**没有任何地方写明它们是什么单位**。

| 字段 | 症状 | 真实原因 |
| --- | --- | --- |
| `daysOfBuffer` | 26,270,609.788 天（7 万年） | 算出「秒数」后又**乘**了 86400，而应该**除以** 86400 换成天。差 86400² ≈ 7.46×10⁹ 倍 |
| `ethInPoolUsd` | $115.75（应为 ≈ $57,039） | `ethInPool` 本身已经是 ETH，却又过了一遍「IMD→ETH」定价，等于把 ETH 当 IMD 卖了一次。差 ≈ 493 倍（= 1 / ethPerImd） |

两个字段都没有进入渲染路径（只出现在 `derive()` 与 `data/baseline.json` 里），所以页面没有显示过错数字。
但 `baseline.json` 是给离线核对用的 —— 一份写着「缓冲够 7 万年」的快照会误导任何拿它做交叉验算的人。

**约定**：以下所有数值字段都是 **wei 计的大整数**（bigint，18 位小数），除非「量纲」一列另有说明。
JSON 序列化后它们变成十进制字符串 —— `sanityCheckDerived()` 三种形态（bigint / number / string）都要能读，
否则检查会静默跳过（这个坑也踩过一次）。

### 库存与触发线（`hook.*`）

| 字段 | 量纲 | 来源 | 合理性范围 |
| --- | --- | --- | --- |
| `held` | IMD wei | `tokensInPool()` | 0 … 总供应量 |
| `cap` | IMD wei | `inventoryCap()` | `floor` … 历史最高 cap |
| `floor` | IMD wei | `capFloor()` | ≤ `cap` |
| `ethInPool` | **ETH** wei | `ethInPool()` | 0 … 池子总 ETH |
| `pendingTrim` | IMD wei | `pendingTrim()`（权威） | 0 … `held` |
| `minTrim` | IMD wei | `minTrimTokens()` | 0 … `cap` |
| `gapRaw` | IMD wei | `max(cap − held, 0)` | 0 … `cap` |
| `gapWithMinTrim` | IMD wei | `gapRaw + minTrim` | ≥ `gapRaw` |
| `excess` | IMD wei | `max(held − cap, 0)` | 0 … `held` |

### 价格与估值

| 字段 | 量纲 | 来源 | 合理性范围 |
| --- | --- | --- | --- |
| `gapEth` | ETH wei | `valueInEth(gapRaw)` | ≥ 0 |
| `gapUsd` | USD wei | `gapEth × ethUsd` | ≥ 0 |
| `ethInPoolUsd` | USD wei | `ethInPool × ethUsd`（**不再过一次 IMD 定价**） | ≈ `ethInPool × ethUsd` |
| `priceA` / `priceB` | `{ethPerImd, imdPerEth}` 均 18 位定点；`sqrtPriceX96` 为原始值 | `slot0()` 的 sqrtPriceX96 | 互为倒数 |
| `ethUsd` | USD/ETH，18 位定点 | Chainlink `latestRoundData()` | $100 … $100,000 |

### 分配与缓释器

| 字段 | 量纲 | 来源 | 合理性范围 |
| --- | --- | --- | --- |
| `shareBps` | bps（万分比） | `rewardShareBps()` | 0 … 10000 |
| `pendingBurn` | IMD wei | `pendingTrim − pendingReward` | ≥ 0 |
| `pendingReward` | IMD wei | `pendingTrim × shareBps / 10000` | ≤ `pendingTrim` |
| `dripRate` | **IMD/秒** wei | `dripRatePerSecond()` | > 0 |
| `drippable` | IMD wei | `drippable()` | ≤ `dripperBal` |
| `dripperBal` | IMD wei | `balanceOf(dripper)` | ≥ 0 |
| `perCallCeiling` | IMD wei | `dripRate × maxCatchupSeconds` | ≥ `dripRate` |
| `daysOfBuffer` | **天**（Number，不是 bigint） | `dripperBal ÷ dripRate ÷ 86400` | 0 … 365 |

### sIMD

| 字段 | 量纲 | 来源 | 合理性范围 |
| --- | --- | --- | --- |
| `totalAssets` | IMD wei | `totalAssets()` | ≥ 0 |
| `totalSupply` | sIMD，**24 位**小数 | `totalSupply()` | ≥ 0 |
| `simdDecimals` | 计数 | `decimals()` | 18 / 24 |
| `simdRate` | IMD per 1 sIMD，18 位定点 | `totalAssets × 10^decimals ÷ totalSupply` | 0.001 … 1000 |
| `simdShareOfSupply` | bps of IMD 总供应量 | `totalAssets × 10000 ÷ imd.totalSupply()` | 0 … 10000 |

### 第二道门

| 字段 | 量纲 | 来源 | 合理性范围 |
| --- | --- | --- | --- |
| `pendingBridge` | IMD wei | `BurnExecutor.tokenBalance()` | ≥ 0（见 §16） |
| `bridgeAmountToSend` | IMD wei | `previewBridge()[0]` | ≤ `pendingBridge` |
| `bridgeMinReceive` | IMD wei | `previewBridge()[1]` | ≤ `bridgeAmountToSend` |
| `bridgeNativeFee` | **ETH** wei | `previewBridge()[2]` | 通常 < 0.01 ETH |

### 状态机与比率

| 字段 | 量纲 | 来源 | 合理性范围 |
| --- | --- | --- | --- |
| `state` | 枚举 | `pendingTrim > 0 \|\| held > cap` → LIVE；否则 `cap > floor` → CRITICAL；否则 DORMANT | 三值之一 |
| `armWindow` | IMD wei | `cap / 10` | ≤ `cap` |
| `critWindow` | IMD wei | `cap / 100` | ≤ `cap` |
| `ratchetAtFloor` | 布尔 | `cap ≤ floor` | — |
| `ratchetDead` | 布尔 | `ratchetBps = 0` 或 `capDecayTokensPerDay = 0` | — |
| `burnRatio` | 比率（Number）或 null | `totalBurned ÷ totalRewarded` | > 0 |

### 量级校验器

`sanityCheckDerived(derived)`（`lib/contracts.js`）对上表的「合理性范围」逐项检查，返回问题清单：

- `daysOfBuffer > 365` → 失败（缓冲不可能超过一年）
- `ethInPoolUsd` 与 `ethInPool × ethUsd` 相差 10 倍以上 → 失败（`gapUsd` 同理）
- `ethUsd` 不在 $100 … $100,000 → 失败
- `simdRate` 不在 0.001 … 1000 → 失败（decimals 写错会最先在这里暴露）
- `drippable > dripperBal` → 失败
- `floor > cap`、状态窗口大于 `cap` → 失败

`scripts/check-derived.mjs` 对真实快照跑这些检查，**并且**用已知的错误值反向验证检查本身会失败
（旧 `daysOfBuffer`、旧 `ethInPoolUsd`、100× 偏差、decimals 错误、`drippable` 越界）。
一条不会失败的断言不算断言 —— 这个脚本第一次运行时，正是因为 `num()` 只认 bigint/number，
在字符串形态的快照数据上全部静默跳过，5 条自测里挂了 4 条。

**以后每新增一个 derived 字段，都要在「量纲」一列写上单位，并在这里或在 `sanityCheckDerived()` 里给出范围。**

### 11.5 ⚠️ 两个「累计烧毁」，不要互相对照

页面上有两个都叫「烧毁」的累计数，它们在**不同的链上、数不同的东西、永不会相等**。
把这两个数并排看会得出「账目对不上」的错误结论，所以在这里写清楚：

| | L1 侧累计抽走烧毁 | Base 侧累计销毁 |
| --- | --- | --- |
| 字段 | `hook.totalBurned()` | `data/base.json` 的 `burns[]`（`BurnExecuted` 事件） |
| 在哪条链 | Ethereum 主网 | Base |
| 数的是什么 | `_disperse()` 拆出来的那 85%：**已经被判定为"要烧毁"的量**，此刻还躺在 `BurnExecutor` 里排队等跨链 | `BurnExecutor` 真的把 IMD 转到 `0x000…000` 之后，**物理上已经不可再流通的量** |
| 单位 | IMD wei（18 位） | 同样是 IMD wei，但**计的是笔数级别的另一本账** |
| 当前量级 | **32,377.26 IMD**（`data/baseline.json`） | **54 次** `BurnExecuted`（`data/base.json`） |
| 谁会动它 | 每一次 `Trimmed` 或 `BackstopSettled`（**两条烧毁路径**，见 §10.2） | 每一次有人付 gas 在 Base 上调用 `burn` |
| 停止条件 | 池子里没有超出触发线的 IMD 就停 | 队列里没有 IMD，或没人愿意付跨链手续费就停 |

**两者之间隔着一个队列，这个队列就是页面上的「待桥接到 Base 销毁的 IMD」。**
`totalBurned()` 先动，Base 侧的销毁后动且金额不等（跨链有损耗、有人可能只送一部分），
所以 **`totalBurned()` 恒 ≥ Base 侧实际销毁 + 当前队列量**，多出来的部分是历史上真正
完成销毁的部分。**L1 侧的 `totalBurned` 永远大于 Base 侧已销毁量的原因是：它把"排队中"
和"已销毁"合在一起数了。**

> 更直白地说：`totalBurned()` 的语义是「**已经决意要烧毁、并已从池子里抽走**」，
> 不是「**已经烧掉**」。这是合约自己的口径（`_disperse()` 在拆分的当下就累加），
> 页面必须跟随它、不要另造一个。

**验证方式**：`node scripts/check-live-numbers.mjs` 把 `timeline.json` 的
`Trimmed + BackstopSettled` 账本与链上 `totalBurned()` 逐 wei 对账。
**当前结果：Δ = 0 wei**（32,377.263622 IMD = 32,377.263622 IMD）。

> 2026-09-25 实测：账本与链上**逐 wei 完全相同**。这是本项目可信度最高的一条证据 ——
> 从事件日志重建的账本，与合约自己的计数器一位不差。

**写作本文时的另一组数字**（供理解量级，会随时间失效）：L1 侧 `totalBurned()` 32,289.68 IMD
对照 Base 侧 54 次 `BurnExecuted`。两者相差约 4,700 IMD —— 差额就是**「已经抽走但还在
队列里、或还在跨链路上」的那部分**。看到这个差额不要以为账错了。



