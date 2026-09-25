// Known-answer self-test for lib/evm.js.
// Vectors in VECTORS were produced by ethers v6 (an independent implementation),
// so this validates our hand-rolled keccak-256 and ABI codec against something
// other than itself. See _imd_research/tmp/genvectors.mjs.
//
// Run:  node scripts/selftest.mjs
import { keccak256Hex, selector, encodeCall, decodeReturns, fmt18, fmtUnits } from "../lib/evm.js";
import { POOLS, computePoolId, ADDR, POOL_IDS } from "../lib/contracts.js";
import { templateToZh, isBalanced } from "../lib/scan-strings.js";
import { snapshotTimestamp, oldestSnapshot, snapshotAges } from "../lib/snapshots.js";

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
  /* The one the suite never covered, and the one that actually shipped a bug: collect.mjs
   * writes data/baseline.json's fetchedAt as Date.now() — MILLISECONDS — while the other five
   * snapshots write ISO strings. The old rule was "a number > 1e9 is seconds", which
   * milliseconds also satisfy, so the stamp was multiplied by 1000 twice and landed in the
   * year 58,701. Its age read as −14.3 million hours. oldestSnapshot() reports the OLDEST
   * source, so a future-dated one can never win: the staleness banner would have gone
   * permanently silent the day baseline.json was added to the monitored set. */
  /* Pin ONE instant and use it on both sides.
   *
   * These two assertions each called Date.now() twice — once to build the input, once to build
   * the expected value. On a fast machine the two calls land in the same millisecond and the
   * equality holds; when a millisecond boundary falls between them the assertion fails with a
   * 1ms difference. That is a race in the TEST, not a defect in the code: it made `npm test`
   * fail roughly one run in a few hundred, with a message that looks like a real regression
   * ("milliseconds are taken as milliseconds" — got 1790311659315, want 1790311659322).
   *
   * A flaky assertion is worse than a missing one: it trains the reader to re-run instead of
   * investigate, which is exactly how a genuine failure gets waved through. So the clock is read
   * once, and the value under test is compared to that same reading. */
  const oneInstant = Date.now();
  eq("milliseconds are taken as milliseconds, not multiplied again", snapshotTimestamp({ fetchedAt: oneInstant }), oneInstant);
  eq("a real collect.mjs stamp keeps its real age", Math.round((oneInstant - snapshotTimestamp({ fetchedAt: 1790268585235 })) / 3_600_000), Math.round((oneInstant - 1790268585235) / 3_600_000));
  eq("the millisecond path does not drift into the future", snapshotTimestamp({ fetchedAt: Date.now() }) <= Date.now() + 1000, true);
  eq("the seconds path still works below the cutoff", snapshotTimestamp({ fetchedAt: 1_790_268_585 }), 1_790_268_585_000);
  eq("a snapshot with no timestamp returns null", snapshotTimestamp({ builtAt: "not a date" }), null);
  eq("null input returns null", snapshotTimestamp(null), null);

  const oldest = oldestSnapshot({ a: { builtAt: iso(1) }, b: { builtAt: iso(7) }, c: {} }, now);
  eq("the oldest snapshot is the one reported", oldest.name, "b");
  eq("its age is measured in hours", Math.round(oldest.ageHours), 7);
  eq("sources without timestamps are skipped", oldestSnapshot({ a: {}, b: null }, now), null);
  eq("an empty set has no oldest", oldestSnapshot({}, now), null);

  /* ------------------------------------------------------------------ *
   * snapshotAges(): "how many are stale", not "how old is the worst one"
   *
   * The banner used to report only the single oldest source, which is correct arithmetic and
   * a misleading sentence when a refresh job fails per-step. Measured on the real project on
   * 2026-09-25, two readings minutes apart gave 1-of-5-stale and 3-of-6-stale — both times the
   * banner would have named one source and stayed silent about the rest.
   *
   * The four cases below are the four readings that matter, and they are deliberately the four
   * the banner's three branches must distinguish: none stale, some stale (the insidious one),
   * all stale, and exactly one. `oldest` is asserted equal to oldestSnapshot()'s result so the
   * two functions cannot drift apart.
   * ------------------------------------------------------------------ */
  const T = 3;
  const ages = (src) => snapshotAges(src, now, T);

  const allFresh = ages({ a: { builtAt: iso(0.5) }, b: { builtAt: iso(1) }, c: { builtAt: iso(2) } });
  eq("all fresh: nothing is stale", allFresh.staleCount, 0);
  eq("all fresh: every source is still counted", allFresh.total, 3);

  /* THE CASE THE OLD BANNER COULD NOT EXPRESS. One source frozen, two healthy: the banner said
   * "the oldest is 9.4h" and a reader could not tell whether the other two were also frozen. */
  const partly = ages({ fresh1: { builtAt: iso(0.2) }, fresh2: { builtAt: iso(1) }, stale1: { builtAt: iso(9.4) } });
  eq("partly stale: exactly one is counted stale", partly.staleCount, 1);
  eq("partly stale: total still counts all three", partly.total, 3);
  eq("partly stale: the stale one is named", partly.stale[0].name, "stale1");
  eq("partly stale: healthy sources are NOT reported stale", partly.stale.some((s) => s.name === "fresh1" || s.name === "fresh2"), false);

  const allStale = ages({ a: { builtAt: iso(9) }, b: { builtAt: iso(10) }, c: { builtAt: iso(11) } });
  eq("all stale: all three are counted", allStale.staleCount, 3);
  eq("all stale: staleCount equals total", allStale.staleCount, allStale.total);
  eq("all stale: ordered oldest first", allStale.stale.map((s) => s.name).join(), "c,b,a");

  const mixed = ages({ timeline: { builtAt: iso(0.1) }, base: { builtAt: iso(9.4) }, messages: { builtAt: iso(9.4) }, volume: { builtAt: iso(0.2) } });
  eq("mixed: two of four are stale", mixed.staleCount, 2);
  eq("mixed: total is four", mixed.total, 4);
  eq("mixed: the fresh timeline is not stale", mixed.stale.some((s) => s.name === "timeline"), false);

  /* The threshold is inclusive-below: an age exactly at it is NOT stale, matching the page's
   * own `ageHours > STALE_AFTER_HOURS` test. */
  eq("an age exactly at the threshold is not stale", ages({ a: { builtAt: iso(3) } }).staleCount, 0);
  eq("an age just past the threshold is stale", ages({ a: { builtAt: iso(3.01) } }).staleCount, 1);

  /* Sources with no readable timestamp are skipped, so they cannot inflate `total` — which
   * matters because the banner prints "N of M" and a silent generator must not be counted as
   * a healthy one. */
  const silent = ages({ a: { builtAt: iso(0.5) }, b: {}, c: null, d: { builtAt: "not a date" } });
  eq("sources without timestamps are excluded from total", silent.total, 1);
  eq("a silent source is not counted as stale", silent.staleCount, 0);
  eq("an empty set yields 0 of 0", (() => { const e = ages({}); return e.staleCount === 0 && e.total === 0; })(), true);

  /* Agreement with the function the page still uses for its per-figure wording. If these two
   * ever disagree, the banner and the "X ago or more recent" qualifier are reading different
   * facts about the same data. */
  const agreeSrc = { timeline: { builtAt: iso(0.1) }, base: { builtAt: iso(9.4) }, messages: { builtAt: iso(2) } };
  const ag = ages(agreeSrc);
  const ol = oldestSnapshot(agreeSrc, now);
  eq("snapshotAges().oldest equals oldestSnapshot()", `${ag.oldest.name}|${ag.oldest.ageHours}`, `${ol.name}|${ol.ageHours}`);
  eq("oldestSnapshot still returns only name and ageHours", Object.keys(ol).sort().join(), "ageHours,name");
}

console.log(`\n${pass} passed, ${fail} failed`);
await new Promise((resolve) => process.stdout.write("", resolve));
process.exit(fail === 0 ? 0 : 1);
