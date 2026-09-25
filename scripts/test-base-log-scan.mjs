// Tests for lib/base-log-scan.js — the resume watermark above all.
//
// Why these exist: every one of these behaviours fails SILENTLY when wrong. A resume point set
// too high skips windows, and the only symptom is a handful of missing rows in a historical
// table — indistinguishable from "the chain had no events there". `base.blockscout.com` going
// unreachable showed how the opposite failure looks (a whole section quietly stops updating).
// Neither is visible on the page, so they have to be pinned here.
//
//   node scripts/test-base-log-scan.mjs
import {
  resumeFrom,
  nextScannedTo,
  scanBaseBurns,
  findDeployBlock,
  WINDOW,
  MARGIN_BLOCKS,
  FAILURE_MARGIN_WINDOWS,
  REORG_MARGIN_WINDOWS,
  BURN_TOPIC,
  BURN_RECEIVER,
} from "../lib/base-log-scan.js";

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

const DEPLOY = 46_046_062;

console.log("the burn topic is derived, not pasted");
{
  // keccak256("BurnExecuted(address,address)") — cross-checked against the live chain result
  // during development; pinned so an accidental edit to the signature string is caught.
  ok(
    "BURN_TOPIC matches the BurnExecuted signature",
    BURN_TOPIC === "0x0ae17d4615863c9cd831849f15f074aebe0227ef5a9804d6c7691e96f255378b",
    BURN_TOPIC
  );
  ok("the receiver address is the burn receiver", /^0xf9d7cbf5/.test(BURN_RECEIVER), BURN_RECEIVER);
}

console.log("\nmargin arithmetic");
{
  ok(`margin is ${FAILURE_MARGIN_WINDOWS + REORG_MARGIN_WINDOWS} windows`, MARGIN_BLOCKS === (FAILURE_MARGIN_WINDOWS + REORG_MARGIN_WINDOWS) * WINDOW, String(MARGIN_BLOCKS));
  ok("the reorg margin is at least one whole window", REORG_MARGIN_WINDOWS >= 1, "a window is the smallest re-readable unit");
}

console.log("\nresumeFrom: the conservative of two watermarks");
{
  // Cold start: nothing known -> the deploy block, never block 1.
  ok("cold start begins at the deploy block", resumeFrom({ scannedTo: null, lastBurnBlock: null, deployBlock: DEPLOY }) === DEPLOY);

  // scannedTo AHEAD of the last burn (the common case: blocks scanned, no new event).
  //
  // NOTE what this asserts: with both watermarks present, min() picks the LAST BURN, not the
  // scan cursor — because the burn is lower here. That is the intended (conservative)
  // behaviour, and it costs only the gap between the two, which is bounded by the burn rate.
  // The property that matters is not "scannedTo wins" but "the lower one wins"; the next case
  // pins the dangerous direction.
  const scannedTo = 51_900_000;
  const lastBurn = 51_737_952;
  const r1 = resumeFrom({ scannedTo, lastBurnBlock: lastBurn, deployBlock: DEPLOY });
  ok(
    "takes the lower of two watermarks (here the burn)",
    r1 === lastBurn - MARGIN_BLOCKS,
    `got ${r1}, expected ${lastBurn - MARGIN_BLOCKS} (min was ${Math.min(scannedTo, lastBurn)})`
  );
  ok("...and that is never higher than either input, so nothing is skipped", r1 <= Math.min(scannedTo, lastBurn));

  // THE DANGEROUS CASE: the last burn is AHEAD of the scan cursor, which means the previous
  // scan failed partway. Resuming from the burn would skip every block in between, and those
  // skipped blocks may hold burns. min() must pick the cursor.
  const failedCursor = 50_000_000;
  const burnAhead = 50_500_000;
  const r2 = resumeFrom({ scannedTo: failedCursor, lastBurnBlock: burnAhead, deployBlock: DEPLOY });
  ok(
    "does NOT resume past a failed scan (picks the lower watermark)",
    r2 === failedCursor - MARGIN_BLOCKS,
    `got ${r2}; resuming from the burn (${burnAhead}) would skip ${burnAhead - failedCursor} blocks`
  );
  ok("...and that resume point is below the burn, so nothing is skipped", r2 < burnAhead);

  // Never scan before the contract existed.
  ok("is clamped to the deploy block", resumeFrom({ scannedTo: DEPLOY + 100, lastBurnBlock: null, deployBlock: DEPLOY }) === DEPLOY);
  ok("a margin larger than the history still clamps", resumeFrom({ scannedTo: DEPLOY + 10, lastBurnBlock: null, deployBlock: DEPLOY, margin: 10 ** 9 }) === DEPLOY);

  // Only one watermark present -> use it. This is the upgrade path: existing base.json has
  // burns but no scannedTo, and must not restart from the deploy block every run.
  ok("works with only lastBurnBlock (no scannedTo yet)", resumeFrom({ scannedTo: null, lastBurnBlock: 51_000_000, deployBlock: DEPLOY }) === 51_000_000 - MARGIN_BLOCKS);
  ok("works with only scannedTo", resumeFrom({ scannedTo: 51_000_000, lastBurnBlock: null, deployBlock: DEPLOY }) === 51_000_000 - MARGIN_BLOCKS);

  // A zero/NaN watermark must not be mistaken for "known" and pull the scan to block 1.
  ok("ignores NaN", resumeFrom({ scannedTo: NaN, lastBurnBlock: 51_000_000, deployBlock: DEPLOY }) === 51_000_000 - MARGIN_BLOCKS);
}

console.log("\nnextScannedTo: a partial scan must not advance the watermark");
{
  ok("advances when covered", nextScannedTo({ previous: 100, to: 200, covered: true }) === 200);
  ok(
    "does NOT advance when a window failed",
    nextScannedTo({ previous: 100, to: 200, covered: false }) === 100,
    "advancing here would turn a transient failure into permanently missing history"
  );
  ok("never goes backwards", nextScannedTo({ previous: 500, to: 200, covered: true }) === 500);
  ok("treats a missing previous as 0", nextScannedTo({ previous: null, to: 200, covered: true }) === 200);
}

console.log("\nscanBaseBurns: windowing, progress, and failure reporting");
{
  const calls = [];
  const messages = [];
  const res = await scanBaseBurns({
    call: async (method, params) => {
      calls.push({ method, params });
      return [{ blockNumber: "0x1" }];
    },
    from: 1000,
    to: 1000 + WINDOW * 3 - 1,
    log: (m) => messages.push(m),
  });
  ok("tiles the range into whole windows", calls.length === 3, `${calls.length} calls`);
  ok("asks for the burn topic", calls.every((c) => c.params[0].topics?.[0] === BURN_TOPIC));
  ok("asks for the receiver address", calls.every((c) => c.params[0].address === BURN_RECEIVER));
  ok("windows are within the 2000-block cap", calls.every((c) => parseInt(c.params[0].toBlock, 16) - parseInt(c.params[0].fromBlock, 16) + 1 <= WINDOW));
  ok("reports progress", messages.some((m) => /scanning .* windows/.test(m)) && messages.some((m) => /scanned \d+\/\d+/.test(m)));
  ok("covered is true when every window answered", res.covered === true && res.failures.length === 0);

  // An empty range is covered, not failed — a quiet chain must not look like a broken one.
  const empty = await scanBaseBurns({ call: async () => [], from: 1000, to: 1000 + WINDOW - 1 });
  ok("an empty result is covered, not a failure", empty.covered === true && empty.logs.length === 0);

  // A window that throws on every attempt must be REPORTED, never silently dropped.
  let n = 0;
  const broken = await scanBaseBurns({
    call: async () => {
      n++;
      throw new Error("boom");
    },
    from: 1000,
    to: 1000 + WINDOW * 2 - 1,
  });
  ok("a failing scan is not covered", broken.covered === false);
  ok("every failed window is listed", broken.failures.length === 2, JSON.stringify(broken.failures));
  ok("it retried rather than giving up immediately", broken.retries > 0, `retries=${broken.retries}, calls=${n}`);

  // An inverted range is a no-op, not a crash.
  const inverted = await scanBaseBurns({ call: async () => [], from: 5000, to: 1000 });
  ok("an inverted range is a no-op", inverted.logs.length === 0 && inverted.windows === 0);
}

console.log("\nfindDeployBlock: locate the floor without scanning");
{
  // Code appears at 500.
  const seen = [];
  const call = async (method, params) => {
    const b = parseInt(params[1], 16);
    seen.push(b);
    if (method !== "eth_getCode") throw new Error("unexpected method " + method);
    return b >= 500 ? "0x6080" : "0x";
  };
  const found = await findDeployBlock(call, BURN_RECEIVER, { low: 1, high: 1000 });
  ok("finds the exact first block with code", found === 500, `got ${found}`);
  ok("uses far fewer probes than a scan", seen.length < 30, `${seen.length} probes`);

  // Never deployed -> null, so a wrong address fails loudly instead of yielding "no events".
  const never = await findDeployBlock(async () => "0x", BURN_RECEIVER, { low: 1, high: 1000 });
  ok("returns null when the address never has code", never === null);

  // Deployed at or before `low`.
  const atLow = await findDeployBlock(async () => "0x6080", BURN_RECEIVER, { low: 1, high: 1000 });
  ok("handles 'already deployed at low'", atLow === 1, `got ${atLow}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
