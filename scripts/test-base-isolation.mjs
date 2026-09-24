// When the Base half of build-data.mjs fails, the L1 half must still ship.
//
// The outage this exists for: refresh-snapshots.mjs ran, index-logs.mjs built a fresh
// history.json into the staging directory, build-data.mjs built timeline.json, and then the
// Base section threw — Blockscout was unreachable, `fetch failed`. That exception left the
// process, so timeline.json was thrown away with it even though it was complete and would
// have passed verification. data/ stayed frozen at its 09:44 state and the page spent six
// hours reporting a burn that was 25 minutes old as "7.0 hours ago".
//
// refresh-snapshots.mjs already had the right instinct — base.json is listed in
// `optionalOutputs`, with the note "the published copy stays in place". A generator that
// dies never lets that path run.
//
//   node scripts/test-base-isolation.mjs
//
// Following HANDOFF #13, the assertion is also shown to fail on the old behaviour: the same
// command with the isolation disabled (POOL4_BASE_ISOLATION=0, the code path as it was) must
// produce no timeline.json and a non-zero exit. A check that cannot fail is not a check.
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = "data/_fixture-base.json";

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

/**
 * Break the Base half from inside the Base section.
 *
 * POOL4_BASE_FAIL=1 makes build-data.mjs throw after the timeline has been built and written —
 * the same position in the run as the real failure, and the place the try/catch can see. The
 * alternative (pointing POOL4_BASE_FIXTURE at a missing file) throws at module scope, before
 * timeline.json exists at all, so it cannot distinguish the two behaviours.
 */
const runBuildData = (outDir, env) =>
  spawnSync(process.execPath, [join(ROOT, "scripts", "build-data.mjs"), "--out-dir", outDir], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 180_000,
    env: { ...process.env, POOL4_BASE_FAIL: "1", ...env },
  });

const tmp = mkdtempSync(join(tmpdir(), "pool4-basefail-"));
try {
  console.log("the Base section fails while the L1 half is already built");
  const r = runBuildData(tmp, {});

  ok("exits 0 — the surviving half is still a success", r.status === 0, `exit ${r.status}\n${(r.stderr || "").slice(0, 400)}`);

  const tlPath = join(tmp, "timeline.json");
  ok("timeline.json was still written", existsSync(tlPath), `no file at ${tlPath}`);

  if (existsSync(tlPath)) {
    const timeline = JSON.parse(readFileSync(tlPath, "utf8"));
    ok("timeline.json is complete, not truncated", Array.isArray(timeline.trims) && timeline.trims.length > 0, `${timeline.trims?.length} trims`);
    ok(
      "timeline.json carries resolved block timestamps",
      timeline.trims.every((t) => Number.isFinite(t.t)),
      `${timeline.trims.filter((t) => !Number.isFinite(t.t)).length} without a timestamp`
    );
    ok("timeline.json is stamped so the freshness check can see it", Number.isFinite(Date.parse(timeline.builtAt)), String(timeline.builtAt));
  }

  ok("base.json was NOT written (no half-built file for promote to pick up)", !existsSync(join(tmp, "base.json")));

  const stderr = r.stderr || "";
  ok("the failure is reported, loudly, on stderr", /base\.json was NOT built/.test(stderr), stderr.slice(0, 300));
  ok("the message says the published copy stays in place", /keeps its previous contents/.test(stderr), stderr.slice(0, 400));
  ok("the message explains the banner will rise", /staleness banner/.test(stderr), stderr.slice(0, 400));

  /* The counter-check. `timeline.json` is written before the Base section runs, so the old
   * behaviour left the file on disk — the loss happened one level up: the step exited non-zero,
   * refresh-snapshots.mjs called fail() and abandoned the entire staging directory, timeline
   * included. So the counter-check drives the real job, and asks the question that matters:
   * after a Base failure, does the timeline reach data/? */
  console.log("\nthe counter-check: with the isolation off, the run must abandon the timeline completely");
  const oldTmp = mkdtempSync(join(tmpdir(), "pool4-basefail-old-"));
  const r2 = runBuildData(oldTmp, { POOL4_BASE_ISOLATION: "0" });
  ok("build-data exits non-zero without the isolation", r2.status !== 0, `exit ${r2.status}`);
  ok(
    "and says base.json was NOT built is absent — nothing was contained",
    !/base\.json was NOT built/.test(r2.stderr || ""),
    "the isolate message appeared even though the isolation is off"
  );

  /* The end-to-end counter-check: the refresh job, with the timeline step failing and
   * base.json becoming optional.
   *
   * `--only index,timeline` is deliberate. build-data.mjs consumes the history.json that
   * index-logs.mjs writes into the same staging directory, so a run that skips the index
   * makes build-data fall back to the committed cold-start index (stagedPath) and the verify
   * step then — correctly — rejects the older timeline as "history went backwards". That is
   * HANDOFF #15, and it is a property of the step list, not of this fix. */
  console.log("\nend to end: the refresh job's data/ must move forward over a Base failure");
  const dataDir = join(ROOT, "data");
  const before = JSON.parse(readFileSync(join(dataDir, "timeline.json"), "utf8"));
  const job = spawnSync(
    process.execPath,
    [join(ROOT, "scripts", "refresh-snapshots.mjs"), "--only", "index,timeline", "--no-retry"],
    { cwd: ROOT, encoding: "utf8", timeout: 300_000, env: { ...process.env, POOL4_BASE_FAIL: "1" } }
  );
  ok("the refresh job exits 0 when only the optional half failed", job.status === 0, `exit ${job.status}\n${(job.stdout || "").slice(-600)}`);
  ok("the job reports that base.json was not produced", /base\.json was not produced this run/.test(job.stdout || ""), (job.stdout || "").slice(-600));
  const after = JSON.parse(readFileSync(join(dataDir, "timeline.json"), "utf8"));
  ok(
    `data/timeline.json actually advanced (${before.scannedTo} → ${after.scannedTo})`,
    Number(after.scannedTo) > Number(before.scannedTo),
    `scannedTo ${before.scannedTo} → ${after.scannedTo}, builtAt ${before.builtAt} → ${after.builtAt}`
  );
  rmSync(oldTmp, { recursive: true, force: true });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
await new Promise((resolve) => process.stdout.write("", resolve));
process.exit(fail === 0 ? 0 : 1);
