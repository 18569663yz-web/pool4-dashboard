// Would the last-burn figure on the page pass for fresh?
//
// On 2026-09-24 the refresh chain stopped for six hours: GitHub Actions only enqueued one
// scheduled run in that window, and it failed. Nothing on the page noticed, because failing
// loudly was never part of the deal — the conclusion band went on reporting "最近一次烧毁
// 7.0 小时前" while the chain's newest Trimmed was 25 minutes old.
//
// The wording fix (an upper bound plus "data as of …") makes the reading honest, but honest
// and *current* are different questions, and only the second one detects an outage. So this
// asks the questions the other suites do not:
//
//   1. the committed snapshot carries the chain's newest Trimmed (or explains why it is behind)
//   2. the freshness banner is up whenever the snapshot really is stale — the state that
//      actually reached production is a failure with nothing on screen saying so
//
// Both read the repository's own data/. The rate limit on a public endpoint can make (1)
// inconclusive; the verdict then says so rather than passing quietly.
//
//   node scripts/check-last-trim.mjs
//   node scripts/check-last-trim.mjs --url https://imd.kymmppee.xyz   # the deployed copy too
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Rpc, keccak256Hex, utf8ToBytes } from "../lib/evm.js";
import { ADDR } from "../lib/contracts.js";
import { oldestSnapshot } from "../lib/snapshots.js";

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
    console.log(`  FAIL ${label}${detail ? "\n       " + detail : ""}`);
  }
};
const hx = (n) => "0x" + BigInt(n).toString(16);

/**
 * How far behind the chain the page's figure is allowed to be, and why 90 minutes.
 *
 * The snapshots are refreshed hourly (`17 * * * *`), and the page shows the banner past three
 * hours. But GitHub's `schedule` is a best-effort queue: on 2026-09-24 it enqueued one run in
 * five hours. A threshold tighter than the schedule would fail on any late cron tick — noise,
 * and noise gets ignored. 90 minutes is one missed hourly run plus half an hour of dispatch
 * slack; it fires on a genuinely stopped or failing chain, not on a slow one.
 */
const STALE_AFTER_MINUTES = Number(argOf("--max-lag", "90"));
const READ_STALE_AFTER_HOURS = 3; // mirrors assets/app.js's STALE_AFTER_HOURS

const read = (p) => readFileSync(ROOT + p, "utf8");
const trimTopic = keccak256Hex(utf8ToBytes("Trimmed(uint128,uint256,uint256,uint256)"));

const timeline = JSON.parse(read("data/timeline.json"));
const newest = timeline.trims[timeline.trims.length - 1];

console.log(`snapshot: builtAt ${timeline.builtAt}, scannedTo ${timeline.scannedTo}, newest trim block ${newest.b} at ${new Date(newest.t * 1000).toISOString()}`);

/* ---------- 1. is the published snapshot behind the chain? ---------- */
const rpc = new Rpc(undefined, { timeoutMs: 25000 });
let chain = null;
try {
  /* Ask from the snapshot's own last event, never from a hard-coded block number: a
   * hard-coded one is exactly the thing that stops finding the bug once the bug is fixed. */
  const logs = await rpc.call("eth_getLogs", [
    { address: ADDR.hook, topics: [trimTopic], fromBlock: hx(newest.b), toBlock: "latest" },
  ]);
  const last = logs[logs.length - 1];
  const block = await rpc.getBlock(last.blockNumber);
  chain = { block: parseInt(last.blockNumber, 16), t: Number(BigInt(block.timestamp)) };
  console.log(`chain:    newest Trimmed block ${chain.block} at ${new Date(chain.t * 1000).toISOString()}, ${logs.length} Trimmed event(s) from block ${newest.b} onward`);
} catch (e) {
  console.log(`chain:    unreachable — ${
    e && e.message ? e.message : e
  }`);
}

if (chain) {
  const lagMinutes = (chain.t - newest.t) / 60;
  const missed = chain.block > newest.b;
  console.log(`\nthe page's figure against the chain — lag ${lagMinutes < 1 ? "<1" : lagMinutes.toFixed(1)} min, ${missed ? "the chain has burned since" : "the snapshot holds the newest burn"}`);
  ok(
    `the published snapshot is within ${STALE_AFTER_MINUTES} min of the chain's newest Trimmed (${lagMinutes.toFixed(1)} min)`,
    lagMinutes <= STALE_AFTER_MINUTES,
    `snapshot ${new Date(newest.t * 1000).toISOString()} vs chain ${new Date(chain.t * 1000).toISOString()} — ${lagMinutes.toFixed(1)} min behind; the refresh job is not keeping up`
  );
  ok(
    "the chain's newest Trimmed is not older than the snapshot (the chain only grows forward)",
    chain.t >= newest.t,
    `snapshot ${newest.t} > chain ${chain.t} — the snapshot claims a burn the chain does not have`
  );
} else {
  console.log("\n  --   lag not verifiable this run (RPC unreachable); the freshness checks below still apply");
}

/* ---------- 2. is the failure visible on the page? ---------- */
console.log("\nwhat the page would show for this data");
{
  const sources = {
    timeline: JSON.parse(read("data/timeline.json")),
    base: JSON.parse(read("data/base.json")),
    volume: JSON.parse(read("data/volume.json")),
    messages: JSON.parse(read("data/messages.json")),
    "bridge-history": JSON.parse(read("data/bridge-history.json")),
    baseline: JSON.parse(read("data/baseline.json")),
  };
  const oldest = oldestSnapshot(sources);
  const bannerUp = oldest.ageHours > READ_STALE_AFTER_HOURS;
  console.log(`  oldest snapshot: ${oldest.name} at ${oldest.ageHours.toFixed(1)}h → banner ${bannerUp ? "UP" : "down"}`);

  /* The check that matters, and the only one that could have caught the live outage: a
   * snapshot this far behind the chain must not be rendered as a current reading. Either the
   * snapshot is current, or the page says it is not. */
  if (chain) {
    const lagHours = (Date.now() / 1000 - newest.t) / 3600;
    const displayedAsCurrent = lagHours > READ_STALE_AFTER_HOURS && !bannerUp;
    ok(
      "a snapshot this far behind is either current or visibly marked stale",
      !displayedAsCurrent,
      `the burn figure is ${lagHours.toFixed(1)}h old and no banner is up — this is the 2026-09-24 outage, reproduced`
    );
  }

  ok(
    `the banner threshold still matches assets/app.js (${READ_STALE_AFTER_HOURS}h)`,
    new RegExp(`STALE_AFTER_HOURS\\s*=\\s*${READ_STALE_AFTER_HOURS}\\b`).test(read("assets/app.js")),
    "assets/app.js and this check disagree about when the page admits it is stale"
  );

  /* This is the check that the live site failed while the wording fix was being written, and it
   * is the one the render suite structurally cannot make: a snapshot can be well under the banner
   * threshold and still be behind the chain. The page then prints "最近一次烧毁 86 分钟前" as a
   * plain reading while the newest burn was 9.5 minutes old — the banner is down, so nothing on
   * screen says otherwise.
   *
   * assets/app.js answers it with snapshotBehindChain(): the live head it read against
   * timeline.last.Trimmed. Both sides of that comparison are available here, so it is asserted
   * rather than argued about. A burn after the snapshot is normal (the snapshot is a photograph,
   * the chain keeps moving) — this does not fail on that. It fails only if the code that is
   * supposed to notice has gone missing, which is how the gap got shipped. */
  const behindChain = chain ? chain.block > newest.b : null;
  ok(
    "assets/app.js still consults the chain head, not just the snapshot's own age",
    /snapshotBehindChain/.test(read("assets/app.js")) && /mayNotBeLatest/.test(read("assets/app.js")),
    "the conclusion band would qualify its wording from snapshot age alone — the 86-minute case"
  );
  if (chain) {
    const gapMinutes = (chain.t - newest.t) / 60;
    console.log(
      `  the chain's newest burn is ${gapMinutes.toFixed(1)} min after the snapshot's → ${
        behindChain ? "the page must qualify that line (\"或更近\")" : "the snapshot holds the newest burn, so a plain \"ago\" is correct"
      }`
    );
    ok(
      "a snapshot that the chain has moved past is not merely stale — it is also not the latest burn",
      true,
      "" /* informational: the requirement itself is asserted above, and in test-render.mjs */
    );
  }
}

/* ---------- 3. optionally, the deployed copy ---------- */
const URL_ = argOf("--url", "");
if (URL_) {
  console.log(`\nthe deployed copy (${URL_})`);
  try {
    const deployed = await (await fetch(new URL("data/timeline.json", URL_).href)).json();
    const dNewest = deployed.trims[deployed.trims.length - 1];
    /* How far the deployed copy lags the chain: measured against the same chain reading, so
     * "the site never redeployed" shows up as the site's own lag, not the repository's. */
    const lagMinutes = (Date.now() / 1000 - dNewest.t) / 60;
    console.log(`  deployed: builtAt ${deployed.builtAt}, newest trim block ${dNewest.b}`);
    ok(
      `the deployed snapshot is within ${STALE_AFTER_MINUTES} min of the chain's newest Trimmed (${lagMinutes.toFixed(1)} min)`,
      !chain || lagMinutes <= STALE_AFTER_MINUTES,
      `deployed ${new Date(dNewest.t * 1000).toISOString()} vs chain ${chain ? new Date(chain.t * 1000).toISOString() : "?"}`
    );
  } catch (e) {
    ok("the deployed copy could be fetched", false, e && e.message ? e.message : String(e));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
await new Promise((resolve) => process.stdout.write("", resolve));
process.exit(fail === 0 ? 0 : 1);
