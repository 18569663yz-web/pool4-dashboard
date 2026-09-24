// Boundary tests for the incremental event index.
//
// These exist because the merge rule is a data-loss boundary, not a formatting detail. The
// first version carried over `block < start` and looked right for months: when the chain head
// is behind the resume point (a lagging endpoint, a resolving reorg, the wrong chain) the scan
// loop does not execute at all, so nothing is covered and that test silently drops the entire
// previous range. The index would simply hold fewer events than before, and every consumer
// downstream would report a smaller, entirely plausible history.
//
//   node scripts/test-log-index.mjs
import { mergeEventIndex, resumePoint, classifyHead, nextScanTo, isWithinScan } from "../lib/log-index.js";

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
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const TOPIC0 = { Trimmed: "0xtrim", FeeCollected: "0xfee" };
const TOPICS = { Trimmed: "Trimmed(uint256,uint256)", FeeCollected: "FeeCollected(uint256)" };
const NAME_BY_TOPIC = { "0xtrim": "Trimmed", "0xfee": "FeeCollected" };

/** A log in eth_getLogs shape. */
const log = (block, logIndex = 0, topic = "0xtrim") => ({
  blockNumber: "0x" + block.toString(16),
  logIndex: "0x" + logIndex.toString(16),
  transactionHash: "0x" + block.toString(16).padStart(64, "0"),
  topics: [topic],
  data: "0x",
});

/** Previous index holding one event per given block. */
const prevIndex = (blocks) => ({ Trimmed: { logs: blocks.map((b) => log(b)) } });

const merge = (over) =>
  mergeEventIndex({
    topic0ByName: TOPIC0,
    signatures: TOPICS,
    nameByTopic: (t) => NAME_BY_TOPIC[t],
    ...over,
  });

const blocksOf = (res) => res.events.Trimmed.logs.map((l) => parseInt(l.blockNumber, 16));
const sum = (res) => Object.values(res.events).reduce((n, e) => n + e.count, 0);

console.log("the carry-over boundary");
{
  // Normal incremental run: the scan covers [250, 350], so 100 and 200 survive from the old
  // index and 300 arrives from the scan.
  const r = merge({ prevEvents: prevIndex([100, 200, 300]), freshLogs: [log(300), log(340)], start: 250, head: 350 });
  eq("a normal run keeps older events and adds new ones", blocksOf(r), [100, 200, 300, 340]);
  eq("carried count is reported", r.carried, 2);
  eq("indexed total counts everything", sum(r), 4);
  eq("no events are counted as unknown", r.unknown, 0);
}
{
  // The regression: head behind the resume point. The scan loop never runs, so NOTHING was
  // covered and the whole previous index must survive. `block < start` alone loses 250..300.
  const r = merge({ prevEvents: prevIndex([100, 200, 250, 300]), freshLogs: [], start: 250, head: 240 });
  eq("a head behind the resume point keeps every previous event", blocksOf(r), [100, 200, 250, 300]);
  eq("all of them are counted as carried", r.carried, 4);
  ok("nothing is within the (empty) scan range", !isWithinScan(250, 250, 240) && !isWithinScan(240, 250, 240));
}
{
  // Degenerate but legal: the scan covers exactly one block, which is also the resume point.
  const r = merge({ prevEvents: prevIndex([100, 200]), freshLogs: [log(200, 7)], start: 200, head: 200 });
  eq("a single-block scan replaces that block and keeps the rest", blocksOf(r), [100, 200]);
  eq("the replacement is the fresh log, not the old one", r.events.Trimmed.logs[1].logIndex, "0x7");
  eq("only the old block-200 entry was dropped", r.carried, 1);
}
{
  // Overlapping windows must not duplicate: same block, same logIndex.
  const r = merge({ prevEvents: prevIndex([100, 300]), freshLogs: [log(300), log(300)], start: 250, head: 350 });
  eq("duplicate (block, logIndex) pairs collapse", blocksOf(r), [100, 300]);
}
{
  const r = merge({ prevEvents: prevIndex([100]), freshLogs: [log(200), log(210, 0, "0xunknown")], start: 150, head: 250 });
  eq("unknown topics are counted, not stored", r.unknown, 1);
  eq("known logs still land", blocksOf(r), [100, 200]);
}
{
  const r = merge({ prevEvents: {}, freshLogs: [log(500)], start: 1, head: 600 });
  eq("a first run with no previous index works", blocksOf(r), [500]);
  eq("an empty previous index carries nothing", r.carried, 0);
}
{
  const r = merge({ prevEvents: prevIndex([100, 200]), freshLogs: [], start: 150, head: 150 });
  eq("an empty scan window still carries everything outside it", blocksOf(r), [100, 200]);
}

console.log("\nresume point");
{
  eq("first run starts at the floor", resumePoint({ prevScanTo: 0, floor: 25887000 }), 25887000);
  eq("incremental run resumes before the previous height", resumePoint({ prevScanTo: 26046186, floor: 25887000, margin: 200 }), 26045986);
  eq("resume never goes below the floor", resumePoint({ prevScanTo: 25887050, floor: 25887000, margin: 200 }), 25887000);
  eq("--force restarts from the floor", resumePoint({ prevScanTo: 26046186, floor: 25887000, force: true }), 25887000);
}

console.log("\nhead classification");
{
  eq("no previous index is a first run", classifyHead({ head: 100, prevScanTo: 0 }), "first-run");
  eq("a higher head is normal", classifyHead({ head: 200, prevScanTo: 100 }), "ok");
  eq("an equal head is normal", classifyHead({ head: 100, prevScanTo: 100 }), "ok");
  eq("a few blocks behind is endpoint lag", classifyHead({ head: 99, prevScanTo: 100, tolerance: 100 }), "lagging");
  eq("exactly at the tolerance is still lag", classifyHead({ head: 0, prevScanTo: 100, tolerance: 100 }), "lagging");
  eq("beyond the tolerance is an anomaly", classifyHead({ head: 0, prevScanTo: 101, tolerance: 100 }), "behind");
  eq("thousands of blocks behind is an anomaly", classifyHead({ head: 26000000, prevScanTo: 26046186, tolerance: 200 }), "behind");
}

console.log("\nscanTo never goes backwards");
{
  eq("a normal run advances it", nextScanTo(26046305, 26046186), 26046305);
  eq("a lagging head does not lower it", nextScanTo(26046000, 26046186), 26046186);
  eq("a first run takes the head", nextScanTo(26046305, 0), 26046305);
  eq("a huge rollback still does not lower it", nextScanTo(100, 26046186), 26046186);
}

console.log(`\n${pass} passed, ${fail} failed`);
await new Promise((resolve) => process.stdout.write("", resolve));
process.exit(fail === 0 ? 0 : 1);
