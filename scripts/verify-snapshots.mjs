// Validate freshly generated snapshots before they replace the ones the site serves.
//
// The refresh job runs unattended against public RPC endpoints that answer wrongly rather
// than failing (NOTES.md §16: a 6-orders-of-magnitude disagreement). Writing straight to
// data/ means one bad hour silently ships an empty timeline. So every artifact gets two
// kinds of check:
//
//   shape   — parses, has the fields the page reads, values are in a plausible range
//   journey — did not go backwards: fewer events than before, an older head block, a
//             message list that suddenly lost half its entries
//
// `journey` is the one that catches a truncated fetch, which is the most likely failure
// in practice. It needs the previous copy of the file, so pass --prev.
//
//   node scripts/verify-snapshots.mjs [--dir data] [--prev data] [--json]
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sanityCheckDerived } from "../lib/contracts.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const DIR = resolve(ROOT, argOf("--dir", "data"));
const PREV_DIR = resolve(ROOT, argOf("--prev", "data"));
const AS_JSON = process.argv.includes("--json");

const isIso = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));
const isBlock = (v) => Number.isFinite(Number(v)) && Number(v) > 1_000_000;
const count = (arr) => (Array.isArray(arr) ? arr.length : 0);

/** Slow-moving history must not shrink. A big drop means a truncated scan, not a burn. */
const noShrink = (label, prevN, nextN, tolerance = 1) => [
  `${label} did not shrink (${prevN} → ${nextN})`,
  nextN >= Math.floor(prevN * tolerance),
];
const noBackwards = (label, prevN, nextN) => [`${label} did not go backwards (${prevN} → ${nextN})`, Number(nextN) >= Number(prevN)];

const SNAPSHOTS = [
  {
    file: "timeline.json",
    shape: (j) => [
      ["trims is a non-empty array", count(j.trims) > 0],
      ["every trim carries a block, a time and its amounts", j.trims.every((t) => Number.isFinite(t.b) && Number.isFinite(t.t) && t.burned !== undefined && t.rewarded !== undefined)],
      ["last.* mirrors a real event", !!(j.last && j.last.Trimmed)],
      ["scannedTo is a block number", isBlock(j.scannedTo)],
      ["builtAt is a timestamp", isIso(j.builtAt)],
    ],
    journey: (prev, next) => [
      noShrink("trim count", count(prev.trims), count(next.trims)),
      noBackwards("scannedTo", prev.scannedTo || 0, next.scannedTo || 0),
    ],
  },
  {
    file: "base.json",
    shape: (j) => [
      ["burns and bridges are non-empty arrays", count(j.burns) > 0 && count(j.bridges) > 0],
      ["every burn/bridge carries a block and a time", [...(j.burns || []), ...(j.bridges || [])].every((e) => Number.isFinite(e.b) && Number.isFinite(e.t))],
      ["builtAt is a timestamp", isIso(j.builtAt)],
    ],
    journey: (prev, next) => [
      noShrink("burn count", count(prev.burns), count(next.burns)),
      noShrink("bridge count", count(prev.bridges), count(next.bridges)),
    ],
  },
  {
    file: "volume.json",
    shape: (j) => [
      ["both pools are present", Array.isArray(j.pools) && j.pools.some((p) => p.label === "A") && j.pools.some((p) => p.label === "B")],
      ["the scan window is a sane number of hours", Number(j.hours) > 0 && Number(j.hours) <= 168],
      ["the scan actually saw swaps", Number(j.totalSwaps) > 0 && Number(j.chainWideSwaps) > 0],
      ["every swap count is a non-negative integer", j.pools.every((p) => Number.isInteger(p.swaps) && p.swaps >= 0)],
      ["scannedAt is a timestamp", isIso(j.scannedAt)],
    ],
    journey: (prev, next) => [
      noBackwards("scannedAt", Date.parse(prev.scannedAt || 0), Date.parse(next.scannedAt || 0)),
      noBackwards("toBlock", prev.toBlock || 0, next.toBlock || 0),
      // RPC failures inside the scanner produce a structurally valid but empty window —
      // this is the check that catches it (it did: an endpoint-only run once slipped
      // through with zero swaps).
      noShrink("swap count", Number(prev.totalSwaps) || 0, Number(next.totalSwaps) || 0, 0.2),
    ],
  },
  {
    file: "messages.json",
    shape: (j) => [
      ["the message list is substantial", count(j.messages) >= 50],
      ["counts are consistent with the list", Number(j.counts?.decoded) === count(j.messages)],
      ["every message has a block, a time and text", j.messages.every((m) => Number.isFinite(m.block) && Number.isFinite(m.ts) && typeof m.text === "string")],
      ["fetchedAt is a timestamp", isIso(j.fetchedAt)],
    ],
    journey: (prev, next) => [
      // Deletions never happen on-chain, so a drop of more than 20% is a failed fetch.
      noShrink("message count", count(prev.messages), count(next.messages), 0.8),
    ],
  },
  {
    file: "bridge-history.json",
    shape: (j) => [
      ["six sample points", count(j.points) === 6],
      ["every point has a parseable wei value", j.points.every((p) => { try { return BigInt(p.value) >= 0n; } catch { return false; } })],
      ["now parses as wei", (() => { try { return BigInt(j.now) > 0n; } catch { return false; } })()],
      ["headBlock is a block number", isBlock(j.headBlock)],
      ["fetchedAt is a timestamp", isIso(j.fetchedAt)],
    ],
    journey: (prev, next) => [noBackwards("headBlock", prev.headBlock || 0, next.headBlock || 0)],
  },
  {
    file: "baseline.json",
    shape: (j) => [
      ["blockNumber is a block number", isBlock(j.blockNumber)],
      ["derived is present", !!j.derived],
      // The magnitude checks that would have caught daysOfBuffer and ethInPoolUsd.
      ...(() => {
        const issues = j.derived ? sanityCheckDerived(j.derived) : [];
        return [["derived quantities are physically plausible", issues.length === 0, issues.map((i) => `${i.field}: ${i.message}`).join("; ")]];
      })(),
    ],
    journey: () => [],
  },
];

// baseline.json is the offline cross-check artefact: its block must never go backwards
// either, and its units are checked by sanityCheckDerived above.
SNAPSHOTS[SNAPSHOTS.length - 1].journey = (prev, next) => [noBackwards("blockNumber", prev.blockNumber || 0, next.blockNumber || 0)];

const load = (dir, file) => {
  const p = `${dir}/${file}`;
  if (!existsSync(p)) return { missing: true, path: p };
  try {
    return { json: JSON.parse(readFileSync(p, "utf8")), path: p };
  } catch (e) {
    return { parseError: e.message, path: p };
  }
};

const results = [];
for (const spec of SNAPSHOTS) {
  const next = load(DIR, spec.file);
  const prev = load(PREV_DIR, spec.file);
  const failures = [];

  // A partial refresh (--only) legitimately leaves some snapshots untouched. Those are
  // "not this run's business", not failures — the refresh driver already fails fast when
  // a generator that was supposed to run produced nothing.
  if (next.missing && !prev.missing) {
    results.push({ file: spec.file, ok: true, skipped: true, failures: [], checked: next.path });
    continue;
  }

  if (next.missing) failures.push("file was not produced and no previous copy exists");
  else if (next.parseError) failures.push(`not valid JSON: ${next.parseError}`);
  else {
    for (const [label, ok, detail] of spec.shape(next.json)) if (!ok) failures.push(detail ? `${label} — ${detail}` : label);
    if (!prev.missing && !prev.parseError && prev.path !== next.path) {
      for (const [label, ok] of spec.journey(prev.json, next.json)) if (!ok) failures.push(label);
    }
  }

  results.push({ file: spec.file, ok: failures.length === 0, failures, checked: next.path });
}

if (AS_JSON) {
  console.log(JSON.stringify({ dir: DIR, prev: PREV_DIR, results }, null, 2));
} else {
  console.log(`verifying snapshots in ${DIR}${DIR === PREV_DIR ? "" : ` (against ${PREV_DIR})`}`);
  for (const r of results) {
    if (r.skipped) console.log(`  --   ${r.file} (not refreshed this run)`);
    else if (r.ok) console.log(`  ok   ${r.file}`);
    else {
      console.log(`  FAIL ${r.file}`);
      for (const f of r.failures) console.log(`         ${f}`);
    }
  }
}

const bad = results.filter((r) => !r.ok);
const checked = results.filter((r) => !r.skipped);
console.log(`\n${checked.length - bad.length} of ${checked.length} refreshed snapshots valid`);
process.exit(bad.length ? 1 : 0);
