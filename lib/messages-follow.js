/**
 * The follower that keeps the message board live while the page is open.
 *
 * WHY THIS IS A SEPARATE MODULE FROM lib/messages-live.js
 * ------------------------------------------------------
 * messages-live.js answers "what is in these blocks" — pure, synchronous where it can be, testable
 * against fixtures. This file owns the part that is none of those things: a timer, a moving
 * watermark, and the decision about what to do when a read fails or comes back partial. Keeping them
 * apart means the tricky state machine here can be driven from a test without waiting on a network,
 * and the scan logic there can be tested without a clock.
 *
 * WHY IT IS NOT PART OF boot()
 * ----------------------------
 * The first window is 300 blocks and the measured cost is seconds, not milliseconds (3-6 batch
 * calls, 9-20s against the public fleet). Putting that on the boot path would hold the ENTIRE page
 * on a blank screen — the numbers, the verdict, the headline — behind a request that usually finds
 * nothing, because the board is quiet most days. So the page boots from the snapshot exactly as it
 * always did, paints, and THEN this follower runs in the background and merges in whatever it finds.
 *
 * That ordering is also what makes the failure modes acceptable. If the chain is unreachable, the
 * reader still has the full snapshot; the only thing lost is the word "live" next to it.
 *
 * THE WATERMARK
 * -------------
 * `lastSeen` is the highest block this page has actually READ, not the highest it has seen reported.
 * It advances only on a scan that reports `covered: true`, so a partial or failed read is retried
 * instead of being skipped past. This is the same discipline as lib/log-index.js's resumePoint, and
 * for the same reason: advancing a watermark over blocks you never read makes the next scan start
 * after them, and the hole is invisible forever after.
 */

import { Rpc } from "./evm.js";
import { scanMessages, mergeMessages, messageFreshness, nextWindow, FIRST_WINDOW } from "./messages-live.js";

/** How often the incremental tick runs. Slower than the 60s state refresh on purpose — see below. */
export const POLL_MS = 30_000;

/**
 * How long to wait before the first background read.
 *
 * Deliberately delayed past the first `tick()`. The page's own chain read and this window scan would
 * otherwise start in the same instant and stack their requests on the same endpoints, which is the
 * one way this feature can make the REST of the dashboard worse. A few seconds of separation costs
 * nothing — the reader has the snapshot on screen already.
 */
export const START_DELAY_MS = 2_500;

/** After this many consecutive failures, stop retrying and say so rather than hammering. */
export const MAX_FAILURES = 5;

/**
 * Start following the board.
 *
 * Returns a handle with `stop()` so a test (or a fixture session, where app.js returns early) can
 * tear it down. Nothing here throws into the caller: an error on the very first read must not
 * prevent the page from finishing boot, because boot has already painted by this point and a throw
 * would only abort whatever comes after it in boot().
 *
 * @param {object} opts
 * @param {object} opts.state      the app's state object (holds `messages`, `messagesZh`)
 * @param {Function} opts.onUpdate called with the merged result whenever it changes
 * @param {Function} [opts.onError]  called with a message when a read fails
 * @param {object} [opts.rpc]      injectable for tests
 * @param {(fn:Function, ms:number)=>any} [opts.setTimeoutImpl]
 * @param {(fn:Function, ms:number)=>any} [opts.setIntervalImpl]
 * @returns {{stop:Function, status:Function, tickOnce:Function}}
 */
export function startMessageFollower({
  state,
  onUpdate,
  onError,
  rpc = new Rpc(undefined, { timeoutMs: 25000 }),
  setTimeoutImpl = (fn, ms) => setTimeout(fn, ms),
  setIntervalImpl = (fn, ms) => setInterval(fn, ms),
  clearTimeoutImpl = (t) => clearTimeout(t),
  clearIntervalImpl = (t) => clearInterval(t),
  pollMs = POLL_MS,
} = {}) {
  /** Highest block actually read. null until the first successful scan. */
  let lastSeen = null;
  /** Consecutive failed reads; reset by any success. */
  let failures = 0;
  /** Live messages accumulated across ticks — the incremental windows union into this. */
  let live = [];
  let stopped = false;
  let timer = null;
  let firstTimer = null;
  /** Cumulative counters for the details block: blocks actually read, and batched requests made. */
  let readBlocks = 0;
  let batchCalls = 0;
  /** The newest status, for the UI to render. */
  let status = { phase: "idle", liveCount: 0, lastSeen: null, readAt: null, failed: 0, covered: null };

  /**
   * Rebuild the status object rather than patching the previous one.
   *
   * `{ ...status, failed: failures }` was the original shape and it was wrong in a way that only
   * shows up after a recovery. `publish()` spread the OLD status, so a successful tick set
   * `phase: "live"` while leaving `status.failed` at whatever the last outage had reached — the
   * published failure count and the real one disagreed. A follower that had fully recovered would
   * then count its next two failures against a stale total and stop early, announcing that the live
   * read was off while the chain was perfectly reachable.
   *
   * So `error` and `holes` are derived ONLY from what this attempt passes in, and never inherited:
   * there is no path by which a previous outage's diagnostic survives into a healthy status. */
  const publish = (extra = {}) => {
    const snapshot = state.messages;
    const merged = mergeMessages({ snapshot, live });
    /* Resolve `readAt` BEFORE building the freshness object, and let the caller's value win.
     *
     * `readAt: status.readAt` alone read the PREVIOUS status and ignored the `readAt` the scan had just
     * passed in, so the published timestamp lagged one tick behind. That is the field the page turns
     * into "data as of …", which makes it exactly the wrong thing to be stale by a poll interval. */
    const readAt = extra.readAt !== undefined ? extra.readAt : status.readAt;
    const freshness = messageFreshness({
      merged,
      snapshot,
      liveHead: lastSeen,
      liveReadAt: readAt,
    });
    status = {
      phase: "idle",
      error: null,
      holes: 0,
      ...extra,
      readAt,
      failed: failures,
      liveCount: live.length,
      lastSeen,
      /* Carried from the closure rather than from `extra`, so a failure tick does not reset them to
       * undefined: the counters describe the whole session and a failed tick did not undo the reads
       * that already happened. */
      readBlocks,
      batchCalls,
      freshness,
    };
    state.messagesLive = merged;
    onUpdate && onUpdate({ merged, freshness, status });
  };

  /**
   * Record a failed attempt and publish it.
   *
   * Routed through publish() for the same reason the health counter is: two code paths that each
   * assemble the status object are two places for it to drift. The merged view is rebuilt even on a
   * failure — `state.messagesLive` must stay consistent with `state.messages` whether or not the
   * chain answered, or the message section would render one shape while the freshness label
   * describes another.
   */
  const fail = (err) => {
    failures++;
    const message = String((err && err.message) || err).slice(0, 140);
    if (failures >= MAX_FAILURES) {
      /* Stop rather than keep retrying: five consecutive failures across a fleet of eight endpoints
       * is not a transient, and a page that retries anyway spends the reader's battery and the public
       * endpoints' quota proving it. The snapshot stays on screen and the banner says so. */
      stop();
      publish({ phase: "stopped", error: message });
    } else {
      publish({ phase: "error", error: message });
    }
    onError && onError(message);
  };

  const step = async () => {
    if (stopped) return;
    let head;
    try {
      head = Number(BigInt(await rpc.call("eth_blockNumber")));
    } catch (err) {
      fail(err);
      return;
    }

    const w = nextWindow({ head, lastSeen });
    if (!(w.to >= w.from)) {
      /* Level with the head: nothing new to read. Not a failure, and must not count as one. */
      publish({ phase: "live" });
      return;
    }

    let scan;
    try {
      scan = await scanMessages({ rpc, from: w.from, to: w.to });
    } catch (err) {
      fail(err);
      return;
    }

    failures = 0;
    /* Union the new messages in. A block is read once, so duplicates are not expected from the scan
     * itself — but the reorg margin deliberately RE-reads a few blocks every tick, which guarantees
     * them. mergeMessages de-duplicates by block, so appending is safe. */
    if (scan.messages.length) {
      const seen = new Set(live.map((m) => m.block));
      for (const m of scan.messages) if (!seen.has(m.block)) live.push(m);
    }

    if (scan.covered) {
      /* Only now may the watermark move. `head` rather than `w.to` is the same number here, but
       * using the scan's own `head` keeps the rule readable: advance to what was covered. */
      lastSeen = scan.head;
    }
    /* `readBlocks` and `batchCalls` are cumulative for the SESSION, not per tick, because that is what
     * the details block reports: "this page has read N blocks from the chain in M batched requests".
     * A per-tick number would describe one 30-second poll and understate the work by orders of
     * magnitude. Only blocks that actually answered are counted, so the figure cannot overstate
     * coverage during an outage. */
    readBlocks += scan.ranges.reduce((n, r) => n + (r.to - r.from + 1), 0);
    batchCalls += scan.batchCalls;
    publish({
      phase: "live",
      readAt: Date.now(),
      covered: scan.covered,
      holes: scan.covered ? 0 : scan.missed.length,
      readBlocks,
      batchCalls,
    });
  };

  const stop = () => {
    stopped = true;
    if (timer) clearIntervalImpl(timer);
    if (firstTimer) clearTimeoutImpl(firstTimer);
    timer = null;
    firstTimer = null;
  };

  /* The first read is scheduled, not awaited: startMessageFollower returns immediately so boot()
   * is never held. */
  firstTimer = setTimeoutImpl(() => {
    firstTimer = null;
    if (stopped) return;
    step();
    timer = setIntervalImpl(step, pollMs);
  }, START_DELAY_MS);

  return {
    stop,
    status: () => status,
    /** Run one tick now (used by tests, and by the manual refresh if one is ever added). */
    tickOnce: step,
  };
}

export { FIRST_WINDOW };
