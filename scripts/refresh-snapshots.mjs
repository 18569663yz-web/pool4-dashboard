// Refresh every snapshot, but only let validated output reach data/.
//
// The generators are run with --out-dir pointing at a staging directory. Nothing touches
// the shipped files until `verify-snapshots.mjs` has checked both the shape of each
// artifact and that history did not go backwards. A failure leaves data/ exactly as it
// was and exits non-zero, so the workflow skips its commit.
//
//   node scripts/refresh-snapshots.mjs                 # everything
//   node scripts/refresh-snapshots.mjs --only volume,messages
//   node scripts/refresh-snapshots.mjs --dry-run       # stage + verify, then stop
//
// Why this exists: the refresh job runs unattended against public RPC endpoints that
// occasionally answer with nonsense instead of an error (NOTES.md §16). Writing straight
// to data/ would mean one bad hour quietly ships an empty timeline.
import { spawn } from "node:child_process";
import { copyFileSync, renameSync, mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const ONLY = argOf("--only", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const DRY = process.argv.includes("--dry-run");

/** The order matters: build-data reads what index-logs produced. */
const STEPS = [
  { id: "index", script: "index-logs.mjs", outputs: ["history.json"] },
  { id: "timeline", script: "build-data.mjs", outputs: ["timeline.json", "base.json"] },
  { id: "volume", script: "scan-swaps.mjs", args: ["24"], outputs: ["volume.json"] },
  { id: "messages", script: "fetch-messages.mjs", outputs: ["messages.json"] },
  { id: "bridge", script: "fetch-bridge-history.mjs", outputs: ["bridge-history.json"] },
  { id: "baseline", script: "collect.mjs", outputs: ["baseline.json"] },
];

const staging = mkdtempSync(join(tmpdir(), "pool4-refresh-"));
console.log(`staging: ${staging}\n`);

const run = (script, args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, "scripts", script), ...args], { cwd: ROOT, stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });

const fail = (message) => {
  console.error(`\n✗ ${message}`);
  console.error(`  data/ was not touched. Staging kept at ${staging}`);
  process.exit(1);
};

for (const step of STEPS) {
  if (ONLY.length && !ONLY.some((o) => step.id === o || step.outputs.some((f) => f.startsWith(o)))) continue;
  console.log(`\n─── ${step.id} (${step.script}) ${"─".repeat(Math.max(0, 40 - step.id.length))}`);
  const code = await run(step.script, ["--out-dir", staging, ...(step.args || [])]);
  if (code !== 0) fail(`${step.script} exited with code ${code}`);
  const missing = step.outputs.filter((f) => !existsSync(join(staging, f)));
  if (missing.length) fail(`${step.script} did not produce: ${missing.join(", ")}`);
}

console.log(`\n─── verify ${"─".repeat(34)}`);
const verifyArgs = [join(ROOT, "scripts", "verify-snapshots.mjs"), "--dir", staging, "--prev", join(ROOT, "data")];
const verifyCode = await new Promise((resolve) => {
  const child = spawn(process.execPath, verifyArgs, { cwd: ROOT, stdio: "inherit" });
  child.on("close", (c) => resolve(c ?? 1));
  child.on("error", () => resolve(1));
});
if (verifyCode !== 0) fail("snapshot verification failed");

if (DRY) {
  console.log(`\n(dry run) verified output left in ${staging}`);
  process.exit(0);
}

console.log(`\n─── promote ${"─".repeat(33)}`);
let promoted = 0;
let unchanged = 0;
for (const step of STEPS) {
  for (const file of step.outputs) {
    const from = join(staging, file);
    const to = join(ROOT, "data", file);
    if (!existsSync(from)) continue;
    // Write next to the target, then rename: a reader never sees a half-written file.
    const tmp = to + ".incoming";
    copyFileSync(from, tmp);
    // Byte comparison is the "no empty commit" guard: the workflow only commits when
    // something actually changed, and this is where that is decided.
    if (existsSync(to) && Buffer.compare(readFileSync(to), readFileSync(tmp)) === 0) {
      rmSync(tmp, { force: true });
      unchanged++;
      console.log(`  = ${file} (unchanged)`);
      continue;
    }
    renameSync(tmp, to);
    promoted++;
    console.log(`  ✓ ${file}`);
  }
}

rmSync(staging, { recursive: true, force: true });
console.log(`\n${promoted} updated, ${unchanged} unchanged`);
