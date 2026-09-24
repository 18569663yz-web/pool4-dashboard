// Which history.json build-data.mjs reads.
//
// The refresh job runs its generators in sequence into ONE staging directory: index-logs.mjs
// writes history.json there, then build-data.mjs turns it into timeline.json. build-data.mjs
// used to read the committed data/history.json instead.
//
// The workflow deliberately never commits that 7 MB file — actions/cache carries it between
// runs — so the committed copy is a cold-start baseline that stands still. Every scheduled
// run therefore rebuilt the timeline from the same frozen index and reported the same block
// number, and verify-snapshots.mjs rejected it, correctly, as history going backwards. Three
// consecutive runs failed on byte-identical numbers (26044665, 256 trims), and that
// repetition is what gave the path away: a live endpoint cannot report the same head an hour
// apart, while the other snapshots in the same run — which do not read the index — passed
// their own "did not go backwards" checks against a head of 26046189.
//
//   node scripts/test-staged-input.mjs
//
// Following HANDOFF #13, the assertion is also shown to fail on the old behaviour: the same
// command pointed at an empty directory falls back to the committed index and yields a
// different block number. A check that cannot fail is not a check.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = "data/_fixture-base.json";
const COMMITTED = join(ROOT, "data", "history.json");

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

if (!existsSync(join(ROOT, FIXTURE))) {
  console.error(`missing ${FIXTURE} — run: node scripts/make-base-fixture.mjs`);
  process.exit(1);
}

const runBuildData = (outDir) =>
  spawnSync(
    process.execPath,
    [join(ROOT, "scripts", "build-data.mjs"), "--base-fixture", FIXTURE, "--out-dir", outDir],
    { cwd: ROOT, encoding: "utf8", timeout: 120_000 }
  );

const committed = JSON.parse(readFileSync(COMMITTED, "utf8"));
/* A head that is unmistakably not the committed one, so "which file did it read?" is a
 * question the output itself can answer. */
const STAGED_HEAD = Number(committed.head) + 5000;

const staged = mkdtempSync(join(tmpdir(), "pool4-staged-"));
const empty = mkdtempSync(join(tmpdir(), "pool4-empty-"));
try {
  writeFileSync(
    join(staged, "history.json"),
    JSON.stringify({ ...committed, head: STAGED_HEAD, scanTo: STAGED_HEAD })
  );

  console.log("build-data.mjs reads the index this run produced");
  const r = runBuildData(staged);
  ok("exits 0", r.status === 0, `exit ${r.status}\n${(r.stderr || "").split("\n").slice(0, 3).join("\n")}`);

  const timeline = JSON.parse(readFileSync(join(staged, "timeline.json"), "utf8"));
  ok(
    `timeline.scannedTo came from the staged index (${STAGED_HEAD}, not the committed ${committed.head})`,
    Number(timeline.scannedTo) === STAGED_HEAD,
    `got ${timeline.scannedTo} — build-data read the committed data/history.json`
  );
  ok(
    "the run says which index it read",
    (r.stdout || "").includes("history.json") && (r.stdout || "").includes(String(STAGED_HEAD)),
    "expected the 'index: <path>' and 'scanTo N' lines in stdout"
  );
  ok(
    "the rest of the timeline still comes from that index",
    Number(timeline.scannedFrom) === Number(committed.scanFrom) &&
      Array.isArray(timeline.trims) &&
      timeline.trims.length > 0,
    `scannedFrom ${timeline.scannedFrom}, ${timeline.trims?.length} trims`
  );

  /* The counter-check. An output directory with no history.json in it is exactly the old
   * behaviour — read the committed file. If this produced STAGED_HEAD as well, the
   * assertion above would pass no matter which path the code took. */
  console.log("\nthe counter-check: with no staged index it must fall back, and answer differently");
  const r2 = runBuildData(empty);
  ok("exits 0 with no staged index", r2.status === 0, `exit ${r2.status}`);
  const t2 = JSON.parse(readFileSync(join(empty, "timeline.json"), "utf8"));
  ok(
    `fallback reads the committed index (${committed.head})`,
    Number(t2.scannedTo) === Number(committed.head),
    `got ${t2.scannedTo}`
  );
  ok(
    "the two answers differ, so the assertion above can fail",
    Number(t2.scannedTo) !== Number(timeline.scannedTo),
    "the staged and committed heads are indistinguishable — the test proves nothing"
  );
  ok(
    "the fallback warns instead of doing it silently",
    /falling back to/.test(r2.stderr || ""),
    "expected a note on stderr"
  );
} finally {
  rmSync(staged, { recursive: true, force: true });
  rmSync(empty, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
