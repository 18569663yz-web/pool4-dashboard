/**
 * pool4-dashboard · contract registry and the read-only data collector.
 *
 * Every value the dashboard shows is produced here, from `eth_call` only.
 * No `eth_getLogs`, no indexer, no backend, no wallet.
 *
 * Function signatures below are copied from the on-chain-verified sources in
 * `../_imd_research/verified/` (Blockscout, verified 2026-08/09). Line numbers
 * referenced in NOTES.md point at those files.
 */

import { Rpc, Contract, fn, keccak256Hex, hexToBytes, decodeReturns, encodeCall, Q192, mul18, div18 } from "./evm.js";

export const CHAIN = { id: 1, name: "Ethereum Mainnet", explorer: "https://etherscan.io" };

export const ADDR = {
  hook: "0xc6c965bd164c483e87d0b550671798e9a3602840",
  dripper: "0xe6d3de6daEAF327fCA42745f1998FcD989e00884",
  burnExecutor: "0xe29386719c155b6847ad5a4e97c6674f10ffc750",
  distributor: "0x9046739e1535b40efbe6ab3f45d0024b690eca30",
  simd: "0x9efa934d9fad4ae28c998a40195646b965a97247",
  imd: "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7",
  owner: "0x047f606fd5b2baa5f5c6c4ab8958e45cb6b054b7",
  poolManager: "0x000000000004444c5dc75cb358380d2e3de08a90",
  stateView: "0x7ffe42c4a5deea5b0fec41c94c136cf115597227",
  quoter: "0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203",
  chainlinkEthUsd: "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419",
  baseBurnReceiver: "0x4b118f0c63d09f09cb35fc6e8024a6c96493eada",
};

/** Both ETH/IMD v4 pools. Only B carries the hook. */
export const POOLS = {
  A: { label: "Pool A — no hook", fee: 10000, tickSpacing: 200, hooks: "0x0000000000000000000000000000000000000000" },
  B: { label: "Pool B — CappedBurnHook", fee: 10000, tickSpacing: 60, hooks: ADDR.hook },
};

/* ------------------------------------------------------------------ *
 * Base — the second door
 *
 * L1 $IMD is the LayerZero OFT contract "BridgedFP" (= Bridged Fren Pet).
 * Its peer on Base (eid 30184) is an OFTAdapter wrapping the native Base
 * token 0xff0c532f… ("Fren Pet"). Bridging therefore UNLOCKS Fren Pet on
 * Base, and BaseBurnReceiver.burn() destroys whatever it holds.
 *
 * Verified on Base (solc 0.8.26):
 *   contract BaseBurnReceiver {
 *       event BurnExecuted(address indexed caller, address indexed token);
 *       address public immutable token;
 *       function burn() external {
 *           IBaseBurnableToken(token).burn(IBaseBurnableToken(token).balanceOf(address(this)));
 *           emit BurnExecuted(msg.sender, token);
 *       }
 *   }
 * The event carries NO amount — the destroyed quantity only shows up as a
 * falling Fren Pet totalSupply.
 * ------------------------------------------------------------------ */

export const BASE = {
  chainId: 8453,
  explorer: "https://basescan.org",
  rpcs: [
    "https://base-rpc.publicnode.com",
    "https://base.drpc.org",
    "https://base.gateway.tenderly.co",
    "https://base.publicnode.com",
    "https://base-mainnet.public.blastapi.io",
    "https://gateway.tenderly.co/public/base",
    "https://1rpc.io/base",
    "https://mainnet.base.org",
  ],
  /** OFTAdapter that holds the locked Fren Pet backing L1 BridgedFP */
  adapter: "0xab152db8aac047b6757ffcf495ffe88d7712690a",
  /** the native Base token (name/symbol: "Fren Pet") */
  frenPet: "0xff0c532fdb8cd566ae169c1cb157ff2bdc83e105",
  /** permissionless burner; holds Fren Pet only transiently */
  burnReceiver: "0xf9d7cbf5bef2f5c9ba93a70f31ddca6457716793",
  /** the receiver hardcoded in BurnExecutor's source default (a different one is live) */
  sourceDefaultReceiver: "0x4b118f0c63d09f09cb35fc6e8024a6c96493eada",
  eid: 30184,
};

export const BASE_ABI = {
  erc20: {
    totalSupply: fn("totalSupply", [], ["uint256"]),
    decimals: fn("decimals", [], ["uint8"]),
    symbol: fn("symbol", [], ["string"]),
    name: fn("name", [], ["string"]),
    balanceOf: fn("balanceOf", ["address"], ["uint256"]),
  },
};

/** keccak256(abi.encode(PoolKey)) — PoolKey is 5 static words, so this is the raw concatenation. */
export function computePoolId({ currency0 = "0x0000000000000000000000000000000000000000", currency1, fee, tickSpacing, hooks }) {
  const w = (hex) => hex.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const i = (v) => {
    const b = BigInt(v);
    return ((b < 0n ? (1n << 256n) + b : b)).toString(16).padStart(64, "0");
  };
  // NB: hash the raw BYTES of the concatenated words, not their ASCII text.
  return keccak256Hex(hexToBytes(w(currency0) + w(currency1) + i(fee) + i(tickSpacing) + w(hooks)));
}

export const POOL_IDS = {
  A: computePoolId({ currency1: ADDR.imd, ...POOLS.A }),
  B: computePoolId({ currency1: ADDR.imd, ...POOLS.B }),
};

/* ------------------------------------------------------------------ *
 * ABIs (signatures verbatim from verified source)
 * ------------------------------------------------------------------ */

export const ABI = {
  hook: {
    // --- cap state (CappedBurnHook.sol L337-396, L224-229) ---
    tokensInPool: fn("tokensInPool", [], ["uint256"]), // L337
    ethInPool: fn("ethInPool", [], ["uint256"]), // L345
    pendingTrim: fn("pendingTrim", [], ["uint256"]), // L352  <- the "ignition distance" view
    inventoryCap: fn("inventoryCap", [], ["uint256"]), // L224
    capFloor: fn("capFloor", [], ["uint256"]), // L138
    capDecayTokensPerDay: fn("capDecayTokensPerDay", [], ["uint256"]), // L152
    capDecayRemainder: fn("capDecayRemainder", [], ["uint256"]), // L160
    lastCapDecayAt: fn("lastCapDecayAt", [], ["uint256"]), // L155
    ratchetBps: fn("ratchetBps", [], ["uint256"]), // L136
    minTrimTokens: fn("minTrimTokens", [], ["uint256"]), // L128
    rewardShareBps: fn("rewardShareBps", [], ["uint256"]), // L126
    maxRewardShareBps: fn("MAX_REWARD_SHARE_BPS", [], ["uint256"]), // L127 (internal const, may revert)
    bpsDenominator: fn("BPS_DENOMINATOR", [], ["uint256"]), // L110

    // --- ledgers ---
    totalBurned: fn("totalBurned", [], ["uint256"]), // L227
    totalRewarded: fn("totalRewarded", [], ["uint256"]), // L228
    burnClaims: fn("burnClaims", [], ["uint256"]), // L237
    rewardClaims: fn("rewardClaims", [], ["uint256"]), // L239
    ethClaims: fn("ethClaims", [], ["uint256"]), // L241
    retainedEth: fn("retainedEth", [], ["uint256"]), // L226
    lastClaimBlock: fn("lastClaimBlock", [], ["uint256"]), // L244
    totalFeeToken: fn("totalFeeToken", [], ["uint256"]), // L255
    totalFeeEth: fn("totalFeeEth", [], ["uint256"]), // L256
    feeTokenClaims: fn("feeTokenClaims", [], ["uint256"]), // L251
    feeEthClaims: fn("feeEthClaims", [], ["uint256"]), // L253

    // --- destinations (mutable by owner) ---
    burnSink: fn("burnSink", [], ["address"]), // L121
    rewardsRecipient: fn("rewardsRecipient", [], ["address"]), // L122
    keeperReward: fn("keeperReward", [], ["uint256"]), // L188
    owner: fn("owner", [], ["address"]),

    // --- backstop / reference ---
    backstop: fn("backstop", [], ["int24", "int24", "uint128"]), // L172
    backstopEthPrincipal: fn("backstopEthPrincipal", [], ["uint256"]), // L176
    backstopConvertedEth: fn("backstopConvertedEth", [], ["uint256"]), // L362
    backstopFillThreshold: fn("backstopFillThreshold", [], ["uint256"]), // L385
    backstopIsFilled: fn("backstopIsFilled", [], ["bool"]), // L393
    refTick: fn("refTick", [], ["int24"]), // L195
    maxRefStep: fn("maxRefStep", [], ["int24"]), // L200
    deploymentFloorTick: fn("deploymentFloorTick", [], ["int24"]), // L211
    floorDecayTicksPerDay: fn("floorDecayTicksPerDay", [], ["uint256"]), // L215
    rebalanceEnabled: fn("rebalanceEnabled", [], ["bool"]), // L180
    rebalanceEthThreshold: fn("rebalanceEthThreshold", [], ["uint256"]), // L184
    pendingRebalance: fn("pendingRebalance", [], ["bool"]), // L661

    // --- market ---
    marketOpen: fn("marketOpen", [], ["bool"]), // L229
    positionLiquidity: fn("positionLiquidity", [], ["uint128"]), // L225
    currentTick: fn("currentTick", [], ["int24"]), // L332
    currentSqrtPriceX96: fn("currentSqrtPriceX96", [], ["uint160"]), // L328
    poolId: fn("poolId", [], ["bytes32"]), // L324
    token: fn("token", [], ["address"]),
    poolManager: fn("poolManager", [], ["address"]),
    lpFee: fn("lpFee", [], ["uint24"]),
    tickSpacing: fn("tickSpacing", [], ["int24"]),
  },

  dripper: {
    drippable: fn("drippable", [], ["uint256"]), // RewardDripper.sol L105
    canDrip: fn("canDrip", [], ["bool"]), // L116
    dripRatePerSecond: fn("dripRatePerSecond", [], ["uint256"]), // L42
    maxCatchupSeconds: fn("maxCatchupSeconds", [], ["uint256"]), // L44
    lastDripAt: fn("lastDripAt", [], ["uint256"]), // L46
    keeperReward: fn("keeperReward", [], ["uint256"]), // L48
    minDripAmount: fn("minDripAmount", [], ["uint256"]), // L51
    vault: fn("vault", [], ["address"]), // L40
    imd: fn("imd", [], ["address"]), // L37
    owner: fn("owner", [], ["address"]),
  },

  distributor: {
    stakingEarned: fn("stakingEarned", [], ["uint256"]), // RewardDistributor.sol L28
    bondingEarned: fn("bondingEarned", [], ["uint256"]), // L29
    nftEarned: fn("nftEarned", [], ["uint256"]), // L30
    heldBonding: fn("heldBonding", [], ["uint256"]), // L32
    heldNft: fn("heldNft", [], ["uint256"]), // L33
    stakingBps: fn("stakingBps", [], ["uint16"]), // L19
    bondingBps: fn("bondingBps", [], ["uint16"]), // L20
    nftBps: fn("nftBps", [], ["uint16"]), // L21
    dripper: fn("dripper", [], ["address"]), // L25
    asset: fn("asset", [], ["address"]), // L18
    owner: fn("owner", [], ["address"]),
  },

  burnExecutor: {
    tokenBalance: fn("tokenBalance", [], ["uint256"]), // BurnExecutor.sol L126
    previewBridge: fn("previewBridge", [], ["uint256", "uint256", "uint256"]), // L208-214 (no-arg overload)
    minBridgeAmount: fn("minBridgeAmount", [], ["uint256"]), // L96
    oft: fn("oft", [], ["address"]), // L90
    dstEid: fn("dstEid", [], ["uint32"]), // L91
    baseBurnReceiver: fn("baseBurnReceiver", [], ["address"]), // L92
    token: fn("token", [], ["address"]), // L89
    owner: fn("owner", [], ["address"]),
  },

  simd: {
    totalAssets: fn("totalAssets", [], ["uint256"]),
    totalSupply: fn("totalSupply", [], ["uint256"]),
    decimals: fn("decimals", [], ["uint8"]),
    paused: fn("paused", [], ["bool"]), // StakedIMD.sol L33
    asset: fn("asset", [], ["address"]), // L54
    owner: fn("owner", [], ["address"]),
    convertToAssets: fn("convertToAssets", ["uint256"], ["uint256"]),
  },

  imd: {
    totalSupply: fn("totalSupply", [], ["uint256"]),
    decimals: fn("decimals", [], ["uint8"]),
    symbol: fn("symbol", [], ["string"]),
    balanceOf: fn("balanceOf", ["address"], ["uint256"]),
    owner: fn("owner", [], ["address"]), // LayerZero OApp owner
  },

  stateView: {
    getSlot0: fn("getSlot0", ["bytes32"], ["uint160", "int24", "uint24", "uint24"]),
    getLiquidity: fn("getLiquidity", ["bytes32"], ["uint128"]),
  },

  chainlink: {
    latestRoundData: fn("latestRoundData", [], ["uint80", "int256", "uint256", "uint256", "uint80"]),
    decimals: fn("decimals", [], ["uint8"]),
  },
};

/* ------------------------------------------------------------------ *
 * Collector
 * ------------------------------------------------------------------ */

/** Every owner-mutable knob we watch for changes, with its provenance. */
export const WATCHED = [
  { id: "hook.capFloor", c: "hook", k: "capFloor", label: "capFloor", unit: "IMD", src: "CappedBurnHook.sol L403 setCapFloor" },
  { id: "hook.capDecayTokensPerDay", c: "hook", k: "capDecayTokensPerDay", label: "capDecayTokensPerDay", unit: "IMD/day", src: "L449 setCapDecay" },
  { id: "hook.ratchetBps", c: "hook", k: "ratchetBps", label: "ratchetBps", unit: "bps", src: "L459 setRatchetBps" },
  { id: "hook.rewardShareBps", c: "hook", k: "rewardShareBps", label: "rewardShareBps", unit: "bps", src: "L488 setRewardShareBps" },
  { id: "hook.burnSink", c: "hook", k: "burnSink", label: "burnSink", src: "L468 setBurnSink" },
  { id: "hook.rewardsRecipient", c: "hook", k: "rewardsRecipient", label: "rewardsRecipient", src: "L478 setRewardsRecipient" },
  { id: "hook.keeperReward", c: "hook", k: "keeperReward", label: "keeperReward", unit: "ETH", src: "L421 setKeeperReward" },
  { id: "hook.rebalanceEnabled", c: "hook", k: "rebalanceEnabled", label: "rebalanceEnabled", src: "L410 setRebalance" },
  { id: "hook.rebalanceEthThreshold", c: "hook", k: "rebalanceEthThreshold", label: "rebalanceEthThreshold", unit: "ETH", src: "L410 setRebalance" },
  { id: "hook.maxRefStep", c: "hook", k: "maxRefStep", label: "maxRefStep", unit: "ticks", src: "L430 setMaxRefStep" },
  { id: "hook.floorDecayTicksPerDay", c: "hook", k: "floorDecayTicksPerDay", label: "floorDecayTicksPerDay", unit: "ticks/day", src: "L439 setFloorDecay" },
  { id: "hook.owner", c: "hook", k: "owner", label: "hook.owner", src: "Ownable" },
  { id: "hook.marketOpen", c: "hook", k: "marketOpen", label: "marketOpen", src: "L581 closeMarket / L505 openMarket" },
  { id: "dripper.vault", c: "dripper", k: "vault", label: "dripper.vault", src: "RewardDripper.sol L144 setVault" },
  { id: "dripper.dripRatePerSecond", c: "dripper", k: "dripRatePerSecond", label: "dripRatePerSecond", src: "L150 setDripRate" },
  { id: "dripper.maxCatchupSeconds", c: "dripper", k: "maxCatchupSeconds", label: "maxCatchupSeconds", src: "L156 setMaxCatchup" },
  { id: "dripper.keeperReward", c: "dripper", k: "keeperReward", label: "dripper.keeperReward", src: "L162 setKeeperReward" },
  { id: "dripper.minDripAmount", c: "dripper", k: "minDripAmount", label: "minDripAmount", src: "L168 setMinDripAmount" },
  { id: "dripper.owner", c: "dripper", k: "owner", label: "dripper.owner", src: "Ownable" },
  { id: "distributor.dripper", c: "distributor", k: "dripper", label: "distributor.dripper", src: "RewardDistributor.sol L84 setDripper" },
  { id: "distributor.owner", c: "distributor", k: "owner", label: "distributor.owner", src: "Ownable" },
  { id: "burnExecutor.oft", c: "burnExecutor", k: "oft", label: "burnExecutor.oft", src: "BurnExecutor.sol L103 setBridgeConfig" },
  { id: "burnExecutor.baseBurnReceiver", c: "burnExecutor", k: "baseBurnReceiver", label: "baseBurnReceiver", src: "L113 setBaseBurnReceiver" },
  { id: "burnExecutor.minBridgeAmount", c: "burnExecutor", k: "minBridgeAmount", label: "minBridgeAmount", src: "L121 setMinBridgeAmount" },
  { id: "burnExecutor.owner", c: "burnExecutor", k: "owner", label: "burnExecutor.owner", src: "Ownable" },
  { id: "simd.paused", c: "simd", k: "paused", label: "sIMD.paused", src: "StakedIMD.sol L142 setPaused" },
  { id: "simd.owner", c: "simd", k: "owner", label: "sIMD.owner", src: "watch.src.renounceOwnership" },
  { id: "imd.owner", c: "imd", k: "owner", label: "$IMD.owner", src: "LayerZero OApp Ownable" },
];

const hex = (v) => (typeof v === "bigint" ? "0x" + v.toString(16) : String(v));

/* ------------------------------------------------------------------ *
 * Owner powers — the accurate description is "funds can be withdrawn",
 * not "parameters are tunable". Sources are the verified Solidity.
 * ------------------------------------------------------------------ */

export const OWNER_POWERS = [
  {
    id: "closeMarket",
    contract: "CappedBurnHook",
    addr: ADDR.hook,
    fn: "closeMarket(address recipient)",
    line: "L581-608",
    what: "owner.what.closeMarket",
    quote:
      "The trade is explicit and must be disclosed: the owner can withdraw the entire position at any moment, including from a healthy market. Holders are trusting the owner not to, not the contract to prevent it.",
    quoteLine: "CappedBurnHook.sol L575-578",
    severity: "critical",
  },
  {
    id: "withdrawFees",
    contract: "CappedBurnHook",
    addr: ADDR.hook,
    fn: "withdrawFees(address recipient)",
    line: "L622-626",
    what: "owner.what.withdrawFees",
    quote: "Sends the accumulated trading-fee revenue (token + ETH) to `recipient`.",
    quoteLine: "CappedBurnHook.sol L620-621",
    severity: "high",
  },
  {
    id: "withdrawRetainedEth",
    contract: "CappedBurnHook",
    addr: ADDR.hook,
    fn: "withdrawRetainedEth(address,uint256)",
    line: "L610-618",
    what: "owner.what.withdrawRetainedEth",
    quote: null,
    severity: "medium",
  },
  {
    id: "dripperRescue",
    contract: "RewardDripper",
    addr: ADDR.dripper,
    fn: "rescueERC20(address token, address to, uint256 amount)",
    line: "L178-181",
    what: "owner.what.dripperRescue",
    quote: "Owner sweeps a balance — including the reward IMD buffer — to `to`. Trusted power, removed on `renounceOwnership()`.",
    quoteLine: "RewardDripper.sol L176-177",
    severity: "high",
  },
  {
    id: "simdRescue",
    contract: "StakedIMD (sIMD)",
    addr: ADDR.simd,
    fn: "rescueERC20(address token, address to, uint256 amount)",
    line: "L151-154",
    what: "owner.what.simdRescue",
    quote:
      "The rescue functions can move stakers' IMD, so until ownership is renounced the owner is a trusted party (this is a deliberate \"move funds to safety in a worst case\" hatch, not a trustless design).",
    quoteLine: "StakedIMD.sol L149-150",
    severity: "critical",
  },
  {
    id: "simdPause",
    contract: "StakedIMD (sIMD)",
    addr: ADDR.simd,
    fn: "setPaused(bool)",
    line: "L142-145",
    what: "owner.what.simdPause",
    quote: "`setPaused(true)` — a full stop: every deposit, mint, withdraw and redeem reverts.",
    quoteLine: "StakedIMD.sol L20",
    severity: "critical",
  },
  {
    id: "distributorWithdraw",
    contract: "RewardDistributor",
    addr: ADDR.distributor,
    fn: "emergencyWithdraw(address to)",
    line: "L92-99",
    what: "owner.what.distributorWithdraw",
    quote: "Emergency drain of the whole IMD balance here — for migrating to a new distributor.",
    quoteLine: "RewardDistributor.sol L90",
    severity: "medium",
  },
  {
    id: "burnExecutorRescue",
    contract: "BurnExecutor",
    addr: ADDR.burnExecutor,
    fn: "rescueToken(address to, uint256 amount)",
    line: "L279-293",
    what: "owner.what.burnExecutorRescue",
    quote: null,
    severity: "medium",
  },
  {
    id: "imdSetPeer",
    contract: "$IMD (BridgedFP)",
    addr: ADDR.imd,
    fn: "setPeer(uint32 eid, bytes32 peer)",
    line: "OAppCore（LayerZero v2）",
    what: "owner.what.imdSetPeer",
    quote: null,
    severity: "high",
  },
  {
    id: "imdSetDelegate",
    contract: "$IMD (BridgedFP)",
    addr: ADDR.imd,
    fn: "setDelegate(address)",
    line: "OAppCore（LayerZero v2）",
    what: "owner.what.imdSetDelegate",
    quote: null,
    severity: "medium",
  },
];

/* ------------------------------------------------------------------ *
 * Owner powers grouped by contract.
 *
 * This grouping matters because ownership is NOT uniform across the system:
 *   StakedIMD renounced ownership on 2026-09-19 (tx 0x519fdbdd…, block 26014063),
 *   so its rescueERC20 / setPaused powers are gone.
 *   Every other contract is still controlled by the same EOA.
 *
 * Verified by scripts/verify-ownership.mjs (receipt + archived owner() + current owner()).
 * ------------------------------------------------------------------ */

export const OWNER_CONTRACTS = [
  {
    contract: "StakedIMD (sIMD)",
    role: "owner.role.simd",
    addr: ADDR.simd,
    ownerKey: "simd.owner",
    powerIds: ["simdRescue", "simdPause"],
    renouncedNote:
      "owner.note.simd.renounced",
    liveNote: "owner.note.simd.live",
  },
  {
    contract: "CappedBurnHook",
    role: "owner.role.hook",
    addr: ADDR.hook,
    ownerKey: "hook.owner",
    powerIds: ["closeMarket", "withdrawFees", "withdrawRetainedEth"],
    renouncedNote: null,
    liveNote: "owner.note.hook.live",
  },
  {
    contract: "RewardDripper",
    role: "owner.role.dripper",
    addr: ADDR.dripper,
    ownerKey: "dripper.owner",
    powerIds: ["dripperRescue"],
    renouncedNote: null,
    liveNote: "owner.note.dripper.live",
  },
  {
    contract: "RewardDistributor",
    role: "owner.role.distributor",
    addr: ADDR.distributor,
    ownerKey: "distributor.owner",
    powerIds: ["distributorWithdraw"],
    renouncedNote: null,
    liveNote: "owner.note.distributor.live",
  },
  {
    contract: "BurnExecutor",
    role: "owner.role.burnExecutor",
    addr: ADDR.burnExecutor,
    ownerKey: "burnExecutor.owner",
    powerIds: ["burnExecutorRescue"],
    renouncedNote: null,
    liveNote: "owner.note.burnExecutor.live",
  },
  {
    contract: "$IMD (BridgedFP)",
    role: "owner.role.imd",
    addr: ADDR.imd,
    ownerKey: "imd.owner",
    powerIds: ["imdSetPeer", "imdSetDelegate"],
    renouncedNote: null,
    liveNote: "owner.note.imd.live",
  },
];

/** Where each displayed number comes from — rendered as a hover/click source tag. */
export const SOURCES = {
  "hook.tokensInPool": { c: "CappedBurnHook", a: ADDR.hook, f: "tokensInPool()", l: "L337-342" },
  "hook.ethInPool": { c: "CappedBurnHook", a: ADDR.hook, f: "ethInPool()", l: "L345-350" },
  "hook.pendingTrim": { c: "CappedBurnHook", a: ADDR.hook, f: "pendingTrim()", l: "L352-357" },
  "hook.inventoryCap": { c: "CappedBurnHook", a: ADDR.hook, f: "inventoryCap()", l: "L224" },
  "hook.capFloor": { c: "CappedBurnHook", a: ADDR.hook, f: "capFloor()", l: "L138" },
  "hook.capDecayTokensPerDay": { c: "CappedBurnHook", a: ADDR.hook, f: "capDecayTokensPerDay()", l: "L152" },
  "hook.ratchetBps": { c: "CappedBurnHook", a: ADDR.hook, f: "ratchetBps()", l: "L136" },
  "hook.rewardShareBps": { c: "CappedBurnHook", a: ADDR.hook, f: "rewardShareBps()", l: "L126" },
  "hook.minTrimTokens": { c: "CappedBurnHook", a: ADDR.hook, f: "minTrimTokens()", l: "L128" },
  "hook.totalBurned": { c: "CappedBurnHook", a: ADDR.hook, f: "totalBurned()", l: "L227" },
  "hook.totalRewarded": { c: "CappedBurnHook", a: ADDR.hook, f: "totalRewarded()", l: "L228" },
  "hook.burnClaims": { c: "CappedBurnHook", a: ADDR.hook, f: "burnClaims()", l: "L237" },
  "hook.rewardClaims": { c: "CappedBurnHook", a: ADDR.hook, f: "rewardClaims()", l: "L239" },
  "hook.retainedEth": { c: "CappedBurnHook", a: ADDR.hook, f: "retainedEth()", l: "L226" },
  "hook.backstopIsFilled": { c: "CappedBurnHook", a: ADDR.hook, f: "backstopIsFilled()", l: "L393-396" },
  "hook.backstopConvertedEth": { c: "CappedBurnHook", a: ADDR.hook, f: "backstopConvertedEth()", l: "L362-381" },
  "hook.backstopFillThreshold": { c: "CappedBurnHook", a: ADDR.hook, f: "backstopFillThreshold()", l: "L385-390" },
  "hook.backstopEthPrincipal": { c: "CappedBurnHook", a: ADDR.hook, f: "backstopEthPrincipal()", l: "L176" },
  "hook.backstop": { c: "CappedBurnHook", a: ADDR.hook, f: "backstop()", l: "L172" },
  "hook.refTick": { c: "CappedBurnHook", a: ADDR.hook, f: "refTick()", l: "L195" },
  "hook.deploymentFloorTick": { c: "CappedBurnHook", a: ADDR.hook, f: "deploymentFloorTick()", l: "L211" },
  "hook.marketOpen": { c: "CappedBurnHook", a: ADDR.hook, f: "marketOpen()", l: "L229" },
  "hook.burnSink": { c: "CappedBurnHook", a: ADDR.hook, f: "burnSink()", l: "L121" },
  "hook.rewardsRecipient": { c: "CappedBurnHook", a: ADDR.hook, f: "rewardsRecipient()", l: "L122" },
  "hook.totalFeeEth": { c: "CappedBurnHook", a: ADDR.hook, f: "totalFeeEth()", l: "L256" },
  "hook.totalFeeToken": { c: "CappedBurnHook", a: ADDR.hook, f: "totalFeeToken()", l: "L255" },
  "hook.pendingRebalance": { c: "CappedBurnHook", a: ADDR.hook, f: "pendingRebalance()", l: "L661-664" },
  "hook.rebalanceEthThreshold": { c: "CappedBurnHook", a: ADDR.hook, f: "rebalanceEthThreshold()", l: "L184" },
  "hook.keeperReward": { c: "CappedBurnHook", a: ADDR.hook, f: "keeperReward()", l: "L188" },
  "hook.positionLiquidity": { c: "CappedBurnHook", a: ADDR.hook, f: "positionLiquidity()", l: "L225" },
  "hook.currentTick": { c: "CappedBurnHook", a: ADDR.hook, f: "currentTick()", l: "L332-334" },
  "dripper.drippable": { c: "RewardDripper", a: ADDR.dripper, f: "drippable()", l: "L105-112" },
  "dripper.canDrip": { c: "RewardDripper", a: ADDR.dripper, f: "canDrip()", l: "L116-118" },
  "dripper.dripRatePerSecond": { c: "RewardDripper", a: ADDR.dripper, f: "dripRatePerSecond()", l: "L42" },
  "dripper.maxCatchupSeconds": { c: "RewardDripper", a: ADDR.dripper, f: "maxCatchupSeconds()", l: "L44" },
  "dripper.lastDripAt": { c: "RewardDripper", a: ADDR.dripper, f: "lastDripAt()", l: "L46" },
  "dripper.minDripAmount": { c: "RewardDripper", a: ADDR.dripper, f: "minDripAmount()", l: "L51" },
  "dripper.vault": { c: "RewardDripper", a: ADDR.dripper, f: "vault()", l: "L40" },
  "distributor.heldBonding": { c: "RewardDistributor", a: ADDR.distributor, f: "heldBonding()", l: "L32" },
  "distributor.heldNft": { c: "RewardDistributor", a: ADDR.distributor, f: "heldNft()", l: "L33" },
  "distributor.stakingEarned": { c: "RewardDistributor", a: ADDR.distributor, f: "stakingEarned()", l: "L28" },
  "distributor.bondingEarned": { c: "RewardDistributor", a: ADDR.distributor, f: "bondingEarned()", l: "L29" },
  "distributor.nftEarned": { c: "RewardDistributor", a: ADDR.distributor, f: "nftEarned()", l: "L30" },
  "distributor.stakingBps": { c: "RewardDistributor", a: ADDR.distributor, f: "stakingBps()", l: "L19" },
  "distributor.bondingBps": { c: "RewardDistributor", a: ADDR.distributor, f: "bondingBps()", l: "L20" },
  "distributor.nftBps": { c: "RewardDistributor", a: ADDR.distributor, f: "nftBps()", l: "L21" },
  "burnExecutor.tokenBalance": { c: "BurnExecutor", a: ADDR.burnExecutor, f: "tokenBalance()", l: "L126-128" },
  "burnExecutor.previewBridge": { c: "BurnExecutor", a: ADDR.burnExecutor, f: "previewBridge()", l: "L208-214" },
  "burnExecutor.baseBurnReceiver": { c: "BurnExecutor", a: ADDR.burnExecutor, f: "baseBurnReceiver()", l: "L92" },
  "burnExecutor.oft": { c: "BurnExecutor", a: ADDR.burnExecutor, f: "oft()", l: "L90" },
  "simd.totalAssets": { c: "StakedIMD", a: ADDR.simd, f: "totalAssets()", l: "ERC4626" },
  "simd.totalSupply": { c: "StakedIMD", a: ADDR.simd, f: "totalSupply()", l: "ERC4626" },
  "simd.decimals": { c: "StakedIMD", a: ADDR.simd, f: "decimals()", l: "L68-70 (_decimalsOffset=6)" },
  "simd.paused": { c: "StakedIMD", a: ADDR.simd, f: "paused()", l: "L33" },
  "imd.totalSupply": { c: "BridgedFP ($IMD)", a: ADDR.imd, f: "totalSupply()", l: "ERC20" },
  "owner.nonce": { c: "EOA", a: ADDR.owner, f: "eth_getTransactionCount", l: null },
  "bal.imd.dripper": { c: "IMD", a: ADDR.imd, f: "balanceOf(RewardDripper)", l: null },
  "bal.imd.distributor": { c: "IMD", a: ADDR.imd, f: "balanceOf(RewardDistributor)", l: null },
  "bal.imd.burnExecutor": { c: "IMD", a: ADDR.imd, f: "balanceOf(BurnExecutor)", l: null },
  "bal.imd.hook": { c: "IMD", a: ADDR.imd, f: "balanceOf(CappedBurnHook)", l: null },
  "poolA.slot0": { c: "StateView", a: ADDR.stateView, f: "getSlot0(poolId A)", l: null },
  "poolA.liquidity": { c: "StateView", a: ADDR.stateView, f: "getLiquidity(poolId A)", l: null },
  "poolB.slot0": { c: "StateView", a: ADDR.stateView, f: "getSlot0(poolId B)", l: null },
  "poolB.liquidity": { c: "StateView", a: ADDR.stateView, f: "getLiquidity(poolId B)", l: null },
  "chainlink.latestRoundData": { c: "Chainlink ETH/USD", a: ADDR.chainlinkEthUsd, f: "latestRoundData()", l: null },
  "base.fp.totalSupply": { c: "Fren Pet (Base)", a: BASE.frenPet, f: "totalSupply()", l: null, chain: "base" },
  "base.fp.adapterBalance": { c: "Fren Pet (Base)", a: BASE.frenPet, f: "balanceOf(OFTAdapter)", l: null, chain: "base" },
  "base.fp.receiverBalance": { c: "Fren Pet (Base)", a: BASE.frenPet, f: "balanceOf(BaseBurnReceiver)", l: null, chain: "base" },
};

/**
 * Read the whole dashboard in as few round-trips as possible.
 * @param {Rpc} rpc
 * @param {{onProgress?: (msg: string) => void}} [opts]
 */
export async function collect(rpc, opts = {}) {
  const log = opts.onProgress || (() => {});
  const c = {};
  for (const name of Object.keys(ABI)) c[name] = new Contract(rpc, ADDR[name], ABI[name]);

  const head = await rpc.getBlock("latest");
  const blockNumber = Number(BigInt(head.number));
  const blockTimestamp = Number(BigInt(head.timestamp));
  log(`head block ${blockNumber}`);

  // ---- batch 1: all static views -------------------------------------
  const reqs = [];
  const tags = [];
  const push = (tag, contract, key, ...args) => {
    const r = contract.request(key, ...args);
    r.__tag = tag;
    reqs.push(r);
    tags.push(tag);
  };

  for (const k of [
    "tokensInPool", "ethInPool", "pendingTrim", "inventoryCap", "capFloor", "capDecayTokensPerDay",
    "capDecayRemainder", "lastCapDecayAt", "ratchetBps", "minTrimTokens", "rewardShareBps", "bpsDenominator",
    "totalBurned", "totalRewarded", "burnClaims", "rewardClaims", "ethClaims", "retainedEth",
    "lastClaimBlock", "totalFeeToken", "totalFeeEth", "feeTokenClaims", "feeEthClaims",
    "burnSink", "rewardsRecipient", "keeperReward", "owner",
    "backstop", "backstopEthPrincipal", "backstopConvertedEth", "backstopFillThreshold", "backstopIsFilled",
    "refTick", "maxRefStep", "deploymentFloorTick", "floorDecayTicksPerDay",
    "rebalanceEnabled", "rebalanceEthThreshold", "pendingRebalance",
    "marketOpen", "positionLiquidity", "currentTick", "currentSqrtPriceX96", "poolId", "token", "lpFee", "tickSpacing",
  ]) push("hook." + k, c.hook, k);

  for (const k of ["drippable", "canDrip", "dripRatePerSecond", "maxCatchupSeconds", "lastDripAt", "keeperReward", "minDripAmount", "vault", "imd", "owner"]) {
    push("dripper." + k, c.dripper, k);
  }
  for (const k of ["stakingEarned", "bondingEarned", "nftEarned", "heldBonding", "heldNft", "stakingBps", "bondingBps", "nftBps", "dripper", "asset", "owner"]) {
    push("distributor." + k, c.distributor, k);
  }
  for (const k of ["tokenBalance", "previewBridge", "minBridgeAmount", "oft", "dstEid", "baseBurnReceiver", "token", "owner"]) {
    push("burnExecutor." + k, c.burnExecutor, k);
  }
  for (const k of ["totalAssets", "totalSupply", "decimals", "paused", "asset", "owner"]) {
    push("simd." + k, c.simd, k);
  }
  for (const k of ["totalSupply", "decimals", "symbol", "owner"]) push("imd." + k, c.imd, k);

  // pool slot0 / liquidity via StateView
  push("poolA.slot0", c.stateView, "getSlot0", POOL_IDS.A);
  push("poolA.liquidity", c.stateView, "getLiquidity", POOL_IDS.A);
  push("poolB.slot0", c.stateView, "getSlot0", POOL_IDS.B);
  push("poolB.liquidity", c.stateView, "getLiquidity", POOL_IDS.B);

  // NB: Chainlink is deliberately NOT in this batch — the aggregator proxy is a
  // heavy call and some nodes rate-limit it inside a large batch. It is fetched
  // standalone in parallel below.

  log(`batching ${reqs.length} eth_calls…`);
  const raw = await rpc.batch(reqs);

  /** @type {Record<string, any>} */
  const v = {};
  const errors = {};
  reqs.forEach((r, i) => {
    const res = raw[i];
    if (!res || !res.ok) {
      errors[r.__tag] = res ? res.error : "no response";
      return;
    }
    try {
      // Single-output calls collapse to a scalar; tuples stay arrays.
      const dec = decodeReturns(r.__outs, res.result);
      v[r.__tag] = dec.length === 1 ? dec[0] : dec;
    } catch (e) {
      errors[r.__tag] = String(e.message || e);
    }
  });

  // Some public nodes apply a tighter gas cap to a batched eth_call than to a
  // standalone one, so heavy views (previewBridge()'s nested try/catch + OFT
  // quote, Chainlink's aggregator proxy) revert in a batch and succeed alone.
  // Re-ask those individually before reporting them as unavailable.
  const retryTags = Object.keys(errors);
  if (retryTags.length) {
    const retried = [];
    for (const tag of retryTags) {
      const req = reqs.find((r) => r.__tag === tag);
      if (!req) continue;
      try {
        const raw = await rpc.ethCall(req.params[0].to, req.params[0].data);
        const dec = decodeReturns(req.__outs, raw);
        v[tag] = dec.length === 1 ? dec[0] : dec;
        delete errors[tag];
        retried.push(tag);
      } catch (e) {
        errors[tag] = String(e.message || e);
      }
    }
    if (retried.length) log(`recovered ${retried.length} call(s) outside the batch: ${retried.join(", ")}`);
  }

  // ---- batch 2: balances + owner nonce --------------------------------
  const balAddrs = {
    hook: ADDR.hook,
    burnExecutor: ADDR.burnExecutor,
    dripper: ADDR.dripper,
    distributor: ADDR.distributor,
    simd: ADDR.simd,
    owner: ADDR.owner,
  };
  const balReqs = [];
  const balTags = [];
  for (const [name, a] of Object.entries(balAddrs)) {
    const r = c.imd.request("balanceOf", a);
    r.__tag = `bal.imd.${name}`;
    balReqs.push(r);
    balTags.push(r.__tag);
  }
  const nonceRes = await Promise.all([
    rpc.batch(balReqs),
    rpc.call("eth_getTransactionCount", [ADDR.owner, "latest"]),
    rpc.call("eth_getBalance", [ADDR.hook, "latest"]),
    rpc.call("eth_getBalance", [ADDR.owner, "latest"]),
    rpc.ethCall(ADDR.chainlinkEthUsd, encodeCall("decimals()")).catch(() => null),
    rpc.ethCall(ADDR.chainlinkEthUsd, encodeCall("latestRoundData()")).catch(() => null),
  ]);
  if (nonceRes[4]) {
    try {
      v["chainlink.decimals"] = decodeReturns(["uint8"], nonceRes[4])[0];
    } catch (e) {
      errors["chainlink.decimals"] = String(e.message || e);
    }
  } else {
    errors["chainlink.decimals"] = "no endpoint answered";
  }
  if (nonceRes[5]) {
    try {
      v["chainlink.latestRoundData"] = decodeReturns(["uint80", "int256", "uint256", "uint256", "uint80"], nonceRes[5]);
    } catch (e) {
      errors["chainlink.latestRoundData"] = String(e.message || e);
    }
  } else {
    errors["chainlink.latestRoundData"] = "no endpoint answered";
  }
  nonceRes[0].forEach((res, i) => {
    if (!res || !res.ok) {
      errors[balTags[i]] = res ? res.error : "no response";
      return;
    }
    try {
      v[balTags[i]] = decodeReturns(balReqs[i].__outs, res.result)[0];
    } catch (e) {
      errors[balTags[i]] = String(e.message || e);
    }
  });
  v["owner.nonce"] = Number(BigInt(nonceRes[1]));
  v["bal.eth.hook"] = BigInt(nonceRes[2]);
  v["bal.eth.owner"] = BigInt(nonceRes[3]);

  // ---- batch 3: Base chain (the second door) --------------------------
  // Base state (one totalSupply, two balances) moves slowly and the public Base
  // RPCs rate-limit hard, so the caller may skip this and reuse a cached snapshot.
  const baseVals = {};
  const baseErrors = {};
  let baseBlock = null;
  let baseSkipped = false;
  if (opts.includeBase === false) {
    baseSkipped = true;
  } else {
    try {
      const baseRpc = new Rpc(BASE.rpcs, { timeoutMs: 20000 });
      const cBase = new Contract(baseRpc, BASE.frenPet, BASE_ABI.erc20);
      const bReqs = [
        ["base.fp.totalSupply", cBase.request("totalSupply")],
        ["base.fp.decimals", cBase.request("decimals")],
        ["base.fp.symbol", cBase.request("symbol")],
        ["base.fp.adapterBalance", cBase.request("balanceOf", BASE.adapter)],
        ["base.fp.receiverBalance", cBase.request("balanceOf", BASE.burnReceiver)],
        ["base.fp.sourceDefaultBalance", cBase.request("balanceOf", BASE.sourceDefaultReceiver)],
      ];
      const bOut = await baseRpc.batch(bReqs.map(([, r]) => r));
      bOut.forEach((res, i) => {
        const [tag, req] = bReqs[i];
        if (!res || !res.ok) {
          baseErrors[tag] = res ? res.error : "no response";
          return;
        }
        try {
          const dec = decodeReturns(req.__outs, res.result);
          baseVals[tag] = dec.length === 1 ? dec[0] : dec;
        } catch (e) {
          baseErrors[tag] = String(e.message || e);
        }
      });
      baseBlock = await baseRpc.blockNumber();
      baseVals["base.endpoint"] = baseRpc.endpoint;
    } catch (e) {
      baseErrors["base"] = String(e.message || e);
    }
  }

  // ---- derive ---------------------------------------------------------
  const derived = derive(v, errors);

  return {
    ok: true,
    chainId: 1,
    blockNumber,
    blockTimestamp,
    fetchedAt: Date.now(),
    endpoint: rpc.endpoint,
    values: v,
    derived,
    errors,
    base: { blockNumber: baseBlock, values: baseVals, errors: baseErrors, chainId: BASE.chainId, skipped: baseSkipped },
  };
}

function decodeTagged(req, res) {
  return decodeReturns(req.__outs, res);
}

/* ------------------------------------------------------------------ *
 * Derived economics — all formulas mirror the Solidity
 * ------------------------------------------------------------------ */

export function derive(v, errors = {}) {
  const g = (tag, fallback = 0n) => (v[tag] === undefined ? fallback : v[tag]);
  const E18 = 10n ** 18n;

  const held = g("hook.tokensInPool");
  const cap = g("hook.inventoryCap");
  const floor = g("hook.capFloor");
  const ethInPool = g("hook.ethInPool");
  const pendingTrim = g("hook.pendingTrim"); // authoritative: mirrors _applyCap
  const minTrim = g("hook.minTrimTokens");

  // --- ignition distance (mirrors CappedBurnHook.sol L352-357) ---
  const gapRaw = cap > held ? cap - held : 0n;
  const gapWithMinTrim = gapRaw + (minTrim > 0n ? minTrim : 0n);
  const excess = held > cap ? held - cap : 0n;

  // --- prices ---
  const price = (sqrtStr) => {
    const s = BigInt(sqrtStr || 0);
    if (s === 0n) return { ethPerImd: 0n, imdPerEth: 0n, sqrtPriceX96: 0n };
    const p192 = s * s; // IMD wei per ETH wei, scaled by 2^192
    // ETH per IMD, 18 decimals: (2^192 * 1e18) / p192
    const ethPerImd = (Q192 * E18) / p192;
    const imdPerEth = (p192 * E18) / Q192;
    return { ethPerImd, imdPerEth, sqrtPriceX96: s };
  };
  const pA = price(v["poolA.slot0"] ? v["poolA.slot0"][0] : 0n);
  const pB = price(v["poolB.slot0"] ? v["poolB.slot0"][0] : 0n);

  const cl = v["chainlink.latestRoundData"];
  const clDec = Number(g("chainlink.decimals", 8n));
  let ethUsd = 0n; // 18 decimals
  if (cl) {
    const answer = cl[1];
    if (answer > 0n) ethUsd = (answer * E18) / 10n ** BigInt(clDec);
  }

  const valueInEth = (tokens) => mul18(tokens, pB.ethPerImd);
  const valueInUsd = (tokens) => mul18(valueInEth(tokens), ethUsd);

  // --- 85/15 split of the *pending* trim (mirrors _disperse, L1031-1041) ---
  const shareBps = g("hook.rewardShareBps");
  const pendingReward = (pendingTrim * shareBps) / 10000n;
  const pendingBurn = pendingTrim - pendingReward;

  // --- what the NEXT swap that pushes inventory over the cap would do ---
  // (An earlier field `hypotheticalExcess` simply mirrored `gapRaw` while its name
  // promised something else. Nothing rendered it, so it was deleted rather than kept as a
  // misleading number in the snapshot.)

  // --- dripper ---
  const dripRate = g("dripper.dripRatePerSecond");
  const drippable = g("dripper.drippable");
  const dripperBal = g("bal.imd.dripper");
  const maxCatchup = g("dripper.maxCatchupSeconds");
  const perCallCeiling = dripRate * maxCatchup;
  // Buffer = balance ÷ rate (both "per second"), then seconds → days. The first version
  // multiplied by 86400 instead of dividing by it, and reported 26,270,609 days for a
  // buffer that lasts 304 seconds — wrong by 86400². Units are in the comment because
  // nothing else in the type system could have caught that.
  const daysOfBuffer = dripRate > 0n ? Number((dripperBal * 1_000_000n) / (dripRate * 86400n)) / 1_000_000 : 0;

  // --- sIMD ---
  const totalAssets = g("simd.totalAssets");
  const totalSupply = g("simd.totalSupply");
  const simdDecimals = Number(g("simd.decimals", 18n));
  // rate = totalAssets(18dp) / totalSupply(simdDecimals dp), expressed as 18dp IMD per 1 sIMD
  const simdScale = 10n ** BigInt(simdDecimals);
  const simdRate = totalSupply > 0n ? (totalAssets * simdScale) / totalSupply : 0n; // 18dp
  const simdShareOfSupply = (() => {
    const total = g("imd.totalSupply");
    return total > 0n ? (totalAssets * 10000n) / total : 0n; // bps of IMD supply
  })();

  // --- burn pipeline ---
  const pendingBridge = g("burnExecutor.tokenBalance");
  const preview = v["burnExecutor.previewBridge"] || [0n, 0n, 0n];

  // --- state machine ---
  // DORMANT  : nothing trims on the next swap (held <= cap) and the ratchet has bottomed at capFloor
  // ARMED    : within `armWindow` of the cap (default 10% of cap) but still below
  // CRITICAL : held within 1% of cap
  // LIVE     : held > cap  -> pendingTrim > 0, next swap trims
  // Three states, taken strictly from the contract's own branch structure:
  //   LIVE      held > cap (or pendingTrim > 0)  -> _applyCap takes the trim branch (L991-992)
  //   CRITICAL  held <= cap, cap > capFloor      -> the ratchet can still move the cap (L971 true)
  //   DORMANT   held <= cap, cap == capFloor     -> the ratchet is pinned; nothing happens
  // `pendingTrim()` is the authoritative trigger reading, so it decides LIVE on its own.
  let state;
  if (pendingTrim > 0n || held > cap) state = "LIVE";
  else if (cap > floor) state = "CRITICAL";
  else state = "DORMANT";

  const ratchetAtFloor = cap <= floor;
  const ratchetDead = g("hook.ratchetBps") === 0n || g("hook.capDecayTokensPerDay") === 0n;

  /** Burned ÷ rewarded so far — a ratio, not an amount. */
  const burnRatio = g("hook.totalRewarded") > 0n ? Number((g("hook.totalBurned") * 10000n) / g("hook.totalRewarded")) / 10000 : null;

  return {
    // Every amount below is a wei-denominated bigint unless the comment says otherwise.
    // The units are part of the contract of this function: two fields were wrong here
    // precisely because nothing said what they were measured in.
    held, cap, floor, ethInPool, pendingTrim, minTrim, // IMD, IMD, IMD, ETH, IMD, IMD
    gapRaw, gapWithMinTrim, excess, // IMD
    gapEth: valueInEth(gapRaw), // ETH
    gapUsd: valueInUsd(gapRaw), // USD
    ethInPoolUsd: mul18(ethInPool, ethUsd), // USD — ethInPool is ALREADY ETH; do not price it again
    priceA: pA, priceB: pB, // {ethPerImd, imdPerEth} 18dp; sqrtPriceX96 raw
    ethUsd, // USD per ETH, 18dp
    pendingBurn, pendingReward, shareBps, // IMD, IMD, bps
    dripRate, drippable, dripperBal, perCallCeiling, // IMD/second, IMD, IMD, IMD
    daysOfBuffer, // days (a Number, not a bigint)
    totalAssets, totalSupply, simdDecimals, // IMD, sIMD (24dp), count
    simdRate, // IMD per 1 sIMD, 18dp
    simdShareOfSupply, // bps of total IMD supply
    pendingBridge, // IMD
    bridgeAmountToSend: preview[0] || 0n, // IMD
    bridgeMinReceive: preview[1] || 0n, // IMD
    bridgeNativeFee: preview[2] || 0n, // ETH (LayerZero native fee)
    state, // "LIVE" | "CRITICAL" | "DORMANT"
    armWindow: cap / 10n, critWindow: cap / 100n, // IMD
    ratchetAtFloor, ratchetDead, // boolean
    burnRatio, // totalBurned ÷ totalRewarded (Number) or null
  };
}

/**
 * Magnitude sanity checks for derive() output.
 *
 * The inputs here are not trustworthy by construction. Public RPC endpoints answer
 * archive calls only intermittently, and when they answer wrongly they return a
 * plausible-looking number instead of an error — NOTES.md §16 records a 6-orders-of-
 * magnitude disagreement that no type system would have caught. So every derived
 * quantity with a physical meaning gets a range check, and the page can refuse to
 * present a number it cannot justify.
 *
 * @param {object} d the object returned by derive()
 * @returns {{field: string, value: any, message: string}[]} empty when everything is sane
 */
export function sanityCheckDerived(d) {
  const issues = [];
  const bad = (field, value, message) => issues.push({ field, value, message });
  // Values reach this function in three shapes: a bigint (live), a number (ratios), or a
  // string (anything that round-tripped through JSON — data/baseline.json stores every
  // wei amount as a string). Accepting only bigint/number made every check below silently
  // skip its field, so the audit passed while checking nothing.
  const num = (v) => {
    if (typeof v === "number") return v;
    if (typeof v === "bigint") return Number(v);
    if (typeof v === "string" && v.trim() !== "") return Number(v);
    return NaN;
  };
  const e18 = (v) => num(v) / 1e18;

  // A drip buffer that lasts longer than a year is not a buffer: either the rate or the
  // balance is wrong, or the units are.
  if (d.daysOfBuffer !== undefined && d.daysOfBuffer !== null) {
    const v = num(d.daysOfBuffer);
    if (!Number.isFinite(v) || v < 0) bad("daysOfBuffer", d.daysOfBuffer, "not a non-negative number");
    else if (v > 365) bad("daysOfBuffer", d.daysOfBuffer, `a drip buffer cannot last ${v} days (> 365) — unit error or stale reading`);
  }

  // ethInPoolUsd must agree with ethInPool × ethUsd to within 10×.
  const ethUsd = e18(d.ethUsd);
  if (ethUsd > 0) {
    if (ethUsd < 100 || ethUsd > 100_000) bad("ethUsd", ethUsd, `${ethUsd} USD/ETH is outside any plausible range`);
    const checks = [
      ["ethInPoolUsd", num(d.ethInPool), num(d.ethInPoolUsd), "ethInPool × ethUsd"],
      ["gapUsd", num(d.gapEth), num(d.gapUsd), "gapEth × ethUsd"],
    ];
    for (const [field, base, got, how] of checks) {
      if (!Number.isFinite(got) || base <= 0) continue;
      const expected = (base * num(d.ethUsd)) / 1e18;
      if (expected <= 0) continue;
      const ratio = got / expected;
      if (!(ratio > 0.1 && ratio < 10)) {
        bad(
          field,
          e18(got),
          `expected ≈ ${e18(expected).toFixed(2)} USD (${how}), got ${e18(got).toFixed(2)} — off by ${ratio.toFixed(4)}×`
        );
      }
    }
  }

  // One sIMD should be worth a sane number of IMD; a decimals mistake shows up here first.
  const simdRate = e18(d.simdRate);
  if (simdRate > 0 && (simdRate <= 0.001 || simdRate > 1_000)) {
    bad("simdRate", simdRate, `1 sIMD = ${simdRate} IMD is outside any plausible range (0.001 … 1000)`);
  }

  // You cannot be able to drip more than the contract holds.
  if (d.drippable !== undefined && d.dripperBal !== undefined && num(d.drippable) > num(d.dripperBal)) {
    bad("drippable", e18(d.drippable), `drippable (${e18(d.drippable)}) exceeds the contract balance (${e18(d.dripperBal)})`);
  }

  // The caps and the ratchet windows are all denominated in the same token.
  if (num(d.cap) > 0 && num(d.floor) > num(d.cap)) bad("floor", e18(d.floor), "capFloor is above inventoryCap");
  if (num(d.armWindow) > num(d.cap) || num(d.critWindow) > num(d.cap)) {
    bad("armWindow/critWindow", e18(d.critWindow), "state windows are larger than the cap they are derived from");
  }

  return issues;
}

/* ------------------------------------------------------------------ *
 * The second door: IMD queued inside BurnExecutor, waiting to be bridged to Base
 *
 * BurnExecutor does NOT burn. It is a waypoint: IMD accumulates here from trims, and
 * only leaves when someone pays gas to call bridgeToBaseBurnReceiver(). So a rising
 * balance here means "the first door is delivering", NOT "tokens were destroyed" —
 * conflating the two would contradict the whole two-doors framing.
 *
 * The dev made this callable by anyone (block 25793366) and asked for a bot, so
 * "nobody is pushing this door" is a statement the page can make with a source.
 * ------------------------------------------------------------------ */

/** Archive-capable endpoints — a plain endpoint will not serve historical eth_call. */
export const ARCHIVE_RPCS = [
  "https://eth.drpc.org",
  "https://gateway.tenderly.co/public/mainnet",
  "https://rpc.mevblocker.io",
  "https://eth-mainnet.public.blastapi.io",
];

/**
 * Read the sample series: is anyone actually pushing the second door?
 *
 * `hist.points` runs newest-first and carries {label, value} — the page builds it from
 * data/bridge-history.json (rebuilt out of Transfer logs) with the live balance swapped
 * into the "now" slot.
 *
 * This replaced an eth_call-at-a-past-block sampler: that needs an archive node, the
 * public fleet answers such calls only intermittently, and when it did answer, the
 * numbers disagreed with the Transfer logs by thousands of IMD. Logs are the evidence;
 * a partially-available archive endpoint is not.
 *
 * "growing" = the series never fell between samples; "moving" = it fell at least once,
 * which means someone paid gas to bridge. Flat means nothing arrived and nothing left.
 */
export function readBridgeTrend(hist) {
  const known = hist.points.filter((p) => p.value !== null);
  if (known.length < 2) return { verdict: "unknown", fell: 0, samples: known.length };
  let fell = 0;
  let rose = 0;
  // walk oldest -> newest
  for (let i = known.length - 1; i > 0; i--) {
    const older = known[i].value;
    const newer = known[i - 1].value;
    if (newer < older) fell++;
    else if (newer > older) rose++;
  }
  const net24 = (() => {
    const a = hist.points.find((p) => p.label === "24h");
    const b = hist.points.find((p) => p.label === "now");
    return a && a.value !== null && b && b.value !== null ? b.value - a.value : null;
  })();
  const net7d = (() => {
    const a = hist.points.find((p) => p.label === "7d");
    const b = hist.points.find((p) => p.label === "now");
    return a && a.value !== null && b && b.value !== null ? b.value - a.value : null;
  })();
  const verdict = fell > 0 ? "moving" : rose > 0 ? "growing" : "flat";
  return { verdict, fell, rose, net24, net7d, samples: known.length };
}
