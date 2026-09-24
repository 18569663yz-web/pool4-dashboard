// Derived-quantity audit: magnitudes, units, and which fields nobody reads.
//
// Two fields in derive() were wrong for a long time — `daysOfBuffer` multiplied by 86400
// instead of dividing (26,270,609 days for a 304-second buffer) and `ethInPoolUsd` priced
// ETH as if it were IMD (off by ~493×). Nothing caught them because nothing said what
// they were measured in, and nothing checked whether they were used at all.
//
// This script is the answer to both:
//   1. every derived field gets a magnitude check (sanityCheckDerived),
//   2. fields that no render path reads are listed, so they can be deleted or justified,
//   3. the checks themselves are exercised against known-bad inputs — an assertion that
//      cannot fail is not an assertion.
//
//   node scripts/check-derived.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { derive, sanityCheckDerived } from "../lib/contracts.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(ROOT + p, "utf8");
const E18 = 10n ** 18n;

let pass = 0;
let fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}${detail ? "\n       " + detail : ""}`);
  }
};

const baseline = JSON.parse(read("data/baseline.json"));
const d = baseline.derived;
const e18 = (v) => Number(v) / 1e18;

console.log(`baseline derived (${Object.keys(d).length} fields, block ${baseline.blockNumber})`);

console.log("\nmagnitude checks on the real snapshot");
{
  const issues = sanityCheckDerived(d);
  ok("every derived quantity is in a physically plausible range", issues.length === 0, issues.map((i) => `${i.field}: ${i.message}`).join(" | "));
}

console.log("\nthe two fields that were wrong");
{
  const balance = e18(d.dripperBal);
  const perSecond = e18(d.dripRate);
  const expectedDays = perSecond > 0 ? balance / perSecond / 86400 : 0;
  ok(
    `daysOfBuffer matches balance ÷ rate ÷ 86400 (${expectedDays.toFixed(6)} days)`,
    Math.abs(d.daysOfBuffer - expectedDays) < 1e-6,
    `got ${d.daysOfBuffer}`
  );
  ok("daysOfBuffer is the same order as its own inputs (not 86400² too large)", d.daysOfBuffer < 365, `${d.daysOfBuffer} days`);

  const expectedUsd = (Number(d.ethInPool) * Number(d.ethUsd)) / 1e36;
  ok(
    `ethInPoolUsd matches ethInPool × ethUsd ($${expectedUsd.toFixed(2)})`,
    Math.abs(e18(d.ethInPoolUsd) - expectedUsd) / expectedUsd < 0.001,
    `got $${e18(d.ethInPoolUsd).toFixed(2)}`
  );
}

console.log("\ngapUsd / gapEth cross-check");
{
  if (Number(d.gapEth) > 0) {
    const expected = (Number(d.gapEth) * Number(d.ethUsd)) / 1e36;
    ok(`gapUsd matches gapEth × ethUsd ($${expected.toFixed(2)})`, Math.abs(e18(d.gapUsd) - expected) < 0.01, `got $${e18(d.gapUsd).toFixed(2)}`);
  } else {
    ok("gap fields are zero when the pool sits on the line, and stay consistent", Number(d.gapRaw) === 0 && Number(d.gapUsd) === 0 && Number(d.gapEth) === 0, `gapRaw=${d.gapRaw} gapUsd=${d.gapUsd}`);
  }
}

console.log("\nthe checks can actually fail (regression on the fixes)");
{
  const bad1 = { ...d, daysOfBuffer: 26_270_609.788 };
  ok("the old daysOfBuffer value is rejected", sanityCheckDerived(bad1).some((i) => i.field === "daysOfBuffer"));

  const bad2 = { ...d, ethInPoolUsd: (Number(d.ethInPool) * Number(d.ethUsd)) / 1e36 * 1e18 * 0.002 }; // priced as if it were IMD
  ok("the old ethInPoolUsd value is rejected", sanityCheckDerived(bad2).some((i) => i.field === "ethInPoolUsd"));

  const bad3 = { ...d, ethInPoolUsd: String(BigInt(Math.round((Number(d.ethInPool) * Number(d.ethUsd)) / 1e18)) * 100n) }; // 100× off
  ok("a 100× error is rejected", sanityCheckDerived(bad3).some((i) => i.field === "ethInPoolUsd"));

  const bad4 = { ...d, simdRate: String(E18 / 1000n) }; // decimals mistake: 1 sIMD = 0.001 IMD
  ok("a simdRate decimals mistake is rejected", sanityCheckDerived(bad4).some((i) => i.field === "simdRate"));

  const bad5 = { ...d, drippable: String(BigInt(d.dripperBal) * 2n) };
  ok("drippable above the contract balance is rejected", sanityCheckDerived(bad5).some((i) => i.field === "drippable"));

  const good = { ...d };
  ok("the real snapshot passes the same checks", sanityCheckDerived(good).length === 0);
}

console.log("\nfields no render path reads");
{
  const app = read("assets/app.js");
  const html = read("index.html");
  const referenced = new Set();
  for (const m of app.matchAll(/\bd\.([A-Za-z][A-Za-z0-9_]*)/g)) referenced.add(m[1]);
  for (const m of app.matchAll(/derived\.([A-Za-z][A-Za-z0-9_]*)/g)) referenced.add(m[1]);
  for (const m of html.matchAll(/derived\.([A-Za-z][A-Za-z0-9_]*)/g)) referenced.add(m[1]);

  const unused = Object.keys(d).filter((k) => !referenced.has(k));
  if (unused.length) {
    console.log(`  ${unused.length} of ${Object.keys(d).length}: ${unused.join(", ")}`);
    console.log("  (kept for the offline snapshot / forensics — but nothing renders them)");
  } else {
    console.log("  none");
  }
  // Not a failure: several exist for `data/baseline.json` cross-checking. The point is
  // that the list is visible when a field is added and never wired up.
}

console.log("\nderive() on empty input must not throw");
{
  const empty = derive({}, {});
  ok("derive({}) returns a full shape", Object.keys(empty).length === Object.keys(d).length, `${Object.keys(empty).length} vs ${Object.keys(d).length}`);
  ok("and passes its own sanity checks", sanityCheckDerived(empty).length === 0, JSON.stringify(sanityCheckDerived(empty)));
}

console.log(`\n${pass} passed, ${fail} failed`);
await new Promise((resolve) => process.stdout.write("", resolve));
process.exit(fail === 0 ? 0 : 1);
