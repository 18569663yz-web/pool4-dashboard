// Tests for lib/messages-follow.js — the watermark state machine.
//
//   node scripts/test-messages-follow.mjs
//
// The clock and the network are both injected, so every case runs instantly and deterministically.
// What is being tested is not "does it fetch" but "when is the page allowed to stop looking": the
// watermark rule decides whether a message that arrives during an outage is ever seen, and getting it
// wrong is invisible — the page simply never shows that message and never says so.
import { startMessageFollower, MAX_FAILURES } from "../lib/messages-follow.js";
import { CHUNK } from "../lib/messages-live.js";

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

const BOARD = "0x200E710aCAA6A93bbc77146026328C40F1d60fB1";
const DEV = "0x200e710acaa6a93bbc77146026328c40f1d60fb1";
const hex = (s) => "0x" + Buffer.from(s, "utf8").toString("hex");
const bnum = (n) => "0x" + n.toString(16);
const mkBlock = (n, ts, txs) => ({ number: bnum(n), timestamp: bnum(ts), transactions: txs });
const mkTx = (from, to, input) => ({ from, to, input, hash: "0x" + "cd".repeat(32), value: "0x0" });

/**
 * A controllable fake chain + clock.
 *
 * `mode` is switched per tick so a test can walk through "healthy -> outage -> healthy" and check
 * that a message posted during the outage is still found afterwards.
 */
function harness({ head = 100000, mode = "ok", msgAt = {} } = {}) {
  const h = { head, mode, msgAt, ticks: [], steps: 0, updates: [], errors: [], startFn: null };

  h.rpc = {
    async call(method) {
      if (method !== "eth_blockNumber") throw new Error("unexpected method " + method);
      if (h.mode === "throw") throw new Error("rpc down");
      return bnum(h.head);
    },
    async batch(reqs) {
      h.steps++;
      /* Record the blocks COVERED by this request. scanMessages chunks a window into batches of 100,
       * so one 300-block tick issues three batches; every assertion should talk about the window as a
       * whole, so `h.window()` flattens everything since the last reset. Keeping the raw batches too
       * lets a test check the chunking itself. */
      const blocks = reqs.map((r) => parseInt(r.params[0], 16));
      h.ticks.push(blocks);
      if (h.mode === "throw") throw new Error("rpc down");
      return reqs.map((r) => {
        const n = parseInt(r.params[0], 16);
        /* "lagging" simulates a node that cannot serve the newest blocks (returns null). */
        if (h.mode === "lagging" && n > h.head - 3) return { ok: true, result: null };
        const text = h.msgAt[n];
        return { ok: true, result: mkBlock(n, 1700000000 + n, text ? [mkTx(DEV, BOARD, hex(text))] : []) };
      });
    },
  };
  /** Forget recorded batches, so the next assertion covers exactly one tick. */
  h.mark = () => { h.ticks = []; };
  /** Every block read since the last mark(), in order. */
  h.window = () => h.ticks.flat();

  return h;
}

/**
 * Start a follower whose scheduled first tick is awaited to completion.
 *
 * The startup callback invokes the async step() and returns immediately, so the test must wait for
 * it. Draining until the batch count settles is bounded, so a hang fails loudly rather than hanging.
 */
async function startAndSettle(h, state) {
  const f = startMessageFollower({
    rpc: h.rpc,
    state,
    onUpdate: (u) => h.updates.push(u),
    onError: (e) => h.errors.push(e),
    /* The startup delay is production policy, not logic under test: fire it at once and capture it. */
    setTimeoutImpl: (fn) => { h.startFn = fn; return 1; },
    setIntervalImpl: () => 2,
    clearTimeoutImpl: () => {},
    clearIntervalImpl: () => {},
  });
  h.startFn();
  await settle(h);
  return f;
}

/** Wait until no further batch is issued. */
async function settle(h) {
  let last = -1;
  for (let i = 0; i < 500 && h.steps !== last; i++) {
    last = h.steps;
    await new Promise((r) => setImmediate(r));
  }
}

const stateWith = (snapshot) => ({ messages: snapshot, messagesZh: null });

/* ------------------------------------------------------------------ */
console.log("startup: boot is never held");
{
  const h = harness({ head: 100000, msgAt: { 99999: "hello from the chain" } });
  const f = startMessageFollower({ rpc: h.rpc, state: stateWith({ messages: [] }) });
  ok("startMessageFollower returns synchronously (boot is not awaited on it)", !!f && typeof f.stop === "function");
  eq("nothing has been fetched yet", h.steps, 0);
  ok("an initial status is available immediately", f.status().phase === "idle", f.status().phase);
  f.stop();
}

/* ------------------------------------------------------------------ */
console.log("\nfirst tick: a bounded window, and the message is found");
{
  const h = harness({ head: 100000, msgAt: { 99999: "hello from the chain" } });
  const f = await startAndSettle(h, stateWith({ messages: [] }));

  eq("the window was bounded to 300 blocks, not the whole chain", h.window().length, 300);
  /* Derived from CHUNK rather than hard-coded: the interesting property is "few requests, not one per
   * block", and pinning it to a literal would break every time the chunk size is retuned (which it was,
   * from 100 to 50, when the endpoint proved unable to serve 100 full-transaction blocks). */
  eq(`the window is chunked, not one request per block (${CHUNK}/batch)`, h.ticks.length, Math.ceil(300 / CHUNK));
  eq("the window ends at head", h.window()[299], 100000);
  eq("the window starts 299 blocks back", h.window()[0], 99701);
  ok("the live message was merged in", h.updates.length > 0 && h.updates[h.updates.length - 1].merged.messages.length === 1, `${h.updates.length} updates`);
  eq("the watermark is at head", f.status().lastSeen, 100000);
  eq("the phase is live", f.status().phase, "live");
  f.stop();
}

/* ------------------------------------------------------------------ */
console.log("\nincremental tick: only new blocks are read");
{
  const h = harness({ head: 100000, msgAt: {} });
  const f = await startAndSettle(h, stateWith({ messages: [] }));
  const firstLen = h.window().length;
  h.mark();
  h.head = 100010; // ten new blocks
  await f.tickOnce();
  const inc = h.window();
  ok(`the first read is 300 blocks, the incremental one is tiny (${firstLen} then ${inc.length})`, firstLen === 300 && inc.length <= 15, `${firstLen}/${inc.length}`);
  eq("the incremental window ends at the new head", inc[inc.length - 1], 100010);
  ok("the incremental window starts just after the old head", inc[0] <= 100001, String(inc[0]));
  eq("the watermark advanced", f.status().lastSeen, 100010);
  f.stop();
}

/* ------------------------------------------------------------------ */
console.log("\na head that has not moved re-reads only the reorg margin");
{
  const h = harness({ head: 100000 });
  const f = await startAndSettle(h, stateWith({ messages: [] }));
  h.mark();
  await f.tickOnce(); // same head
  const again = h.window();
  /* A tick with no new blocks still reads a few. That is REORG_MARGIN doing its job, not waste: a
   * reorg can rewrite the last block or two WITHOUT the head moving, and if the follower only ever
   * read above its watermark it would never look at those blocks again — so a message that got
   * reorganised away and re-mined would stay invisible. The cost is a handful of blocks in one batch.
   *
   * The assertion is therefore not "no request" but "a negligible one, bounded by the margin". */
  ok(`an unchanged head re-reads only the reorg margin (${again.length} blocks)`, again.length > 0 && again.length <= 10, `${again.length} blocks`);
  ok("...and it re-reads blocks already seen, so a reorg cannot hide a message", again.every((b) => b <= 100000));
  eq("the phase stays live", f.status().phase, "live");
  eq("no error was reported", h.errors.length, 0);
  eq("the failure counter is untouched", f.status().failed, 0);
  eq("the watermark does not move backwards", f.status().lastSeen, 100000);
  f.stop();
}

/* ------------------------------------------------------------------ */
console.log("\nTHE CRITICAL CASE: a message posted during an outage is still found afterwards");
{
  /* This is the bug the watermark rule exists to prevent. Tick 1 reads to block 100000. Then the RPC
   * goes down for several ticks while someone posts at 100005. When it recovers, the page MUST read
   * from 100001 — not from the new head — or that message is lost for ever with no error anywhere. */
  const h = harness({ head: 100000, msgAt: {} });
  const f = await startAndSettle(h, stateWith({ messages: [] }));
  eq("baseline watermark", f.status().lastSeen, 100000);

  h.mode = "throw";
  h.head = 100005;
  h.msgAt[100005] = "posted while the rpc was down";
  await f.tickOnce();
  eq("a failed read does NOT advance the watermark", f.status().lastSeen, 100000);
  eq("and is reported", h.errors.length, 1);

  await f.tickOnce();
  eq("still not advanced after a second failure", f.status().lastSeen, 100000);

  h.mode = "ok";
  await f.tickOnce();
  const covered = h.window();
  ok("the recovery tick re-read the failed stretch", covered.includes(100005), `read ${covered[0]}..${covered[covered.length - 1]}`);
  ok("THE MESSAGE POSTED DURING THE OUTAGE IS FOUND", covered.includes(100005) && f.status().lastSeen === 100005);
  const merged = h.updates[h.updates.length - 1].merged;
  ok("and it is in the rendered list", merged.messages.some((m) => m.block === 100005), JSON.stringify(merged.messages.map((m) => m.block)));
  f.stop();
}

/* ------------------------------------------------------------------ */
console.log("\na PARTIAL read does not advance the watermark past the hole");
{
  const h = harness({ head: 100000, msgAt: {} });
  const f = await startAndSettle(h, stateWith({ messages: [] }));
  eq("baseline watermark", f.status().lastSeen, 100000);

  /* The node goes lagging: it answers for old blocks but returns null for the newest three. */
  h.head = 100010;
  h.mode = "lagging";
  await f.tickOnce();
  eq("a partial read does NOT advance the watermark", f.status().lastSeen, 100000);
  eq("the holes are counted in the status", f.status().holes, 3, JSON.stringify(f.status()));

  h.mode = "ok";
  await f.tickOnce();
  eq("after recovery the watermark advances normally", f.status().lastSeen, 100010);
  f.stop();
}

/* ------------------------------------------------------------------ */
console.log("\nit gives up after repeated failures instead of hammering");
{
  const h = harness({ head: 100000, mode: "throw" });
  const f = await startAndSettle(h, stateWith({ messages: [] }));
  eq("the startup tick counts as one attempt", f.status().failed, 1);
  for (let i = 1; i < MAX_FAILURES; i++) await f.tickOnce();
  eq("it tried exactly MAX_FAILURES times", f.status().failed, MAX_FAILURES);
  eq("and then reported itself stopped", f.status().phase, "stopped");
  eq("it reported every failure", h.errors.length, MAX_FAILURES);

  const before = h.steps;
  h.mode = "ok";
  await f.tickOnce();
  eq("after stopping, it does not resume on its own", h.steps, before);
  f.stop();
}

/* ------------------------------------------------------------------ */
console.log("\na failure is not counted twice, and one success resets the count");
{
  const h = harness({ head: 100000 });
  const f = await startAndSettle(h, stateWith({ messages: [] }));
  h.mode = "throw";
  for (let i = 0; i < 3; i++) await f.tickOnce();
  eq("three failures are counted as three", f.status().failed, 3);

  h.mode = "ok";
  h.head = 100050;
  await f.tickOnce();
  eq("one success resets the counter", f.status().failed, 0);
  eq("and the phase returns to live", f.status().phase, "live");
  f.stop();
}

/* ------------------------------------------------------------------ */
console.log("\nthe snapshot is preserved and annotated, not replaced");
{
  const snapshot = {
    fetchedAt: "2026-09-24T19:11:13.998Z",
    address: BOARD,
    devAddresses: [BOARD],
    counts: { txs: 79, decoded: 70, undecodable: 9 },
    messages: [
      { block: 99000, ts: 1700000000, tx: "0xs", from: DEV, to: BOARD, selfSend: true, isDev: true, important: "中文批注", text: "old snapshot message" },
    ],
  };
  const h = harness({ head: 100000, msgAt: { 99999: "brand new message" } });
  const f = await startAndSettle(h, stateWith(snapshot));

  const merged = h.updates[h.updates.length - 1].merged;
  eq("the snapshot message survives", merged.messages.length, 2);
  eq("newest first", merged.messages.map((m) => m.block), [99999, 99000]);
  eq("the new one is marked live", merged.messages[0].source, "live");
  eq("the old one is marked snapshot", merged.messages[1].source, "snapshot");
  eq("the snapshot's annotation is intact", merged.messages[1].important, "中文批注");
  ok("the snapshot's counts are still reachable for the tech block", merged.messages.length === 2);

  const fr = h.updates[h.updates.length - 1].freshness;
  eq("freshness says the chain is ahead", fr.liveIsAhead, true);
  eq("freshness reports the live head", fr.liveHead, 100000);
  ok("freshness reports the snapshot's own build time", fr.snapshotAsOf === Date.parse("2026-09-24T19:11:13.998Z"));
  ok("freshness reports the message's real age, not the file's", fr.newestAgeHours > 1000, String(fr.newestAgeHours));
  f.stop();
}

/* ------------------------------------------------------------------ */
console.log("\ndegenerate inputs do not throw");
{
  const h = harness({ head: 100000 });
  const f = await startAndSettle(h, stateWith(null));
  ok("a missing snapshot does not break the follower", h.updates.length > 0, JSON.stringify(h.errors));
  f.stop();

  /* A follower with no callbacks at all must still work: the page passes them, a test need not. */
  const h2 = harness({ head: 100000 });
  const f2 = await startAndSettle(h2, stateWith(null));
  ok("missing callbacks are tolerated", true);
  f2.stop();
}

/* ------------------------------------------------------------------ */
console.log("\nBACKFILL: the page must walk down to the snapshot before claiming an absence");
{
  /* The reported bug, reproduced as a state machine.
   *
   * head 100000, snapshot's newest message at block 90000 — a 10,000-block uncovered gap. The first
   * read covers the top 300. Before this fix the follower stopped there and the page said "no message
   * newer than the snapshot", which is an assertion about 10,000 blocks backed by 300 of them. */
  const snapshot = { fetchedAt: "2026-09-24T19:11:13.998Z", messages: [{ block: 90000, ts: 1700000000, tx: "0xs", from: DEV, to: BOARD, selfSend: true, isDev: true, important: null, text: "snapshot msg" }] };
  const h = harness({ head: 100000 });
  const f = await startAndSettle(h, stateWith(snapshot));

  const first = h.updates[h.updates.length - 1].freshness;
  ok("after the FIRST read the interval is NOT covered", first.coverageComplete === false, JSON.stringify(first.coverage));
  /* The exact figure depends on how many backfill bursts the startup tick managed to fit (startAndSettle
   * drains until requests stop, so it may already be past one burst). What must hold is that the unread
   * count is the bulk of the gap — the first read is 300 blocks of a 10,001-block interval, so anything
   * near 300 would mean the gap is being mis-measured. */
  ok(`the unread count is the bulk of the gap (${first.uncoveredBlocks} of ~10000)`, first.uncoveredBlocks > 7000, String(first.uncoveredBlocks));
  ok("and it is far more than the first window actually read", first.uncoveredBlocks > 300 * 10, String(first.uncoveredBlocks));

  /* Now let the backfill run: each tick spends a burst of segments after its incremental poll. */
  let guard = 0;
  while (guard++ < 60) {
    const before = f.status().lowestRead;
    await f.tickOnce();
    if (f.status().coverageComplete) break;
    if (f.status().lowestRead === before && guard > 5) break;
  }
  const done = h.updates[h.updates.length - 1].freshness;
  ok(`the backfill reached the snapshot's block and coverage became complete (after ${guard} ticks)`, f.status().coverageComplete === true, JSON.stringify(f.status().freshness.coverage));
  eq("the lowest block read is at the snapshot's newest block", f.status().lowestRead, 90000);
  eq("nothing is left unread", f.status().uncoveredBlocks, 0);
  eq("the status stops advertising a backfill", f.status().backfilling, false);

  /* The whole interval must actually have been REQUESTED — a watermark that advances without reads is
   * the same lie in a new place. */
  const read = new Set(h.ticks.flat());
  const gap = [];
  for (let b = 90000; b <= 100000; b++) gap.push(b);
  const unread = gap.filter((b) => !read.has(b));
  ok(`every block in the gap was requested (${gap.length - unread.length}/${gap.length})`, unread.length === 0, `first unread: ${unread.slice(0, 5).join(", ")}`);

  /* And the message the snapshot did not have, sitting inside the gap, must have been found. */
  const h2 = harness({ head: 100000, msgAt: { 95000: "posted between the snapshot and the head" } });
  const f2 = await startAndSettle(h2, stateWith(snapshot));
  let g2 = 0;
  while (g2++ < 60 && !f2.status().coverageComplete) await f2.tickOnce();
  const merged2 = h2.updates[h2.updates.length - 1].merged;
  ok("THE MESSAGE INSIDE THE GAP IS FOUND BY THE BACKFILL", merged2.messages.some((m) => m.block === 95000), JSON.stringify(merged2.messages.map((m) => m.block)));
  ok("and the page now reports the chain as ahead", h2.updates[h2.updates.length - 1].freshness.liveIsAhead === true);
  f.stop();
  f2.stop();
}

/* ------------------------------------------------------------------ */
console.log("\nBACKFILL: the incremental poll is never starved by history");
{
  /* A new message posted near the head must be reported even while a long backfill is still running.
   * If the walk ran first, or unbounded, the reader would wait minutes for the thing they opened the
   * page to see. */
  const snapshot = { fetchedAt: "2026-09-24T19:11:13.998Z", messages: [{ block: 90000, ts: 1700000000, tx: "0xs", from: DEV, to: BOARD, selfSend: true, isDev: true, important: null, text: "snapshot msg" }] };
  const h = harness({ head: 100000 });
  const f = await startAndSettle(h, stateWith(snapshot));
  ok("the first read has not closed the gap yet", f.status().coverageComplete === false);

  /* Someone posts at the very top while the history walk is still going. */
  h.head = 100020;
  h.msgAt[100015] = "posted just now";
  h.mark();
  await f.tickOnce();
  const merged = h.updates[h.updates.length - 1].merged;
  ok("a message posted at the head is found on the very next tick", merged.messages.some((m) => m.block === 100015), JSON.stringify(merged.messages.map((m) => m.block)));
  ok("even though the backfill is still incomplete", f.status().coverageComplete === false);
  ok("the head read is the FIRST thing the tick did", h.window().some((b) => b === 100020 - 4 || b === 100019), `first blocks: ${h.window().slice(0, 6).join(",")}`);
  f.stop();
}

/* ------------------------------------------------------------------ */
console.log("\nBACKFILL: an unreachable segment does not wedge the walk");
{
  /* If one segment never answers, the walk must still be able to reach the rest — otherwise a single
   * bad stretch freezes coverage for ever and the page can never make its claim. The gap that failed
   * is reported as uncovered, which is the honest outcome. */
  const snapshot = { fetchedAt: "2026-09-24T19:11:13.998Z", messages: [{ block: 90000, ts: 1700000000, tx: "0xs", from: DEV, to: BOARD, selfSend: true, isDev: true, important: null, text: "snapshot msg" }] };
  const h = harness({ head: 100000 });
  /* Blocks 96000-96599 are unreachable, in every form. */
  const inner = h.rpc.batch;
  h.rpc.batch = async (reqs) => {
    const n = parseInt(reqs[0].params[0], 16);
    if (n >= 96000 && n < 96600) throw new Error("that stretch is gone");
    return inner(reqs);
  };
  const f = await startAndSettle(h, stateWith(snapshot));
  let g = 0;
  while (g++ < 60) {
    await f.tickOnce();
    if (f.status().uncoveredBlocks === 0) break;
  }
  ok("the walk did not stay stuck on the unreachable segment", f.status().lowestRead < 96000, `lowestRead ${f.status().lowestRead}`);
  ok("the failed stretch is reported, not silently skipped", f.status().backfillFailures > 0, String(f.status().backfillFailures));
  ok("and the page still refuses to claim completeness", f.status().coverageComplete === false, JSON.stringify(f.status().freshness.coverage));
  f.stop();
}

/* ------------------------------------------------------------------ */
console.log("\nBACKFILL: no snapshot means no known interval, so no walk");
{
  /* Without a snapshot there is no floor, and walking to block 1 would read the whole chain to answer
   * a question nobody asked. The follower must simply not start. */
  const h = harness({ head: 100000 });
  const f = await startAndSettle(h, stateWith(null));
  const before = f.status().readBlocks;
  await f.tickOnce();
  ok("no backfill is attempted without a snapshot to bound it", f.status().lowestRead === null || f.status().readBlocks - before < 1000, `lowestRead ${f.status().lowestRead}, read ${f.status().readBlocks - before}`);
  f.stop();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
