// Run build-data.mjs end to end against the offline fixture.
//
// The bug this exists for: the summary referenced `bridgeBlocks`, declared inside the Base
// section, so every run that did NOT pass --skip-base died with a ReferenceError on CI —
// while every local run passed --skip-base (Blockscout times out under node here) and
// therefore never executed the line. "It works locally" was true and useless.
//
// With --base-fixture, the Base section runs with no network at all, so the whole script —
// including its last lines — is exercised on a machine that cannot reach Base's explorer.
//
//   node scripts/test-build-data.mjs
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

const runBuildData = (args, outDir) =>
  spawnSync(process.execPath, [join(ROOT, "scripts", "build-data.mjs"), ...args, "--out-dir", outDir], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
  });

if (!existsSync(join(ROOT, FIXTURE))) {
  console.error(`missing ${FIXTURE} — run: node scripts/make-base-fixture.mjs`);
  process.exit(1);
}
const fixture = JSON.parse(readFileSync(join(ROOT, FIXTURE), "utf8"));

/* ------------------------------------------------------------------ *
 * Is the fixture stale, or is it WRONG?
 *
 * This check used to be a single assertion — "the fixture has a timestamp for every event
 * block in history.json" — and it failed on its own once an hour. It was measuring two
 * different things at once, and they need opposite treatment:
 *
 *   L1 — a block at or below the fixture's own head (`l1Head`) with no timestamp in it.
 *        The fixture was built when that block already existed, so this is a defect in the
 *        fixture *generator*: `make-base-fixture.mjs` computes the set of blocks it needs and
 *        asks the chain for exactly those, so a block in that set must have come back.
 *        This is the real risk, and it must stay a failure — see the note below.
 *
 *   L2 — a block above `l1Head`. These events happened *after* the fixture was built, so the
 *        fixture cannot possibly know about them. The fixture is not wrong; it is older than
 *        history.json, which CI rewrites every hour. Reporting this as a failure made
 *        `npm test` red for no reason on a schedule, and a test that goes red on a schedule
 *        stops being evidence of anything.
 *
 * Why L1 has to keep failing, in terms this repo already uses — the failure mode is not
 * theoretical. `build-data.mjs` in fixture mode reads timestamps ONLY from the fixture and
 * SILENTLY SKIPS anything it cannot find (`l1BlockTimes`, :43-51); the callers then record
 * the gap as `t: ts[b] || null` (:179-181). So a missing block becomes a `null` timestamp —
 * which the page renders as "time unavailable", indistinguishable from "this block really
 * has no timestamp". That is the exact bug documented at build-data.mjs:99-118, where an
 * interior milestone event was rendered but never queried and came back looking like absent
 * chain data. A stale-looking fixture that is really incomplete is that same defect wearing
 * a different hat, so the distinction is the whole point of this block.
 * ------------------------------------------------------------------ */
const staleInfo = (() => {
  const hist = JSON.parse(readFileSync(join(ROOT, "data/history.json"), "utf8"));
  const wanted = new Set();
  for (const e of Object.values(hist.events || {})) {
    const logs = e.logs || [];
    if (logs.length) {
      wanted.add(parseInt(logs[0].blockNumber, 16));
      wanted.add(parseInt(logs[logs.length - 1].blockNumber, 16));
    }
  }
  for (const name of ["Trimmed", "BackstopSettled"]) {
    for (const l of hist.events?.[name]?.logs || []) wanted.add(parseInt(l.blockNumber, 16));
  }
  const missing = [...wanted].filter((b) => fixture.l1BlockTimestamps?.[b] === undefined);
  // `l1Head` is `timeline.scannedTo` at the moment the fixture was built — see
  // make-base-fixture.mjs:73. It is the watermark: "the fixture deliberately covers the chain
  // up to here, and no further". If it is absent (an older fixture file), fall back to the
  // highest block the fixture actually carries, so the check degrades to the old behaviour
  // rather than silently passing everything.
  const carried = Object.keys(fixture.l1BlockTimestamps || {}).map(Number).filter(Number.isFinite);
  const head = Number.isFinite(Number(fixture.l1Head)) ? Number(fixture.l1Head) : Math.max(0, ...carried);
  /* A block can be "missing" for a third reason: it is above the fixture's head AND above the
   * highest block the fixture carries, i.e. it postdates the snapshot entirely. Those are
   * unambiguously L2. The `<= head` test covers the rest. */
  const beyondHead = missing.filter((b) => b > head).sort((a, b) => a - b);
  const withinHead = missing.filter((b) => b <= head).sort((a, b) => a - b);
  return { head, wanted: wanted.size, missing, beyondHead, withinHead };
})();

{
  const { head, missing, beyondHead, withinHead } = staleInfo;
  ok(
    `fixture carries a timestamp for every event block it claims to cover (${withinHead.length} missing at or below its head ${head})`,
    withinHead.length === 0,
    `the fixture was built at block ${head}, so these blocks already existed and the generator ` +
      `should have fetched them: ${withinHead.slice(0, 12).join(", ")}` +
      `${withinHead.length > 12 ? ` … (${withinHead.length} total)` : ""}\n` +
      `       This is NOT staleness and re-running \`npm run fixture\` would hide it: the generator ` +
      `would paper over the gap instead of explaining it. Fix the generator instead.`
  );

  /* L2 is reported, never fatal. It is printed as its own line rather than folded into the
   * assertion above so that a reader can tell "history moved on" from "the fixture is broken"
   * at a glance — the old single message told everyone to re-run the fixture, which is the
   * correct advice for this case and the WRONG advice for the one above. That misdirection is
   * what let the real defect look like routine maintenance. */
  if (beyondHead.length) {
    console.log(
      `  note history.json has moved past the fixture: ${beyondHead.length} newer event block(s) ` +
        `(> ${head}), newest ${Math.max(...beyondHead)} — expected between refreshes; ` +
        `run: npm run fixture  (not a failure)`
    );
  } else {
    console.log(`  note fixture is current: no event block in history.json is beyond its head ${head}`);
  }
  if (!missing.length) console.log(`  note fixture covers all ${staleInfo.wanted} event blocks in history.json`);
}

console.log("build-data.mjs, offline (fixture)");
const tmp = mkdtempSync(join(tmpdir(), "pool4-builddata-"));
try {
  const r = runBuildData(["--base-fixture", FIXTURE], tmp);

  ok("exits 0", r.status === 0, `exit ${r.status}\n${(r.stderr || "").split("\n").filter((l) => /Error|error/.test(l)).slice(0, 3).join("\n")}`);
  ok("no unhandled exception in stderr", !/ReferenceError|TypeError|RangeError/.test(r.stderr || ""), (r.stderr || "").slice(0, 200));

  // The lines that used to be unreachable: the summary runs after the Base section.
  ok("reaches the summary section", /summary:/.test(r.stdout), r.stdout.slice(-200));
  ok("summary reports the last L1 bridge", /last L1 bridge\s+block \d+/.test(r.stdout));
  ok("summary reports the last Base burn", /last Base burn\s+block \d+/.test(r.stdout));
  ok("summary does not claim the section was skipped", !/Base section skipped/.test(r.stdout));
  ok("Base section actually ran", /Base BurnExecuted\(\) events: \d+/.test(r.stdout) && /L1 TokensBridgedForBurn events: \d+/.test(r.stdout));

  const timeline = JSON.parse(readFileSync(join(tmp, "timeline.json"), "utf8"));
  const baseOut = JSON.parse(readFileSync(join(tmp, "base.json"), "utf8"));

  ok("timeline.json has trims", Array.isArray(timeline.trims) && timeline.trims.length > 0, `${timeline.trims?.length}`);
  ok("timeline.json timestamps resolved", timeline.trims.every((t) => Number.isFinite(t.t)));

  /* ------------------------------------------------------------------ *
   * The assertion the old check was trying to be.
   *
   * The check above asks "is the fixture recent enough?" — a question about the INPUT's age.
   * This one asks the question that actually matters: did any event lose its timestamp on the
   * way out? `build-data.mjs` writes `t: ts[b] || null` (:179-181), so a block the fixture did
   * not carry is recorded as `null` — which reads as "the chain has no timestamp for this
   * block" when the truth is "we never asked". Testing the OUTPUT catches that distortion
   * regardless of whether it was caused by a stale fixture, a generator gap, or a regression
   * in how blocks are collected.
   *
   * Scoped to blocks at or below the fixture's head on purpose: past that watermark the fixture
   * legitimately has nothing, so a `null` there is the honest answer rather than a defect.
   * (A `null` can also be genuine for a block the RPC could not resolve; that is why this is
   * keyed to the fixture's own coverage rather than being a blanket "no nulls anywhere".)
   * ------------------------------------------------------------------ */
  {
    const head = staleInfo.head;
    const resolvedTrims = (timeline.trims || []).filter((t) => Number.isFinite(t.b) && t.b <= head);
    const lostTs = resolvedTrims.filter((t) => t.t === null || t.t === undefined);
    ok(
      `no event at or below the fixture head lost its timestamp on the way out (${lostTs.length} became null of ${resolvedTrims.length})`,
      lostTs.length === 0,
      `build-data wrote t: null for block(s) ${lostTs.slice(0, 8).map((t) => t.b).join(", ")} — ` +
        `\`t: ts[b] || null\` turned "we never asked" into "the chain has no timestamp here"`
    );
    // The same distortion, one level down: the summary line prints the last trim's time, and
    // build-data.mjs:426 renders a missing entry as the literal "time unavailable".
    ok(
      "the summary line can name the last trim's time",
      /last L1 trim\s+block \d+\s+\d{4}-\d{2}-\d{2}T/.test(r.stdout),
      (r.stdout.split("\n").filter((l) => /last L1 trim/.test(l))[0] || "").trim() ||
        "no `last L1 trim` line in stdout — it printed \"time unavailable\""
    );
  }
  ok(
    `base.json carries every burn the fixture supplied (${baseOut.burns.length})`,
    baseOut.burns.length === fixture.baseLogs.length,
    `fixture ${fixture.baseLogs.length} vs output ${baseOut.burns.length}`
  );
  ok(
    `base.json carries every bridge the fixture supplied (${baseOut.bridges.length})`,
    baseOut.bridges.length === fixture.l1BridgeLogs.length,
    `fixture ${fixture.l1BridgeLogs.length} vs output ${baseOut.bridges.length}`
  );
  ok("burn timestamps came through", baseOut.burns.every((b) => Number.isFinite(b.t)), `${baseOut.burns.filter((b) => !b.t).length} missing`);
  ok("bridge timestamps came through", baseOut.bridges.every((b) => Number.isFinite(b.t)), `${baseOut.bridges.filter((b) => !b.t).length} missing`);
  ok("burn callers were decoded from topics", baseOut.burns.every((b) => /^0x[0-9a-f]{40}$/i.test(b.caller)), baseOut.burns[0]?.caller);
  ok(
    "base state came from the fixture",
    Number(baseOut.state.tokenDecimals) === Number(fixture.baseReads["decimals()"]) &&
      baseOut.state.tokenTotalSupply === String(fixture.baseReads["totalSupply()"]),
    JSON.stringify({ dec: baseOut.state.tokenDecimals, supply: baseOut.state.tokenTotalSupply?.slice(0, 16) })
  );
  ok("burns are sorted by block", baseOut.burns.every((b, i, a) => i === 0 || a[i - 1].b <= b.b));

  console.log("\nthe other branch: --skip-base must still work");
  const tmp2 = mkdtempSync(join(tmpdir(), "pool4-builddata-skip-"));
  const r2 = runBuildData(["--skip-base"], tmp2);
  ok("exits 0 with --skip-base", r2.status === 0, `exit ${r2.status}`);
  ok("says the Base section was skipped", /Base section skipped/.test(r2.stdout));
  ok("still writes timeline.json", existsSync(join(tmp2, "timeline.json")));
  ok("does not write base.json", !existsSync(join(tmp2, "base.json")));
  rmSync(tmp2, { recursive: true, force: true });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
await new Promise((resolve) => process.stdout.write("", resolve));
process.exit(fail === 0 ? 0 : 1);
