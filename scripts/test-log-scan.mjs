// The L1 bridge scan used to be `try { … } catch {}`.
//
// A throttled window on CI dropped its events silently — no log line, no retry — and the only
// symptom was verify-snapshots.mjs reporting one fewer bridge than the previous run
// (62 → 61), which reads like something that happened on chain. 247 windows per run is 247
// chances for a public endpoint to throttle one.
//
// These tests pin the opposite contract: a window that never answers is always reported to
// the caller, and `build-data.mjs` refuses to publish rather than shipping a shorter list.
//
//   node scripts/test-log-scan.mjs
import { scanLogWindows } from "../lib/log-scan.js";

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

const noSleep = async () => {};
const logAt = (n) => ({ blockNumber: "0x" + n.toString(16) });

console.log("a clean scan");
{
  const calls = [];
  const r = await scanLogWindows({
    from: 100,
    to: 399,
    window: 100,
    sleep: noSleep,
    fetchWindow: async (from, to) => {
      calls.push([from, to]);
      return [logAt(from)];
    },
  });
  ok(
    "windows tile the range exactly",
    JSON.stringify(calls) === JSON.stringify([[100, 199], [200, 299], [300, 399]]),
    JSON.stringify(calls)
  );
  ok("every window contributed", r.logs.length === 3, `${r.logs.length} logs`);
  ok("no failures", r.failures.length === 0);
  ok("no retries", r.retries === 0);
  ok("the window count is reported", r.windows === 3, `${r.windows}`);
}

console.log("\nthe final window is clipped to `to`");
{
  const calls = [];
  await scanLogWindows({
    from: 100,
    to: 250,
    window: 100,
    sleep: noSleep,
    fetchWindow: async (from, to) => {
      calls.push([from, to]);
      return [];
    },
  });
  ok(
    "a partial window ends at `to`, not past it",
    JSON.stringify(calls) === JSON.stringify([[100, 199], [200, 250]]),
    JSON.stringify(calls)
  );
}

console.log("\na window that fails once and then succeeds");
{
  let n = 0;
  const r = await scanLogWindows({
    from: 0,
    to: 199,
    window: 100,
    sleep: noSleep,
    fetchWindow: async (from) => {
      n++;
      if (from === 0 && n === 1) throw new Error("429 Too Many Requests");
      return [logAt(from)];
    },
  });
  ok("the retry recovers the window", r.logs.length === 2, `${r.logs.length} logs`);
  ok("it is counted as one retry", r.retries === 1, `retries ${r.retries}`);
  ok("and is not a failure", r.failures.length === 0);
}

console.log("\na window that never answers is reported, never dropped quietly");
{
  const r = await scanLogWindows({
    from: 0,
    to: 299,
    window: 100,
    attempts: 3,
    sleep: noSleep,
    fetchWindow: async (from) => {
      if (from === 100) throw new Error("429 Too Many Requests");
      return [logAt(from)];
    },
  });
  /* This is the assertion the old code fails: `catch {}` would leave `failures` empty and the
   * caller would publish a shorter list with no idea why. */
  ok(
    "the failure reaches the caller",
    r.failures.length === 1,
    `failures ${r.failures.length} — a silent catch gives 0`
  );
  ok(
    "with the range it covered",
    r.failures[0].from === 100 && r.failures[0].to === 199,
    JSON.stringify(r.failures[0])
  );
  ok("and the reason", /429/.test(r.failures[0].error), r.failures[0].error);
  ok("the healthy windows still contributed", r.logs.length === 2, `${r.logs.length} logs`);
  ok("both repeats were counted", r.retries === 2, `retries ${r.retries}`);
}

console.log("\nattempts: 1 means no repeat is attempted");
{
  let n = 0;
  const r = await scanLogWindows({
    from: 0,
    to: 99,
    attempts: 1,
    sleep: noSleep,
    fetchWindow: async () => {
      n++;
      throw new Error("nope");
    },
  });
  ok("one call for the window", n === 1, `${n} calls`);
  ok("nothing to count as a retry", r.retries === 0, `retries ${r.retries}`);
  ok("still reported as a failure", r.failures.length === 1);
}

console.log("\nthe backoff grows between attempts");
{
  const waited = [];
  await scanLogWindows({
    from: 0,
    to: 99,
    attempts: 3,
    backoffMs: 100,
    sleep: async (ms) => {
      waited.push(ms);
    },
    fetchWindow: async () => {
      throw new Error("nope");
    },
  });
  ok("waits 100ms, then 200ms", JSON.stringify(waited) === JSON.stringify([100, 200]), JSON.stringify(waited));
}

console.log("\nan empty range does nothing");
{
  const r = await scanLogWindows({
    from: 500,
    to: 400,
    sleep: noSleep,
    fetchWindow: async () => {
      throw new Error("must not be called");
    },
  });
  ok("no windows, no failures, no logs", r.windows === 0 && r.failures.length === 0 && r.logs.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
await process.stdout.write("");
process.exit(fail ? 1 : 0);
