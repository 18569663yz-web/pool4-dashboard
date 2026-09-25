// Refresh every snapshot, but only let validated output reach data/.
//
// The generators are run with --out-dir pointing at a staging directory. Nothing touches
// the shipped files until `verify-snapshots.mjs` has checked both the shape of each
// artifact and that history did not go backwards.
//
//   node scripts/refresh-snapshots.mjs                 # everything
//   node scripts/refresh-snapshots.mjs --only volume,messages
//   node scripts/refresh-snapshots.mjs --dry-run       # stage + verify, then stop
//
// Why this exists: the refresh job runs unattended against public RPC endpoints that
// occasionally answer with nonsense instead of an error (NOTES.md §16). Writing straight
// to data/ would mean one bad hour quietly ships an empty timeline.
//
// REQUIRED vs OPTIONAL, AND WHY THE DISTINCTION IS THE POINT
// ----------------------------------------------------------
// Every step used to be required: the first non-zero exit called fail() and process.exit(1),
// the workflow skipped its commit, and data/ stayed frozen. On 2026-09-24 one upstream
// (Blockscout) stopped answering, the `messages` step failed, and the other five snapshots —
// all of them healthy — aged for nine hours behind it. One source of six took out six of six,
// and the summary said only that one step had failed.
//
// A required step is one the page cannot be coherent without, and whose absence is not
// representable: `index` feeds everything downstream, `timeline` drives the state machine and
// the verdict, `baseline` is the comparison every figure on the page is drawn against. If one
// of those fails there is no partial result worth publishing.
//
// An optional step is one whose output the page is already built to present as stale. All
// three remaining snapshots carry their own `fetchedAt`/`builtAt`, the page renders a freshness
// banner from it, and `renderStaleBanner()`/`asOf()` exist precisely to say "this number is from
// an earlier moment". Five fresh files and one stale one beats publishing nothing, which is
// what the old behaviour did.
//
// Optional failure is NOT silent: it prints a ::warning:: (turning the run yellow in Actions)
// and names the step, the upstream error that caused it, and the file that will now age. The
// signal is weaker than a red run, which is exactly why check-live-numbers.mjs separately
// asserts each snapshot's freshness on its own schedule — this script is the producer, and a
// producer should not be the only thing watching whether it worked.
//
// `--skip` remains different again: a human choosing to omit a step for a local run. That is
// not the same as tolerating an automatic failure, and the two must not be conflated.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promoteSnapshots } from "../lib/snapshot-promote.js";

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
const SKIP_BASE = process.env.POOL4_SKIP_BASE === "1";
const STEPS = [
  // `required` decides whether a failure stops the run (see the header). `why` and `upstream`
  // exist so the warning names the thing a reader needs: which external service, and what the
  // page will now be missing.
  {
    id: "index",
    script: "index-logs.mjs",
    outputs: ["history.json"],
    required: true,
    why: "the raw event index every other snapshot is derived from",
  },
  {
    id: "timeline",
    script: "build-data.mjs",
    args: SKIP_BASE ? ["--skip-base"] : [],
    outputs: ["timeline.json"],
    optionalOutputs: ["base.json"],
    required: true,
    why: "the state machine, the verdict, and the whole historical section",
    upstream: "ethereum-rpc.publicnode.com (L1)",
  },
  {
    id: "volume",
    script: "scan-swaps.mjs",
    args: ["24"],
    outputs: ["volume.json"],
    required: false,
    why: "the 24h volume panel",
    upstream: "ethereum-rpc.publicnode.com (L1)",
  },
  {
    id: "messages",
    script: "fetch-messages.mjs",
    outputs: ["messages.json"],
    required: false,
    why: "the on-chain message board",
    upstream: "eth.blockscout.com",
  },
  {
    id: "bridge",
    script: "fetch-bridge-history.mjs",
    outputs: ["bridge-history.json"],
    required: false,
    why: "the second door's bridge queue history",
    upstream: "ethereum-rpc.publicnode.com (L1)",
  },
  {
    id: "baseline",
    script: "collect.mjs",
    outputs: ["baseline.json"],
    required: true,
    why: "the reference values every figure on the page is compared against",
    upstream: "ethereum-rpc.publicnode.com (L1)",
  },
];

/**
 * --skip <ids|outputs> omits steps, for networks where one upstream is unreachable.
 *
 * Used deliberately and visibly: skipping produces no file, so verify-snapshots leaves the
 * published copy alone and the page's staleness banner starts counting. This is a human
 * decision about a local run — it is NOT the same as an optional step failing on its own,
 * and the two are kept separate on purpose.
 */
const SKIP = argOf("--skip", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Steps that failed but did not stop the run. Reported at the end, as a warning. */
const degraded = [];

const staging = mkdtempSync(join(tmpdir(), "pool4-refresh-"));
console.log(`staging: ${staging}\n`);

/**
 * Run a generator, keeping a short tail of its output for diagnosis.
 *
 * stdio is still "inherit" so the log reads the same as before — but the last lines are
 * captured too, because the warning has to name the actual error. On 2026-09-24 the summary
 * of the outage would have been "messages failed"; what was needed was
 * "ConnectTimeoutError ... eth.blockscout.com". A warning that cannot be acted on is only
 * marginally better than no warning.
 */
const run = (script, args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, "scripts", script), ...args], { cwd: ROOT, stdio: ["ignore", "inherit", "pipe"] });
    let tail = "";
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      tail = (tail + chunk.toString()).slice(-4000);
    });
    child.on("close", (code) => resolve({ code: code ?? 1, tail }));
    child.on("error", (e) => resolve({ code: 1, tail: String(e.message) }));
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One retry on failure. The generators talk to public RPC endpoints and to Blockscout,
 * both of which drop connections for a few seconds now and then — a transient timeout
 * should not cost an hour of freshness (or wake the repository owner with a red run).
 * A real outage still fails: two attempts, then the caller decides what that means.
 *
 * @returns {{code:number, tail:string}}
 */
async function runStep(step) {
  const args = ["--out-dir", staging, ...(step.args || [])];
  const attempts = process.argv.includes("--no-retry") ? 1 : 2;
  let last = { code: 1, tail: "" };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await run(step.script, args);
    if (last.code === 0) return last;
    if (attempt < attempts) {
      console.log(`  ${step.script} failed (attempt ${attempt}/${attempts}) — retrying in 20s`);
      await sleep(20_000);
    }
  }
  return last;
}

/**
 * Pull the line that actually explains a failure out of the captured stderr.
 *
 * This is the line the next person reads to decide what to do, so it has to be the CAUSE and
 * not the best-matching string. Two traps, both found by fault injection against a dead RPC:
 *
 *   - node prints the offending source line (`throw new RpcError(...)`) directly beneath its
 *     `file:///.../evm.js:408` frame. That is code, not diagnosis, and it matches a naive
 *     /error|failed/ search before the real message does.
 *   - the first genuinely useful line is usually the thrown error's own first line
 *     (`RpcError: all 1 endpoints failed ...` / `TypeError: fetch failed`), or the `[cause]:`
 *     detail undici attaches underneath.
 *
 * So the source-line echo is dropped, real error heads are preferred, and the search is
 * ordered rather than first-match.
 */
function diagnose(tail) {
  const lines = tail
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^\s*at\s/.test(l))
    .filter((l) => !/^Node\.js v/.test(l))
    .filter((l) => !/^\[?stderr\]?$/.test(l))
    // node echoes the failing source line below the file:// frame — drop it.
    .filter((l) => !/^file:\/\//.test(l))
    .filter((l) => !/^\s*(throw |const |let |return |await )/.test(l));

  // 1. an explicit cause (undici attaches `[cause]: ConnectTimeoutError ...`). Strip the
  //    bracket form only — callers label this line themselves, so adding a "cause:" prefix
  //    here would print it twice.
  const cause = lines.find((l) => /^\s*\[?cause\]?\s*:/.test(l));
  if (cause) return cause.replace(/^\s*\[?cause\]?\s*:\s*/i, "").slice(0, 300);

  // 2. the thrown error's headline: `SomethingError: message` / `Error: message`.
  const head = lines.find((l) => /^[A-Za-z_$][\w$]*Error\b\s*:/.test(l) || /^Error\b\s*:/.test(l));
  if (head) {
    // Prefer to append the cause if it is on the same line as the text.
    return head.slice(0, 300);
  }

  // 3. any line naming a concrete failure mode.
  const netish = lines.find((l) => /ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|ConnectTimeout|socket hang up|aborted|HTTP \d{3}|timeout/i.test(l));
  if (netish) return netish.slice(0, 300);

  return (lines[lines.length - 1] || "no error text captured").slice(0, 300);
}

const fail = (message) => {
  console.error(`\n✗ ${message}`);
  console.error(`  data/ was not touched. Staging kept at ${staging}`);
  process.exit(1);
};

/** A required step that did not produce its file: nothing downstream is trustworthy. */
const failStep = (step, message) => {
  console.error(`\n✗ ${step.id}: ${message}`);
  console.error(`  ${step.id} is required — ${step.why}.`);
  console.error(`  data/ was not touched. Staging kept at ${staging}`);
  process.exit(1);
};

for (const step of STEPS) {
  if (ONLY.length && !ONLY.some((o) => step.id === o || step.outputs.some((f) => f.startsWith(o)))) continue;
  if (SKIP.some((s) => step.id === s || step.outputs.some((f) => f.startsWith(s)))) {
    console.log(`\n─── ${step.id}: skipped (--skip)`);
    continue;
  }
  console.log(`\n─── ${step.id} (${step.script}) ${"─".repeat(Math.max(0, 40 - step.id.length))}`);
  const { code, tail } = await runStep(step);
  const missingNow = step.outputs.filter((f) => !existsSync(join(staging, f)));

  if (code !== 0 || missingNow.length) {
    const cause = diagnose(tail);
    const detail = code !== 0 ? `${step.script} exited with code ${code}` : `${step.script} did not produce: ${missingNow.join(", ")}`;
    if (step.required) failStep(step, `${detail}\n  cause: ${cause}`);

    /* Optional: keep going, publish everything else, and say plainly what will now age. */
    console.log(`\n  ⚠ optional step "${step.id}" failed — continuing`);
    console.log(`    ${detail}`);
    console.log(`    cause: ${cause}`);
    degraded.push({ step, detail, cause, files: step.outputs });
    // Drop any partial file so verify/prune never sees half-written output.
    for (const f of missingNow) rmSync(join(staging, f), { force: true });
    continue;
  }

  for (const f of step.optionalOutputs || []) {
    if (!existsSync(join(staging, f))) console.log(`  note: ${f} was not produced this run — the published copy stays in place`);
  }
}

console.log(`\n─── verify ${"─".repeat(34)}`);
const verifyArgs = [join(ROOT, "scripts", "verify-snapshots.mjs"), "--dir", staging, "--prev", join(ROOT, "data")];
const verifyCode = await new Promise((resolve) => {
  const child = spawn(process.execPath, verifyArgs, { cwd: ROOT, stdio: "inherit" });
  child.on("close", (c) => resolve(c ?? 1));
  child.on("error", () => resolve(1));
});
if (verifyCode !== 0) fail("snapshot verification failed");

/* The degraded-run report runs on EVERY exit path, including --dry-run. It used to sit after
 * the promote step, which meant a dry run printed no warning at all — and --dry-run is exactly
 * the mode used to test this path, so the omission hid itself. Reporting is defined as a
 * function and called from each exit point. */
function reportDegraded(promotedCount) {
  if (!degraded.length) return;
  console.log(`\n${"!".repeat(68)}`);
  console.log(`!! DEGRADED RUN — ${degraded.length} optional step(s) failed`);
  console.log(`${"!".repeat(68)}`);
  for (const d of degraded) {
    console.log(`\n  step     ${d.step.id} (${d.step.script})`);
    console.log(`  upstream ${d.step.upstream || "unknown"}`);
    console.log(`  cause    ${d.cause}`);
    console.log(`  effect   ${d.files.join(", ")} keeps its previous contents and will age.`);
    console.log(`           The page shows this as a staleness banner — the two must agree.`);
  }
  console.log("");

  // Actions annotation: turns the run yellow and surfaces in the UI without failing the job.
  for (const d of degraded) {
    const msg = `${d.step.id} failed (${d.step.upstream || "unknown upstream"}): ${d.cause} — ${d.files.join(", ")} is now stale.`.replace(/\r?\n/g, " ");
    console.log(`::warning::${msg}`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      const lines = [];
      lines.push("### ⚠️ snapshot refresh — degraded run");
      lines.push("");
      lines.push(
        `This run completed in **degraded mode**: ${degraded.length} optional source(s) failed, so their snapshots keep the previous contents and will age. ${
          promotedCount === null
            ? "(dry run — nothing was promoted.)"
            : `The other ${promotedCount} file(s) were updated and committed.`
        }`
      );
      lines.push("");
      lines.push("| step | upstream | effect |");
      lines.push("| --- | --- | --- |");
      for (const d of degraded) {
        lines.push(`| \`${d.step.id}\` | ${d.step.upstream || "unknown"} | \`${d.files.join(", ")}\` stays at its previous contents |`);
      }
      lines.push("");
      lines.push("**What this means for the page:** the affected section(s) will start showing a staleness banner.");
      lines.push("The two must agree — if the page does not look stale, that is a second bug.");
      lines.push("");
      lines.push("<details><summary>cause</summary>");
      lines.push("");
      for (const d of degraded) lines.push(`- \`${d.step.id}\`: ${d.cause}`);
      lines.push("");
      lines.push("</details>");
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
    } catch (e) {
      console.log(`(could not write the step summary: ${e.message})`);
    }
  }
}

if (DRY) {
  console.log(`\n(dry run) verified output left in ${staging}`);
  reportDegraded(null);
  process.exit(0);
}

console.log(`\n─── promote ${"─".repeat(33)}`);
/* outputs AND optionalOutputs — see lib/snapshot-promote.js for what the run of green builds
 * cost while this was `step.outputs` alone. */
const { updated, unchanged } = promoteSnapshots({ steps: STEPS, staging, dataDir: join(ROOT, "data") });
for (const file of unchanged) console.log(`  = ${file} (unchanged)`);
for (const file of updated) console.log(`  ✓ ${file}`);

rmSync(staging, { recursive: true, force: true });
console.log(`\n${updated.length} updated, ${unchanged.length} unchanged`);

/* A degraded run still exits 0 — the commit goes ahead with the snapshots that are good, which
 * is the whole point of the required/optional split. The failure has to be loud in every other
 * channel available: the log, an Actions annotation, and the job summary. Exit 0 with a silent
 * warning would reproduce the original bug in a new shape. */
reportDegraded(updated.length);
