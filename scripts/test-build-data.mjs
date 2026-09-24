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
