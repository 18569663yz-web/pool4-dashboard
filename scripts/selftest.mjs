// Known-answer self-test for lib/evm.js.
// Vectors in VECTORS were produced by ethers v6 (an independent implementation),
// so this validates our hand-rolled keccak-256 and ABI codec against something
// other than itself. See _imd_research/tmp/genvectors.mjs.
//
// Run:  node scripts/selftest.mjs
import { keccak256Hex, selector, encodeCall, decodeReturns, fmt18, fmtUnits } from "../lib/evm.js";
import { POOLS, computePoolId, ADDR, POOL_IDS } from "../lib/contracts.js";
import { templateToZh, isBalanced } from "../lib/scan-strings.js";
import { snapshotTimestamp, oldestSnapshot } from "../lib/snapshots.js";

const VECTORS = [
  ["keccak256('')", "", "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"],
  ["keccak256('abc')", "abc", "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"],
  [
    "keccak256('The quick brown fox jumps over the lazy dog')",
    "The quick brown fox jumps over the lazy dog",
    "0x4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15",
  ],
  // 200 bytes and 2000 bytes both cross the 136-byte rate boundary: multi-block absorption
  ["keccak256(200 x 'a')", "a".repeat(200), "0x96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d"],
  ["keccak256(2000 chars)", "ab".repeat(1000), "0xd634aff7ae122da7242d20afb872d1d5cec4b022714dbe9ba863b736297a3eb3"],
];

const SELECTORS = {
  "transfer(address,uint256)": "0xa9059cbb",
  "balanceOf(address)": "0x70a08231",
  "totalAssets()": "0x01e1d114",
  "pendingTrim()": "0x8fd56138",
  "drippable()": "0xd470b82c",
  "previewBridge()": "0xe102463d",
  "getSlot0(bytes32)": "0xc815641c",
};

let pass = 0;
let fail = 0;
function eq(label, got, want) {
  const ok = String(got).toLowerCase() === String(want).toLowerCase();
  if (ok) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}\n         got  ${got}\n         want ${want}`);
  }
}

console.log("keccak-256 (vs ethers v6)");
for (const [label, input, want] of VECTORS) eq(label, keccak256Hex(input), want);

console.log("\nselectors (vs ethers v6)");
for (const [sig, want] of Object.entries(SELECTORS)) eq(sig, selector(sig), want);

console.log("\nABI encode (vs ethers v6)");
eq(
  "balanceOf(0x047F…54B7)",
  encodeCall("balanceOf(address)", ["address"], ["0x047F606fD5b2BaA5f5C6c4aB8958E45CB6B054B7"]),
  "0x70a08231000000000000000000000000047f606fd5b2baa5f5c6c4ab8958e45cb6b054b7"
);
eq(
  "convertToAssets(1e18)",
  encodeCall("convertToAssets(uint256)", ["uint256"], [10n ** 18n]),
  "0x07a2d13a0000000000000000000000000000000000000000000000000de0b6b3a7640000"
);
eq(
  "getSlot0(poolA id)",
  encodeCall("getSlot0(bytes32)", ["bytes32"], ["0xb07d640fd9e2eb9dc81b953c8e4fd006bdfeaf276010fb5418eb763ca15abfb3"]),
  "0xc815641cb07d640fd9e2eb9dc81b953c8e4fd006bdfeaf276010fb5418eb763ca15abfb3"
);

console.log("\nABI decode (vs ethers v6)");
eq(
  "uint256 = 13544.04e18",
  decodeReturns(["uint256"], "0x0000000000000000000000000000000000000000000002de39502c99c1a40000")[0],
  13544040000000000000000n
);
eq("int24 = -1", decodeReturns(["int24"], "0x" + "ff".repeat(32))[0], -1n);
// -887272 = 0xF27618 sign-extended across the full 256-bit word
eq("int24 = -887272", decodeReturns(["int24"], "0x" + "f".repeat(58) + "f27618")[0], -887272n);
eq(
  "uint128 = max",
  decodeReturns(["uint128"], "0x00000000000000000000000000000000ffffffffffffffffffffffffffffffff")[0],
  340282366920938463463374607431768211455n
);
eq(
  "bool true",
  decodeReturns(["bool"], "0x0000000000000000000000000000000000000000000000000000000000000001")[0],
  true
);
eq(
  "address",
  decodeReturns(["address"], "0x000000000000000000000000d34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7")[0],
  "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7"
);
eq(
  "string 'IMD'",
  decodeReturns(
    ["string"],
    "0x0000000000000000000000000000000000000000000000000000000000000020" +
      "0000000000000000000000000000000000000000000000000000000000000003" +
      "494d440000000000000000000000000000000000000000000000000000000000"
  )[0],
  "IMD"
);

console.log("\nPoolKey -> poolId (vs ethers v6 + the poolId published for pool A)");
eq("pool A", POOL_IDS.A, "0xb07d640fd9e2eb9dc81b953c8e4fd006bdfeaf276010fb5418eb763ca15abfb3");
eq("pool B", POOL_IDS.B, "0x415829f72e9f54531c26eae76f107618540e898a45d6ae35959e143f5faca704");
eq(
  "computePoolId() is stable",
  computePoolId({ currency1: ADDR.imd, ...POOLS.B }),
  "0x415829f72e9f54531c26eae76f107618540e898a45d6ae35959e143f5faca704"
);

console.log("\nformatting");
eq("fmt18 13544.04", fmt18(13544040000000000000000n, 4), "13,544.0400");
eq("fmt18 0", fmt18(0n, 2), "0.00");
eq("fmtUnits 203889.86 @24dp", fmtUnits(20388986n * 10n ** 22n, 24, 2), "203,889.86");

/* ------------------------------------------------------------------ *
 * literal scanning — the i18n migration depends on this being exact
 *
 * A regex extractor silently truncated the first case below, and the truncated
 * expression was spliced into a tr() call: a syntax error in the shipped page, found
 * only because the render test reported "0 failed" while producing almost no output.
 * Pin the behaviour that replaced it.
 * ------------------------------------------------------------------ */
console.log("\ntemplate literal extraction");
{
  const nested = "`<br>地址：${list.map((a) => `<code>${esc(a)}</code>`).join(sep)}。`".slice(1, -1);
  const r = templateToZh(nested);
  eq("placeholder replaces the whole nested expression", r.zh, "<br>地址：{p0}。");
  eq("the nested template survives intact", r.params[0], "list.map((a) => `<code>${esc(a)}</code>`).join(sep)");
  eq("nested params are balanced", isBalanced(r.params[0]), true);

  const ternary = '`a ${n} b ${x ? f("k", { p: n }) : ""}${y ? z : ""}`'.slice(1, -1);
  const r2 = templateToZh(ternary);
  eq("three placeholders", r2.zh, "a {p0} b {p1}{p2}");
  eq("object literal inside a ternary is kept whole", r2.params[1], 'x ? f("k", { p: n }) : ""');

  eq("isBalanced rejects a truncated expression", isBalanced("list.map((a) => `<code>${esc(a)"), false);
  eq("isBalanced accepts plain calls", isBalanced("fmt18(v, 4)"), true);
  eq("isBalanced tolerates braces in strings", isBalanced('f("}")'), true);
}

/* ------------------------------------------------------------------ *
 * snapshot freshness — the page shows a banner once the oldest snapshot is stale
 * ------------------------------------------------------------------ */
console.log("\nsnapshot freshness");
{
  const now = Date.parse("2026-09-24T12:00:00Z");
  const iso = (h) => new Date(now - h * 3_600_000).toISOString();

  eq("builtAt is read", snapshotTimestamp({ builtAt: iso(1) }), now - 3_600_000);
  eq("fetchedAt is read", snapshotTimestamp({ fetchedAt: iso(2) }), now - 2 * 3_600_000);
  eq("scannedAt is read", snapshotTimestamp({ scannedAt: iso(3) }), now - 3 * 3_600_000);
  eq("epoch seconds are accepted too", snapshotTimestamp({ scannedAt: Math.floor(now / 1000) }), Math.floor(now / 1000) * 1000);
  eq("a snapshot with no timestamp returns null", snapshotTimestamp({ builtAt: "not a date" }), null);
  eq("null input returns null", snapshotTimestamp(null), null);

  const oldest = oldestSnapshot({ a: { builtAt: iso(1) }, b: { builtAt: iso(7) }, c: {} }, now);
  eq("the oldest snapshot is the one reported", oldest.name, "b");
  eq("its age is measured in hours", Math.round(oldest.ageHours), 7);
  eq("sources without timestamps are skipped", oldestSnapshot({ a: {}, b: null }, now), null);
  eq("an empty set has no oldest", oldestSnapshot({}, now), null);
}

console.log(`\n${pass} passed, ${fail} failed`);
await new Promise((resolve) => process.stdout.write("", resolve));
process.exit(fail === 0 ? 0 : 1);
