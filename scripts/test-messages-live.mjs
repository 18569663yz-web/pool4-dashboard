// Unit tests for lib/messages-live.js — the boundaries the live message read can get wrong.
//
//   node scripts/test-messages-live.mjs
//
// No network: every case is a hand-built block or a stubbed rpc, so the interesting paths (a
// partial batch, a reorg at the tip, a quiet channel) can be exercised deterministically. The one
// thing that IS taken from the chain is the fixture in `msgFixture`, which is a real block with a
// real message in it — a hand-written "0x68656c6c6f" would not prove the decoder accepts what
// Ethereum actually carries.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  messagesInBlock,
  scanMessages,
  mergeMessages,
  messageFreshness,
  nextWindow,
  MESSAGE_ADDRESS,
  FIRST_WINDOW,
  CHUNK,
} from "../lib/messages-live.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

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
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const BOARD = MESSAGE_ADDRESS;
const OTHER = "0x1111111111111111111111111111111111111111";
const DEV_A = "0x200e710acaa6a93bbc77146026328c40f1d60fb1";
const DEV_B = "0x047f606fd5b2baa5f5c6c4ab8958e45cb6b054b7";

const hex = (s) => "0x" + Buffer.from(s, "utf8").toString("hex");
const bnum = (n) => "0x" + n.toString(16);

/** A minimal block shaped like eth_getBlockByNumber(_, true). */
function mkBlock(n, ts, txs) {
  return { number: bnum(n), timestamp: bnum(ts), transactions: txs };
}
const mkTx = (from, to, input, hash) => ({ from, to, input, hash: hash || "0x" + "ab".repeat(32), value: "0x0" });

/* ------------------------------------------------------------------ *
 * 1. real chain fixture — the block that carries the message the user reported
 * ------------------------------------------------------------------ */
console.log("real chain fixture (a block that really contains a message)");
{
  const p = "D:/imd/_check/out/msg-fixture-blocks.json";
  if (!existsSync(p)) {
    console.log(`  skip — ${p} not present (run: node scripts/verify-messages-live.mjs --json ${p})`);
  } else {
    const blocks = JSON.parse(readFileSync(p, "utf8"));
    const all = blocks.flatMap((b) => messagesInBlock(b));
    /* The blocks were captured BECAUSE they contain one message each, so a regression that stops
     * seeing them is exactly what this asserts against. */
    ok(`the decoder finds the real messages in ${blocks.length} real blocks`, all.length >= 2, `found ${all.length}`);
    const dev = all.find((m) => m.block === 26051777);
    ok("the dev's self-send at block 26051777 decodes", !!dev, "not found");
    if (dev) {
      ok("it is classified as from-dev", dev.isDev === true);
      ok("it is classified as a self-send", dev.selfSend === true);
      ok("its text is readable English", /Fixed a ton of bugs today/.test(dev.text), dev.text.slice(0, 60));
      ok("its timestamp is the block's timestamp", dev.ts === parseInt(blocks.find((b) => parseInt(b.number, 16) === 26051777).timestamp, 16));
    }
    const comm = all.find((m) => m.block === 26051766);
    ok("the community message at block 26051766 decodes and is NOT from-dev", !!comm && comm.isDev === false, JSON.stringify(comm && comm.isDev));
  }
}

/* ------------------------------------------------------------------ *
 * 2. messagesInBlock — what counts as a message
 * ------------------------------------------------------------------ */
console.log("\nmessagesInBlock: what counts as a message");
{
  const b = mkBlock(100, 1700000000, [
    mkTx(DEV_A, BOARD, hex("a self send announcement")),           // from dev, to board
    mkTx(OTHER, BOARD, hex("a community message to the board")),   // community, to board
    mkTx(OTHER, OTHER, hex("not addressed to the board")),         // irrelevant
    mkTx(OTHER, BOARD, "0x"),                                      // plain transfer, no calldata
    mkTx(OTHER, BOARD, "0x1234"),                                  // too short to be text
  ]);
  const got = messagesInBlock(b);
  eq("only the two real messages are kept", got.length, 2);
  ok("a plain value transfer is not a message", !got.some((m) => m.text === ""), JSON.stringify(got.map((m) => m.text)));
  ok("a 2-byte payload is not a message", !got.some((m) => m.text.length < 4));

  /* The `from` direction is the half a `to`-only filter silently loses, and testing it with a
   * self-send is NOT sufficient: in a self-send `to` is the board as well, so a to-only filter matches
   * it anyway and the test passes for the wrong reason. (Found by mutation testing: dropping the
   * `from` check left the whole suite green.) The case that actually distinguishes them is the dev
   * posting FROM the board TO some other address — which is how several of the snapshot's `important`
   * announcements were made (e.g. block 26014070, the staking renounce). */
  const selfBlock = mkBlock(101, 1700000001, [mkTx(BOARD, BOARD, hex("posted by the board itself"))]);
  eq("a self-send from the board IS a message", messagesInBlock(selfBlock).length, 1);

  const outbound = mkBlock(1011, 1700000011, [mkTx(BOARD, "0x9999999999999999999999999999999999999999", hex("announcement sent from the board elsewhere"))]);
  eq("a message SENT FROM the board to another address is a message (the case a to-only filter drops)", messagesInBlock(outbound).length, 1);
  ok("...and it is classified as from-dev", messagesInBlock(outbound)[0].isDev === true);
  ok("...and it is not a self-send", messagesInBlock(outbound)[0].selfSend === false);

  const devSendBlock = mkBlock(102, 1700000002, [mkTx(DEV_B, BOARD, hex("owner EOA announcement"))]);
  const d = messagesInBlock(devSendBlock);
  eq("the owner EOA posting to the board is a message", d.length, 1);
  ok("and it is classified from-dev", d[0] && d[0].isDev === true);

  /* A community member sending FROM the board's address is not a thing (they do not control it), but a
   * message sent from an unrelated address to an unrelated address must stay out. */
  const unrelated = mkBlock(1012, 1700000012, [mkTx(OTHER, "0x8888888888888888888888888888888888888888", hex("nothing to do with the board"))]);
  eq("a transfer touching neither side of the board is not a message", messagesInBlock(unrelated).length, 0);

  const noSelfSend = mkBlock(103, 1700000003, [mkTx(OTHER, BOARD, hex("hello board"))]);
  ok("a community message is a self-send only when from==to", messagesInBlock(noSelfSend)[0].selfSend === false);

  eq("a block with no transactions yields nothing", messagesInBlock(mkBlock(104, 1, [])).length, 0);
  eq("a malformed block yields nothing", messagesInBlock(null).length, 0);
  eq("a block whose transactions are not an array yields nothing", messagesInBlock({ number: "0x1", timestamp: "0x1" }).length, 0);

  /* Case-insensitivity: the same address arrives in different cases from different nodes, and an
   * exact-string comparison would drop real messages depending on which endpoint answered. */
  const mixed = mkBlock(105, 1700000005, [mkTx("0x200E710aCAA6A93bbc77146026328C40F1d60fB1", BOARD, hex("case test"))]);
  eq("address matching is case-insensitive", messagesInBlock(mixed).length, 1);
}

/* ------------------------------------------------------------------ *
 * 3. scanMessages — batching, and what happens when a chunk does not answer
 * ------------------------------------------------------------------ */
console.log("\nscanMessages: batching and failure");
{
  /* The chunk size is load-bearing and was wrong once, so it is pinned here.
   *
   * The endpoint refuses a full-transaction batch past a size limit it reports PER ITEM as "response
   * too large" — not as a thrown error. At chunk 100 with full transactions, 46 of 100 blocks came back
   * rejected, `covered` went false, and the watermark froze: the page read the chain every 30 seconds
   * forever and never showed a thing. Node's fetch tolerated chunk 100 where the browser did not, so
   * only a browser run exposed it.
   *
   * The assertion is a ceiling rather than an equality because lowering it is always safe; raising it
   * back to 100 is what must fail. */
  ok(`the batch chunk stays small enough for full-transaction payloads (CHUNK=${CHUNK})`, CHUNK <= 60, `CHUNK=${CHUNK} — a 100-block full-tx batch is rejected per item by the public endpoint`);

  /* A stub rpc that answers eth_getBlockByNumber out of a map, and can be told to fail specific
   * blocks — that is the only way to test the partial-failure path without breaking the network.
   * `call` is provided as a single-block version of the same map, because the retry pass uses it. */
  const mkRpc = (maxBlock, { failBlocks = new Set(), throwOn = null, partial = false } = {}) => ({
    calls: 0,
    batches: 0,
    async batch(reqs) {
      this.batches++;
      if (throwOn && reqs.some((r) => parseInt(r.params[0], 16) >= throwOn)) throw new Error("endpoint said no");
      return reqs.map((r) => {
        const n = parseInt(r.params[0], 16);
        this.calls++;
        if (failBlocks.has(n)) return { ok: false, error: "block unavailable" };
        if (n > maxBlock) return { ok: true, result: null };
        return { ok: true, result: mkBlock(n, 1700000000 + n, n === 50 ? [mkTx(DEV_A, BOARD, hex("msg at 50"))] : []) };
      });
    },
    async call(method, params) {
      const n = parseInt(params[0], 16);
      if (failBlocks.has(n) || n > maxBlock) throw new Error("block unavailable");
      return mkBlock(n, 1700000000 + n, n === 50 ? [mkTx(DEV_A, BOARD, hex("msg at 50"))] : []);
    },
  });

  {
    const rpc = mkRpc(1000);
    const r = await scanMessages({ rpc, from: 1, to: 250, chunk: 100 });
    ok("250 blocks in 3 batch calls, not 250 requests", r.batchCalls === 3, `${r.batchCalls}`);
    ok("a clean scan reports covered=true", r.covered === true);
    eq("no missed ranges on a clean scan", r.missed.length, 0);
    eq("the message inside the range was found", r.messages.length, 1);
    eq("and attributed to the right block", r.messages[0].block, 50);
  }

  {
    /* The straggler retry, and the reason it exists.
     *
     * A public endpoint rejects too-large batches PER ITEM: HTTP 200, with individual entries marked
     * `{ok:false, error:"response too large"}`. Treating those as permanently missed froze the
     * follower's watermark — it re-read the same window every 30 seconds and never progressed, and the
     * page never left "reading…". So a dropped entry must be asked for AGAIN, singly, before it is
     * recorded as a hole. */
    const flakyOnce = (() => {
      const seen = new Map();
      const rpc = {
        async batch(reqs) {
          return reqs.map((r) => {
            const n = parseInt(r.params[0], 16);
            /* Block 202 fails in the batch but is served on a single call — the exact shape of a size
             * rejection, which is per-request-size and not per-block. */
            if (n === 202) return { ok: false, error: "response too large" };
            return { ok: true, result: mkBlock(n, 1700000000, []) };
          });
        },
        async call(method, params) {
          const n = parseInt(params[0], 16);
          seen.set(n, (seen.get(n) || 0) + 1);
          return mkBlock(n, 1700000000, []);
        },
        singles: seen,
      };
      return rpc;
    })();
    const r = await scanMessages({ rpc: flakyOnce, from: 201, to: 205, chunk: 5 });
    ok("a single dropped entry is re-requested", flakyOnce.singles.get(202) === 1, `singles: ${[...flakyOnce.singles]}`);
    ok("...and the range becomes fully covered once it answers", r.covered === true, JSON.stringify(r.missed));
    eq("no hole is reported", r.missed.length, 0);
    ok("the retry is counted", r.blockRetries === 1, String(r.blockRetries));
  }

  {
    /* A block that never answers stays a hole. The retry must not turn "unreadable" into "read". */
    const never = {
      async batch(reqs) {
        return reqs.map((r) => (parseInt(r.params[0], 16) === 202 ? { ok: false, error: "nope" } : { ok: true, result: mkBlock(parseInt(r.params[0], 16), 1, []) }));
      },
      async call() {
        throw new Error("still broken");
      },
    };
    const r = await scanMessages({ rpc: never, from: 201, to: 205, chunk: 5 });
    ok("a block that never answers stays a hole", r.covered === false && r.missed.length === 1 && r.missed[0].from === 202, JSON.stringify(r.missed));
    ok("it was still retried", r.blockRetries >= 1, String(r.blockRetries));
  }

  {
    /* A whole chunk failing is an outage, not a size rejection: retrying 25 blocks individually would
     * spend 25 requests confirming what one response already said. */
    let singleCalls = 0;
    const allBad = {
      async batch(reqs) {
        return reqs.map(() => ({ ok: false, error: "endpoint down" }));
      },
      async call() {
        singleCalls++;
        throw new Error("down");
      },
    };
    const r = await scanMessages({ rpc: allBad, from: 1, to: 25, chunk: 25 });
    eq("a fully failed chunk is not retried block by block", singleCalls, 0);
    ok("and is recorded as one contiguous hole", r.missed.length === 1 && r.missed[0].from === 1 && r.missed[0].to === 25, JSON.stringify(r.missed));
  }

  {
    /* A message recovered by a retry must reach the caller's message list, not just flip `covered`. */
    const withMsg = {
      async batch(reqs) {
        return reqs.map((r) => (parseInt(r.params[0], 16) === 7 ? { ok: false, error: "response too large" } : { ok: true, result: mkBlock(parseInt(r.params[0], 16), 1700000000, []) }));
      },
      async call(method, params) {
        const n = parseInt(params[0], 16);
        return mkBlock(n, 1700000000 + n, [mkTx(DEV_A, BOARD, hex("recovered by retry"))]);
      },
    };
    const r = await scanMessages({ rpc: withMsg, from: 5, to: 9, chunk: 5 });
    ok("a message found on retry is returned to the caller", r.messages.length === 1 && r.messages[0].block === 7, JSON.stringify(r.messages.map((m) => m.block)));
    ok("its text decoded correctly", r.messages[0] && r.messages[0].text === "recovered by retry");
  }

  {
    const rpc = mkRpc(1000, { failBlocks: new Set([150]) });
    const r = await scanMessages({ rpc, from: 1, to: 250, chunk: 100 });
    /* THE central guarantee: one unavailable block in the middle must not be reported as "read the
     * whole range and found nothing". That is the bug class this module was written to avoid. */
    ok("a single unavailable block makes covered=false", r.covered === false, "partial read was reported as complete");
    eq("the hole is named", r.missed.length, 1);
    eq("and it points at the right block", r.missed[0].from, 150);
    ok("the rest of the range is still reported as covered", r.ranges.length >= 1, JSON.stringify(r.ranges));
  }

  {
    const rpc = mkRpc(1000, { throwOn: 150 });
    const r = await scanMessages({ rpc, from: 1, to: 250, chunk: 100 });
    /* The stub throws for ANY chunk reaching block 150, so chunks 101-200 and 201-250 both fail and
     * only 1-100 answers. That is the intended shape of an outage: contiguous, and reported with the
     * full extent rather than one entry per block. */
    eq("throwing chunks are recorded as contiguous ranges", r.missed.length, 2);
    eq("the first hole is named with its whole extent", [r.missed[0].from, r.missed[0].to], [101, 200]);
    ok("the error text is preserved", /endpoint said no/.test(r.missed[0].error), r.missed[0].error);
    ok("the untouched chunk is still reported as covered", r.ranges.length === 1 && r.ranges[0].from === 1 && r.ranges[0].to === 100, JSON.stringify(r.ranges));
    /* Block 50 — the one carrying a message — sits in the chunk that DID answer, so its message
     * survives even though the rest of the range is a hole. A reader keeps what was actually read. */
    ok("a message from the successful chunk is still returned", r.covered === false && r.messages.length === 1 && r.messages[0].block === 50, JSON.stringify(r.messages));
  }

  {
    /* A node that lags: blocks above its head come back as null. Reading those as "no messages"
     * would advance a watermark past blocks that were never seen. */
    const rpc = mkRpc(100, {});
    const r = await scanMessages({ rpc, from: 90, to: 120, chunk: 100 });
    ok("blocks a lagging node cannot serve make covered=false", r.covered === false, "a lagging endpoint was treated as an empty range");
    eq("every unserved block is listed", r.missed.length, 20);
  }

  {
    const rpc = mkRpc(1000);
    const r = await scanMessages({ rpc, from: 500, to: 400, chunk: 100 });
    /* head BEHIND the resume point: nothing to do, and no request should be made. This is reported
     * as COVERED — an empty range skipped nothing, and a follower that treated it as a hole would
     * never advance past it. */
    eq("an inverted range issues no requests", r.batchCalls, 0);
    eq("and returns no messages", r.messages.length, 0);
    ok("and is reported as covered (it skipped nothing)", r.covered === true, "an empty range was reported as a hole, which would stall a follower");
  }

  {
    /* Response/request misalignment: the block number is checked against the number ASKED FOR, so a
     * transport that returns blocks out of order cannot misattribute a message to the wrong height.
     * Here every reply names the next block up, so all three are rejected and the range collapses to
     * a single contiguous hole. */
    const lying = {
      async batch(reqs) {
        return reqs.map((r, i) => ({ ok: true, result: mkBlock(parseInt(r.params[0], 16) + 1, 1700000000, []) }));
      },
    };
    const r = await scanMessages({ rpc: lying, from: 10, to: 12, chunk: 100 });
    ok("a response for the wrong block number is rejected, not trusted", r.covered === false, "misaligned responses were accepted");
    eq("the rejected range is recorded as one hole", r.missed.length, 1);
    eq("...covering every block that failed", [r.missed[0].from, r.missed[0].to], [10, 12]);
    eq("no message was attributed to a wrong block", r.messages.length, 0);
  }
}

/* ------------------------------------------------------------------ *
 * 4. mergeMessages — the overlap rule
 * ------------------------------------------------------------------ */
console.log("\nmergeMessages: the overlap rule");
{
  const snap = {
    fetchedAt: "2026-09-24T19:11:13.998Z",
    messages: [
      { block: 300, ts: 1000, tx: "0xs3", from: DEV_A, to: DEV_A, selfSend: true, isDev: true, important: "快照里的中文批注", text: "snapshot text 300" },
      { block: 200, ts: 900, tx: "0xs2", from: OTHER, to: BOARD, selfSend: false, isDev: false, important: null, text: "snapshot text 200" },
    ],
  };
  const live = [
    { block: 400, ts: 1100, tx: "0xl4", from: DEV_A, to: DEV_A, selfSend: true, isDev: true, important: null, text: "live text 400" },
    // block 300 ALSO appears live — the exchange rate case. Its annotation exists only in the snapshot.
    { block: 300, ts: 1001, tx: "0xl3", from: DEV_A, to: DEV_A, selfSend: true, isDev: true, important: null, text: "live text 300" },
  ];
  const m = mergeMessages({ snapshot: snap, live });

  eq("live + snapshot de-duplicated by block", m.messages.length, 3);
  eq("newest first", m.messages.map((x) => x.block), [400, 300, 200]);
  eq("overlap is counted", m.overlap, 1);
  eq("live blocks are tracked", [...m.liveBlocks].sort((a, b) => a - b), [300, 400]);
  eq("a live-only message is marked live", m.messages[0].source, "live");
  eq("a snapshot-only message is marked snapshot", m.messages[2].source, "snapshot");

  /* THE rule this merge exists for. */
  const over = m.messages.find((x) => x.block === 300);
  eq("the overlapping message takes the FRESH text from the chain", over.text, "live text 300");
  eq("...while keeping the snapshot's hand-written annotation", over.important, "快照里的中文批注");
  eq("...and stays marked as live", over.source, "live");

  const annotated = m.messages.filter((x) => x.important).length;
  eq("no annotation is lost by merging", annotated, 1);

  /* Two messages in ONE block are two messages. Collapsing on block would silently delete one. */
  const dup = mergeMessages({
    snapshot: { messages: [] },
    live: [
      { block: 500, ts: 1, tx: "0xa", from: DEV_A, to: BOARD, isDev: true, important: null, text: "first" },
    ],
  });
  eq("a single live message passes through", dup.messages.length, 1);

  /* Degenerate inputs must not throw — the page calls this on every load, including when the
   * snapshot fetch failed and the chain is unreachable, and a throw there blanks the section. */
  eq("no snapshot at all is tolerated", mergeMessages({ snapshot: null, live: [{ block: 1, ts: 1, tx: "0x1", from: DEV_A, to: BOARD, isDev: true, important: null, text: "x" }] }).messages.length, 1);
  eq("no live messages is tolerated", mergeMessages({ snapshot: snap, live: [] }).messages.length, 2);
  eq("both empty is tolerated", mergeMessages({ snapshot: null, live: [] }).messages.length, 0);
  eq("junk live entries are skipped", mergeMessages({ snapshot: null, live: [null, { block: "nope" }, { block: 7, ts: 1, tx: "0x7", from: OTHER, to: BOARD, isDev: false, important: null, text: "ok" }] }).messages.length, 1);
}

/* ------------------------------------------------------------------ *
 * 5. nextWindow — the incremental tick
 * ------------------------------------------------------------------ */
console.log("\nnextWindow: the incremental tick");
{
  const first = nextWindow({ head: 100000, lastSeen: null });
  eq("the first window is bounded, not 'since genesis'", first.to - first.from + 1, FIRST_WINDOW);
  eq("the first window ends at head", first.to, 100000);
  eq("the first window is FIRST_WINDOW blocks", first.from, 100000 - FIRST_WINDOW + 1);

  const inc = nextWindow({ head: 100010, lastSeen: 100000 });
  eq("the incremental window starts just after what was read", inc.from, 99996);
  eq("...and ends at head", inc.to, 100010);
  ok("the incremental window is tiny", inc.to - inc.from + 1 <= 15);

  /* head moving BACKWARDS (endpoint lag / reorg) must not create a gap. */
  const back = nextWindow({ head: 99990, lastSeen: 100000 });
  ok("a head behind the watermark still re-reads a margin", back.from < 100000 && back.to === 99990, JSON.stringify(back));

  const same = nextWindow({ head: 100000, lastSeen: 100000 });
  ok("an unchanged head re-reads only the reorg margin", same.to - same.from + 1 <= 6, JSON.stringify(same));

  eq("the window never goes below block 1", nextWindow({ head: 3, lastSeen: null }).from, 1);
  ok("a custom window size is honoured", (() => { const w = nextWindow({ head: 5000, lastSeen: null, firstWindow: 50 }); return w.to - w.from + 1 === 50; })());
}

/* ------------------------------------------------------------------ *
 * 6. messageFreshness — what the page is allowed to claim
 * ------------------------------------------------------------------ */
console.log("\nmessageFreshness: no invented freshness");
{
  const snapshot = { fetchedAt: "2026-09-24T19:11:13.998Z", messages: [{ block: 300, ts: 1000, source: "snapshot" }] };
  const merged = { messages: [{ block: 400, ts: 2000, source: "live" }, { block: 300, ts: 1000, source: "snapshot" }] };
  const f = messageFreshness({ merged, snapshot, liveHead: 400, liveReadAt: 5, now: 2000 * 1000 + 3600 * 1000 });

  eq("the newest block is reported", f.newestBlock, 400);
  eq("its source is reported", f.newestSource, "live");
  eq("liveIsAhead is true when the chain surfaced something newer", f.liveIsAhead, true);
  eq("the live head is reported", f.liveHead, 400);
  /* snapshotTimestamp handles both the ISO string and the numeric form; reusing it is deliberate
   * (a second date parser is how this project already produced one wrong timestamp). */
  eq("the snapshot's ISO timestamp is parsed", f.snapshotAsOf, Date.parse("2026-09-24T19:11:13.998Z"));
  eq("the snapshot's newest block is reported separately", f.snapshotNewestBlock, 300);
  eq("the newest message's age is honest", Math.round(f.newestAgeHours), 1);

  const noLive = messageFreshness({ merged: { messages: [{ block: 300, ts: 1000, source: "snapshot" }] }, snapshot, liveHead: null, liveReadAt: null, now: 1000 * 1000 });
  eq("with no live read, liveIsAhead is false", noLive.liveIsAhead, false);
  eq("and liveHead is null, not a fabricated number", noLive.liveHead, null);

  const empty = messageFreshness({ merged: { messages: [] }, snapshot: null, liveHead: null, liveReadAt: null });
  eq("an empty merged list reports no newest blocks", [empty.newestBlock, empty.newestTs, empty.newestAgeHours, empty.snapshotNewestBlock], [null, null, null, null]);

  /* The case the old page got wrong: the MESSAGE is old but the FILE is fresh. A dashboard that
   * reports the file's age as the message's age claims a freshness it did not verify. */
  const oldMsgNewFile = messageFreshness({
    merged: { messages: [{ block: 1, ts: 100, source: "snapshot" }] },
    snapshot: { fetchedAt: new Date().toISOString(), messages: [{ block: 1, ts: 100, source: "snapshot" }] },
    liveHead: 999,
    liveReadAt: Date.now(),
    now: Date.now(),
  });
  ok("a fresh file with an old message still reports the MESSAGE's age", oldMsgNewFile.newestAgeHours > 100, String(oldMsgNewFile.newestAgeHours));

  const numeric = messageFreshness({ merged: { messages: [] }, snapshot: { builtAt: 1700000000000, messages: [] }, liveHead: null, liveReadAt: null });
  ok("a numeric (ms) snapshot timestamp is accepted without a second parser", numeric.snapshotAsOf === 1700000000000, String(numeric.snapshotAsOf));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
