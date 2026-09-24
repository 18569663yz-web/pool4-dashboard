// Step 3 logic: the second door's queue.
//
//   node scripts/test-bridge.mjs
//
// The point of this metric is to distinguish "tokens were destroyed" from "tokens are
// stacked up in the waypoint contract". These assertions pin the classification rules
// and the wording that keeps the two apart.
import { readBridgeTrend } from "../lib/contracts.js";

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

const E18 = 10n ** 18n;
const j = (o) => JSON.stringify(o, (k, v) => (typeof v === "bigint" ? v.toString() : v));
const imd = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

/** Build a synthetic sample series, oldest first. */
function series(values) {
  // bridgeHistory returns newest-first; callers here pass oldest-first for readability.
  const labels = ["now", "6h", "12h", "18h", "24h", "7d"];
  const rev = [...values].reverse();
  const points = rev.map((v, i) => ({ label: labels[i], hoursAgo: 0, block: 1000 + i, value: v === null ? null : imd(v) }));
  return { now: points[0].value, points, headTs: 0 };
}

console.log("trend classification");
{
  // rises then falls -> someone bridged
  const t = readBridgeTrend(series([0.6, 0, 853.5, 743.9, 5.6, 782.2]));
  ok("a series that falls at least once reads as 'moving'", t.verdict === "moving", j(t));
  ok("it counts the falls", t.fell === 3, `fell=${t.fell} (0.6->0, 853->744, 744->5.6)`);
  ok("24h net change is computed", t.net24 === imd(782.2) - imd(0), String(t.net24));
  ok("7d net change is computed", t.net7d === imd(782.2) - imd(0.6), String(t.net7d));
}
{
  // only rises -> nobody is pushing
  const t = readBridgeTrend(series([1, 50, 120, 300, 500, 900]));
  ok("a monotonically rising series reads as 'growing'", t.verdict === "growing", j(t));
  ok("it reports no falls", t.fell === 0, `fell=${t.fell}`);
}
{
  // perfectly flat -> nothing happened
  const t = readBridgeTrend(series([42, 42, 42, 42, 42, 42]));
  ok("a flat series reads as 'flat'", t.verdict === "flat", j(t));
}
{
  // a single fall is enough
  const t = readBridgeTrend(series([10, 10, 10, 10, 9, 9]));
  ok("one fall is enough to count as 'moving'", t.verdict === "moving", j(t));
}
{
  // archive misses must not be mistaken for a drop to zero
  const t = readBridgeTrend(series([10, null, 20, null, 30, 40]));
  ok("archive misses are skipped, not treated as zero", t.verdict === "growing", j(t));
  ok("it reports how many samples were usable", t.samples === 4, `samples=${t.samples}`);
}
{
  const t = readBridgeTrend({ points: [{ label: "now", value: imd(5) }] });
  ok("one sample is not enough to judge", t.verdict === "unknown", j(t));
}

console.log("\nwording — the two doors must not be conflated");
{
  const copy = JSON.parse((await import("node:fs").then((fs) => fs.readFileSync(new URL("../data/_awaiting-copy.json", import.meta.url), "utf8"))).replace(/^\uFEFF/, ""));
  for (const lang of ["zh", "en"]) {
    const c = copy[lang];
    ok(`[${lang}] the title names the bridge, not a burn`, /桥接|bridge/i.test(c["awaiting.title"]), c["awaiting.title"]);
    ok(`[${lang}] the explanation says it is NOT burned yet`, /不是.*已销毁|not.*burned yet/i.test(c["awaiting.what"]), c["awaiting.what"].slice(0, 90));
    ok(`[${lang}] it names BurnExecutor`, c["awaiting.what"].includes("BurnExecutor"));
    ok(`[${lang}] the growing case says nobody is pushing`, /没有人|nobody/i.test(c["awaiting.growingExplain"]), c["awaiting.growingExplain"].slice(0, 80));
    ok(`[${lang}] the dev quote is cited with its block`, c["awaiting.devQuote"].includes("25793366"));
    ok(`[${lang}] unavailable is described as unknown, not zero`, /未知|unknown/i.test(c["awaiting.noteUnavailable"]));
  }
  ok("both locales define the same keys", Object.keys(copy.zh).sort().join() === Object.keys(copy.en).sort().join());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
