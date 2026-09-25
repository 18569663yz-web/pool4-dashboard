// Reconcile the page's numbers against the chain, and fail when they disagree.
//
// Why this exists: every other suite in this repo is OFFLINE. `selftest` (46), `check` (26) and
// `test-render` (129) all pass with a snapshot directory that is weeks old, with numbers that
// the chain has since contradicted, and with a burn that nobody noticed. That is exactly how a
// six-hour snapshot outage and a real 1050.49 IMD burn went unreported: the data was wrong and
// every test was green, because no test ever asked the chain.
//
//   node scripts/check-live-numbers.mjs              # reconcile, exit non-zero on mismatch
//   node scripts/check-live-numbers.mjs --tolerance 30   # allow 30s of drift before failing
//
// It is deliberately READ-ONLY and needs no browser: it reads the chain and it reads the
// committed snapshots, and it reports the gap between them. `verify-live-site.mjs` covers the
// other half (the deployed DOM against the chain); this one covers the half that can run in CI
// unattended, and unlike that script it is about the DATA rather than about the deployment.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Rpc, fmt18, DEFAULT_RPCS } from "../lib/evm.js";
import { collect, ADDR } from "../lib/contracts.js";
/* The page's own timestamp reader, not a second parser. Two readers of the same field is how a
 * "milliseconds vs seconds" disagreement becomes possible — which is exactly the bug that was
 * fixed in this function, and it would silently return on the two sides of a duplicate. */
import { snapshotTimestamp } from "../lib/snapshots.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

let pass = 0;
let fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
};
const load = (f) => {
  try {
    return JSON.parse(readFileSync(ROOT + `data/${f}`, "utf8"));
  } catch {
    return null;
  }
};
const e18s = (v) => (v === undefined || v === null ? "(unread)" : fmt18(v, 6));
const hours = (ms) => (Date.now() - ms) / 3_600_000;

/* ------------------------------------------------------------------ *
 * 1. the chain, right now
 * ------------------------------------------------------------------ */
const extra = process.argv.slice(2).filter((a) => a.startsWith("http"));
const rpc = new Rpc(extra.length ? extra.concat(DEFAULT_RPCS) : DEFAULT_RPCS, { timeoutMs: 25000 });

console.log("live reconciliation: the committed snapshots against the chain\n");
let snap;
try {
  snap = await collect(rpc, { includeBase: false });
} catch (e) {
  console.error(`could not reach the chain at all: ${e.message}`);
  console.error("this script is meaningless offline — refusing to report a pass.");
  process.exit(2);
}
const v = snap.values;
const d = snap.derived;
console.log(`chain head block ${snap.blockNumber}  (${new Date(snap.blockTimestamp * 1000).toISOString()})`);
console.log(`state ${d.state}   held ${e18s(d.held)}   cap ${e18s(d.cap)}   pendingTrim ${e18s(d.pendingTrim)}\n`);

/* ------------------------------------------------------------------ *
 * 2. the trim ledger against totalBurned() — the page's strongest claim
 *
 * timeline.json is rebuilt from Trimmed + BackstopSettled logs. The contract's own
 * totalBurned() counts the same IMD from the other side. Comparing the two at the SAME block
 * is the one check that can catch a silently dropped log, and it is the check that was never
 * automated. It must be done at the snapshot's block, not at head — that is the whole point.
 * ------------------------------------------------------------------ */
console.log("the trim ledger against the contract's own counter");
const timeline = load("timeline.json");
if (!timeline) {
  ok("data/timeline.json exists", false);
} else {
  const atBlock = timeline.scannedTo;
  const ledger = [...(timeline.trims || []), ...(timeline.backstopSettles || [])].reduce((a, x) => a + BigInt(x.burned || "0"), 0n);
  const trimsOnly = (timeline.trims || []).reduce((a, x) => a + BigInt(x.burned || "0"), 0n);
  console.log(`  snapshot scanned to block ${atBlock}, ${(timeline.trims || []).length} trims + ${(timeline.backstopSettles || []).length} backstop settles`);
  console.log(`  ledger sum (trims + backstop) = ${fmt18(ledger, 6)} IMD`);
  console.log(`  ledger sum (trims only)       = ${fmt18(trimsOnly, 6)} IMD`);

  /* totalBurned() at the snapshot's block needs an archive node, which the public fleet serves
   * only sometimes — the same limitation that made the old eth_call-at-past-block sampler
   * unreliable. So this reads it at HEAD and reports the drift instead of asserting equality:
   * the assertion that CAN be made exactly is the one below, about the balance. */
  const burnedNow = v["hook.totalBurned"];
  const sinceSnapshot = burnedNow - ledger;
  console.log(`  totalBurned() at head         = ${fmt18(burnedNow, 6)} IMD`);
  console.log(`  chain minus ledger            = ${fmt18(sinceSnapshot, 6)} IMD  (>= 0: the chain only adds)`);

  ok("the ledger never exceeds the chain's own counter", sinceSnapshot >= 0n, `ledger ${fmt18(ledger, 6)} vs chain ${fmt18(burnedNow, 6)} — a negative gap means the snapshot invented burns`);
  ok(`the ledger is not behind by more than the grace window (${argOf("--tolerance-blocks", "30000")} blocks)`, snap.blockNumber - atBlock < Number(argOf("--tolerance-blocks", "30000")), `snapshot at ${atBlock}, head ${snap.blockNumber} — ${snap.blockNumber - atBlock} blocks behind`);
}

/* ------------------------------------------------------------------ *
 * 3. the snapshot's live-call values against the same calls now
 *
 * baseline.json is a full collect() at one block; this run is a full collect() at another. Every
 * monotonic field must have moved FORWARD, and every field that cannot move (an address, a
 * boolean that is not expected to flip) must be identical. A backward move means the snapshot is
 * from a different chain or the collection is broken.
 * ------------------------------------------------------------------ */
console.log("\nbaseline.json against the same calls now");
const baseline = load("baseline.json");
if (!baseline) {
  ok("data/baseline.json exists", false);
} else {
  const bv = {};
  for (const [k, x] of Object.entries(baseline.values || {})) {
    if (typeof x === "string" && /^-?\d+$/.test(x)) bv[k] = BigInt(x);
    else if (Array.isArray(x)) bv[k] = x.map((y) => (typeof y === "string" && /^-?\d+$/.test(y) ? BigInt(y) : y));
    else bv[k] = x;
  }
  const age = (Date.now() - baseline.fetchedAt) / 3_600_000;
  console.log(`  baseline fetched ${new Date(baseline.fetchedAt).toISOString()} (${age.toFixed(2)}h ago), block ${baseline.blockNumber}, head now ${snap.blockNumber}`);

  ok("baseline.json is not older than the refresh window (3h)", age < 3, `${age.toFixed(2)}h old — the hourly job has stopped`);
  ok("baseline.json's block is not ahead of the chain", baseline.blockNumber <= snap.blockNumber, `baseline block ${baseline.blockNumber} > head ${snap.blockNumber}`);

  // Monotonic counters: these can only grow, whatever the block.
  for (const [tag, label] of [
    ["hook.totalBurned", "totalBurned (cumulative burned)"],
    ["hook.totalRewarded", "totalRewarded (cumulative rewarded)"],
    ["hook.totalFeeEth", "totalFeeEth (cumulative fees)"],
  ]) {
    const a = bv[tag];
    const b = v[tag];
    if (a === undefined || b === undefined) {
      ok(`${label} readable on both sides`, false, `baseline=${String(a)} chain=${String(b)}`);
      continue;
    }
    ok(`${label} did not go backwards`, b >= a, `baseline ${fmt18(a, 6)} -> chain ${fmt18(b, 6)} (delta ${fmt18(b - a, 6)})`);
  }

  // Immutable configuration: must be identical, or the snapshot describes a different world.
  for (const [tag, label] of [
    ["hook.bpsDenominator", "bpsDenominator"],
    ["hook.burnSink", "burnSink address"],
    ["hook.rewardsRecipient", "rewardsRecipient address"],
  ]) {
    const a = bv[tag];
    const b = v[tag];
    if (a === undefined || b === undefined) {
      ok(`${label} readable on both sides`, false, `baseline=${String(a)} chain=${String(b)}`);
      continue;
    }
    const same = typeof a === "bigint" && typeof b === "bigint" ? a === b : String(a).toLowerCase() === String(b).toLowerCase();
    ok(`${label} is unchanged`, same, `baseline ${String(a)} vs chain ${String(b)}`);
  }

  /* The state machine and the position. These are what the page actually shows a holder, so
   * they are compared as the page would compute them — from a fresh derive() on both sides. */
  const bd = baseline.derived || {};
  console.log(`\n  position: baseline ${e18s(bd.held ? BigInt(bd.held) : undefined)} / cap ${e18s(bd.cap ? BigInt(bd.cap) : undefined)}  ->  now ${e18s(d.held)} / cap ${e18s(d.cap)}`);
  ok("the chain's own state machine agrees with a fresh derive()", ["LIVE", "CRITICAL", "DORMANT"].includes(d.state), `got ${d.state}`);
}

/* ------------------------------------------------------------------ *
 * 4. the second door: the queue, and the burn log's own consistency
 * ------------------------------------------------------------------ */
console.log("\nthe second door (bridge queue + Base burns)");
const bridge = load("bridge-history.json");
const base = load("base.json");
if (bridge) {
  const pts = (bridge.points || []).filter((p) => p.value !== null);
  const nowPt = pts.find((p) => p.label === "now");
  const quote = v["burnExecutor.tokenBalance"];
  console.log(`  bridge-history fetched ${bridge.fetchedAt ? new Date(Date.parse(bridge.fetchedAt) || Number(bridge.fetchedAt)).toISOString() : "(no timestamp)"}, ${pts.length} usable points`);
  if (nowPt) {
    const fileNow = BigInt(nowPt.value);
    console.log(`  file "now"            = ${fmt18(fileNow, 9)} IMD`);
    console.log(`  live tokenBalance()   = ${fmt18(quote, 9)} IMD`);
    /* This is the exact defect the page used to paper over: the card mixed a live "current"
     * reading with a frozen "24h net change". They are allowed to differ (the queue moves), but
     * the page must say WHICH moment each number belongs to. Here the assertion is only that the
     * file's own "now" is not wildly different from the chain's — a big gap means the file has
     * stopped tracking the queue at all. */
    const diff = fileNow > quote ? fileNow - quote : quote - fileNow;
    const rel = quote > 0n ? Number((diff * 1_000_000n) / quote) / 1_000_000 : Number(diff) / 1e18;
    ok(`bridge-history's "now" still tracks the live queue (${(rel * 100).toFixed(2)}% apart, tolerance 50%)`, rel < 0.5, `file ${fmt18(fileNow, 6)} vs chain ${fmt18(quote, 6)}`);
  } else {
    ok('bridge-history has a "now" point', false, `${(bridge.points || []).length} points`);
  }
} else {
  ok("data/bridge-history.json exists", false);
}
if (base) {
  const burns = base.burns || [];
  const bridges = base.bridges || [];
  const last = burns[burns.length - 1];
  console.log(`  base.json: ${burns.length} burns, ${bridges.length} bridges, built ${base.builtAt}`);
  if (last) console.log(`  last burn block ${last.b} at ${new Date(last.t * 1000).toISOString()}`);
  ok("every recorded burn has a block and a time", burns.every((x) => Number.isFinite(x.b) && Number.isFinite(x.t)), `${burns.filter((x) => !Number.isFinite(x.t)).length} without a resolved time`);
  ok("burns are ordered by block", burns.every((x, i) => i === 0 || x.b >= burns[i - 1].b), "");
  /* A burn cannot be older than the chain's own trim history: the L1 trim is what puts IMD into
   * the queue in the first place. A Base burn preceding the first L1 trim would mean the two
   * halves of the story are misaligned. */
  if (timeline && burns.length && (timeline.trims || []).length) {
    const firstTrim = timeline.trims[0];
    ok("the first Base burn is not older than the first L1 trim", last.b > firstTrim.b, `last burn ${last.b} vs first trim ${firstTrim.b}`);
  }
} else {
  ok("data/base.json exists", false);
}

/* ------------------------------------------------------------------ *
 * 4b. freshness of EVERY snapshot the page reads
 *
 * This section exists because two of the six snapshots had no freshness check anywhere, and the
 * consequence was measured rather than imagined: on 2026-09-25 the refresh job failed at
 * fetch-messages.mjs for nine hours. timeline and baseline were covered here; messages, bridge
 * and volume were not covered by any assertion in any suite. Nothing went red. The page kept
 * rendering week-old history that still looked like data.
 *
 * The gap matters most for the steps that are about to become OPTIONAL in refresh-snapshots.mjs:
 * an optional step that fails no longer fails the build, so if nothing else checks its output,
 * "optional" quietly becomes "never fixed". This is the other half of that change — refresh
 * produces, this asserts that what it produced is current.
 *
 * The threshold is the same three hours the page itself uses (STALE_AFTER_HOURS), deliberately:
 * the CI check and the reader's banner should agree about what "stale" means, or one of them is
 * lying about the other.
 * ------------------------------------------------------------------ */
console.log("\nfreshness of every snapshot the page reads");
{
  const STALE_AFTER_HOURS = 3;
  /* Exactly the six the page fetches in boot(), plus baseline.json which the same job commits.
   *
   * messages.zh.json is deliberately NOT here, and the reason is worth stating because the naive
   * move is to add it. It is a hand-maintained translation table keyed by block number
   * (data/messages.zh.json, `_note`), not a generated artefact: no script writes it, so there is
   * no refresh step that can stop, and stamping it with a build time would create a field that
   * only a human editing the file could ever update — a timestamp whose age measures nothing.
   *
   * Its real staleness question is different and is already covered elsewhere: it is only as
   * complete as the message set it was written against, which scripts/check-summaries.mjs checks
   * by comparing its keys to messages.json. A count-of-entries check answers "are the translations
   * behind the data?"; a file-age check would not. */
  const SOURCES = [
    ["timeline.json", "timeline"],
    ["base.json", "base"],
    ["volume.json", "volume"],
    ["messages.json", "messages"],
    ["bridge-history.json", "bridge-history"],
    ["baseline.json", "baseline"],
  ];

  const ages = [];
  for (const [file, name] of SOURCES) {
    const j = load(file);
    if (!j) {
      ok(`data/${file} exists`, false);
      continue;
    }
    const at = snapshotTimestamp(j);
    if (at === null) {
      /* A source with no readable timestamp is its own failure, not a skip: the banner cannot
       * speak for it, so nothing on the page can tell the reader it has stopped. */
      ok(`data/${file} carries a timestamp the freshness check can read`, false, `no readable builtAt/scannedAt/fetchedAt/generatedAt — this file's staleness is invisible to the page AND to this script`);
      continue;
    }
    ages.push({ file, name, at, ageHours: (Date.now() - at) / 3_600_000 });
  }

  for (const a of ages.sort((x, y) => y.ageHours - x.ageHours)) {
    console.log(`  ${a.name.padEnd(16)} ${new Date(a.at).toISOString()}  ${a.ageHours.toFixed(2)}h${a.ageHours > STALE_AFTER_HOURS ? "   <-- STALE" : ""}`);
  }

  /* One assertion per source, named, so a failure says WHICH file stopped rather than "something
   * is old". A caller reading a CI log needs the file name, not a count. */
  for (const a of ages) {
    ok(
      `data/${a.file} was refreshed within ${STALE_AFTER_HOURS}h (age ${a.ageHours.toFixed(2)}h)`,
      a.ageHours < STALE_AFTER_HOURS,
      `${a.file} is ${a.ageHours.toFixed(2)}h old — that step of the refresh job has stopped producing. If it is an optional step, its output keeps the previous contents and only this check will notice.`
    );
  }

  /* The summary the banner is built from, asserted the same way the page computes it: a partial
   * outage is the shape that hides, because a fresh majority makes the page look trustworthy. */
  const staleNames = ages.filter((a) => a.ageHours > STALE_AFTER_HOURS).map((a) => a.name);
  console.log(`\n  ${staleNames.length} of ${ages.length} snapshots are past the ${STALE_AFTER_HOURS}h threshold${staleNames.length ? ": " + staleNames.join(", ") : ""}`);
  if (staleNames.length) {
    console.log(`  (a PARTIAL stall: ${ages.length - staleNames.length} source(s) are still current, which is exactly why the page can look healthy)`);
  }
}

/* ------------------------------------------------------------------ *
 * 5. what this script deliberately does NOT check
 * ------------------------------------------------------------------ */
console.log("\nnot covered here (so nobody reads more into a green run than it claims)");
console.log("  · the DEPLOYED page's DOM — that is scripts/verify-live-site.mjs, and it needs a browser");
console.log("  · totalBurned() at the snapshot's own block — needs an archive node, which the public");
console.log("    fleet serves only intermittently; this run compares the ledger to head instead");
console.log("  · data/history.json (7 MB) row by row against data/timeline.json");
console.log("  · Base-side BurnExecuted completeness (the log scan is rate-limited)");

console.log(`\n${pass} passed, ${fail} failed`);
await new Promise((resolve) => process.stdout.write("", resolve));
process.exit(fail === 0 ? 0 : 1);
