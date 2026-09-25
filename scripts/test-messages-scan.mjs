// Tests for lib/messages-scan.mjs.
//
// The watermark logic here fails SILENTLY when wrong: a resume point set too high skips blocks
// permanently, and the symptom is a slightly shorter message history — which looks exactly like
// a quiet chain. The runtime side already hit the sibling of this bug (a partial read reported as
// "covered", so the follower never advanced and never left "reading…"). These tests pin the
// build-time version of the same contract.
//
//   node scripts/test-messages-scan.mjs
import {
  scanRange,
  scanCeiling,
  nextScannedTo,
  mergeMessages,
  scanMessageRange,
  RESUME_MARGIN,
  COLD_START_CAP,
} from "../lib/messages-scan.mjs";

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

console.log("scanRange: conservative resume");
{
  // The dangerous case: a scan that failed partway leaves the watermark BELOW the newest
  // message. Resuming from the message would skip the blocks in between.
  const failedScan = scanRange({ head: 1_000_000, snapshotMaxBlock: 999_000, scannedTo: 950_000 });
  ok(
    "does NOT resume past a watermark that trails the newest message",
    failedScan.from === 950_000 - RESUME_MARGIN,
    `got ${failedScan.from}; resuming from the message (999,000) would skip ${999_000 - 950_000} blocks`
  );
  ok("...and the resume point is below the newest message", failedScan.from < 999_000);

  // The mirror case: a long quiet stretch makes the newest message very old. Resuming from it
  // would re-scan everything since, which is merely slow — but still the wrong mark to use.
  const quietChain = scanRange({ head: 1_000_000, snapshotMaxBlock: 400_000, scannedTo: 990_000 });
  ok("takes the lower of the two marks", quietChain.from === 400_000 - RESUME_MARGIN, `got ${quietChain.from}`);

  // Cold start with a snapshot but no watermark: cover the gap after the snapshot.
  const coldWithSnapshot = scanRange({ head: 1_000_000, snapshotMaxBlock: 900_000, scannedTo: null });
  ok("cold start with a snapshot resumes after it", coldWithSnapshot.from === 900_000 - RESUME_MARGIN, `got ${coldWithSnapshot.from}`);

  // Cold start with nothing at all.
  const coldEmpty = scanRange({ head: 1_000_000, snapshotMaxBlock: 0, scannedTo: null });
  ok("cold start with no snapshot is capped, not block 1", coldEmpty.from === 1_000_000 - COLD_START_CAP, `got ${coldEmpty.from}`);

  // Never below block 1.
  ok("never goes below block 1", scanRange({ head: 100, snapshotMaxBlock: 50, scannedTo: null, margin: 1000 }).from === 1);
  ok("ignores NaN marks", scanRange({ head: 1_000_000, snapshotMaxBlock: NaN, scannedTo: null }).from === 1_000_000 - COLD_START_CAP);
}

console.log("\nscanCeiling: one run cannot exceed the cap");
{
  const small = scanCeiling({ from: 1_000_000, head: 1_000_500 });
  ok("a small gap is not truncated", small.to === 1_000_500 && small.truncated === false);

  const huge = scanCeiling({ from: 1_000_000, head: 1_500_000 });
  ok("a gap larger than the cap is truncated below the head", huge.to === 1_000_000 + COLD_START_CAP - 1 && huge.truncated === true, `to=${huge.to}`);
  ok("...so the job stays bounded", huge.to - 1_000_000 + 1 === COLD_START_CAP);

  // The recovery property: after a truncated run the next one continues from the watermark.
  //
  // NOTE what min() does here: with both marks present it takes the LOWER, which in this fixture
  // is the snapshot's newest message (1,000,000), not the watermark (1,019,999). That is the
  // designed behaviour — err low and re-read — so the assertion is "it makes progress and never
  // resumes above either mark", not "the watermark wins".
  const first = scanCeiling({ from: 1_000_000, head: 1_500_000 });
  const wm = nextScannedTo({ previous: null, to: first.to, covered: true });
  ok("a truncated run publishes a watermark at the truncation point", wm === first.to);
  const second = scanRange({ head: 1_500_000, snapshotMaxBlock: 1_000_000, scannedTo: wm });
  ok("the next run resumes no higher than the lower mark", second.from <= Math.min(wm, 1_000_000));
  // And the pure-watermark case, where no snapshot message competes with it:
  const third = scanRange({ head: 1_500_000, snapshotMaxBlock: 0, scannedTo: wm });
  ok("with only a watermark, the next run continues just after it", third.from === wm - RESUME_MARGIN, `got ${third.from}`);
}

console.log("\nnextScannedTo: a partial scan must not advance");
{
  ok("advances when covered", nextScannedTo({ previous: 100, to: 200, covered: true }) === 200);
  ok(
    "does NOT advance when a block was missed",
    nextScannedTo({ previous: 100, to: 200, covered: false }) === 100,
    "advancing would make the missed blocks unrecoverable"
  );
  ok("takes the first watermark from null when covered", nextScannedTo({ previous: null, to: 200, covered: true }) === 200);
  ok("stays null when not covered and nothing was published", nextScannedTo({ previous: null, to: 200, covered: false }) === null);
  ok("never goes backwards", nextScannedTo({ previous: 500, to: 200, covered: true }) === 500);
}

console.log("\nmergeMessages: the snapshot is a tail, not a discardable copy");
{
  const snapshot = [
    { block: 900, tx: "0xaaa", text: "old" },
    { block: 800, tx: "0xbbb", text: "older" },
  ];
  const scanned = [
    { block: 1000, tx: "0xccc", text: "new" },
    { block: 900, tx: "0xaaa", text: "old" },
  ];
  const merged = mergeMessages(snapshot, scanned);
  ok("keeps the snapshot's older messages", merged.some((m) => m.tx === "0xbbb"));
  ok("adds the newly scanned ones", merged.some((m) => m.tx === "0xccc"));
  ok("de-duplicates by tx", merged.length === 3, `${merged.length} entries`);
  ok("sorts newest first", merged[0].tx === "0xccc" && merged[merged.length - 1].tx === "0xbbb", JSON.stringify(merged.map((m) => m.block)));

  // Two messages in one block must both survive: de-duplicating by block would drop one.
  const sameBlock = mergeMessages([{ block: 10, tx: "0x1", text: "a" }], [{ block: 10, tx: "0x2", text: "b" }]);
  ok("keeps two distinct messages from the same block", sameBlock.length === 2, `${sameBlock.length} entries`);
  ok("handles empty inputs", mergeMessages([], []).length === 0 && mergeMessages(null, null).length === 0);
}

console.log("\nscanMessageRange: reports coverage, never assumes it");
{
  // A stub rpc: every block answers, one carries a message.
  // The tx must be addressed TO the board AND its calldata must survive decodeMessage —
  // which rejects payloads under 4 bytes, non-printable bytes, and selector-shaped calls.
  // "hello world" as utf8 hex is a realistic message body.
  const BOARD = "0x200E710aCAA6A93bbc77146026328C40F1d60fB1";
  const HELLO = "0x68656c6c6f20776f726c64";
  const blockResult = (n) => ({
    number: "0x" + n.toString(16),
    timestamp: "0x" + (1_700_000_000 + n * 12).toString(16),
    transactions: n === 105 ? [{ hash: "0xmsg", from: "0xabc", to: BOARD, input: HELLO }] : [],
  });
  const rpc = {
    batch: async (reqs) =>
      reqs.map((r) => {
        const n = parseInt(r.params[0], 16);
        return { ok: true, result: blockResult(n) };
      }),
    call: async () => null,
  };

  const msgs = [];
  const messages = [];
  const res = await scanMessageRange({
    rpc,
    from: 100,
    to: 130,
    chunk: 25,
    log: (m) => msgs.push(m),
  });
  ok("reports progress", msgs.some((m) => /scanning .* chunks/.test(m)) && msgs.some((m) => /scanned/.test(m)));
  ok("a fully answered range is covered", res.covered === true, JSON.stringify(res.missed));
  ok("finds the message", res.messages.length === 1 && res.messages[0].block === 105, JSON.stringify(res.messages));
  ok("reports the chunk it used", res.chunk === 25);

  // An inverted range is covered (nothing was skipped), matching scanMessages' contract.
  const inverted = await scanMessageRange({ rpc, from: 500, to: 100 });
  ok("an inverted range is covered", inverted.covered === true && inverted.messages.length === 0);

  // A batch that drops entries must NOT be reported as covered.
  const lossy = {
    batch: async (reqs) =>
      reqs.map((r, i) => (i === 0 ? { ok: false, error: "response too large" } : { ok: true, result: blockResult(parseInt(r.params[0], 16)) })),
    call: async () => null,
  };
  const bad = await scanMessageRange({ rpc: lossy, from: 100, to: 199, chunk: 100 });
  ok("a dropped entry reports covered=false", bad.covered === false, `missed=${JSON.stringify(bad.missed)}`);
  ok("...and the missed block is named", bad.missed.length > 0);
  ok("...so the caller will not advance the watermark", nextScannedTo({ previous: 50, to: 199, covered: bad.covered }) === 50);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
