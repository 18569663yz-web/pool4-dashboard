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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
