/**
 * Scanning the message board for a BUILD-TIME snapshot: long ranges, a published watermark,
 * and resumable batches.
 *
 * WHY THIS IS SEPARATE FROM lib/messages-live.js
 * ----------------------------------------------
 * Both walk blocks looking for calldata sent to the board, and this module deliberately imports
 * `scanMessages()` from there rather than reimplementing it — the per-batch "which blocks were
 * really read" accounting is subtle and already correct in one place, so there is no second copy
 * to drift.
 *
 * What differs is the strategy, and the difference is the reason for the split:
 *
 *   runtime (messages-live.js)  a reader is waiting. The window is ~300 blocks (~1 hour), it
 *                               must not block first paint, and a short window plus the snapshot
 *                               is enough because the reader is looking at "just now".
 *
 *   build time (here)           nobody is waiting. The snapshot is the AUTHORITATIVE history, so
 *                               its job is to close the gap since the last scan, however long
 *                               that gap is — and to do so without ever quietly skipping blocks.
 *
 * The runtime window is a UX tradeoff. Applying it here would mean a CI job that stopped for a
 * day silently loses a day of messages, because the snapshot would only ever look an hour back.
 * That is the failure this module exists to avoid.
 *
 * THE WATERMARK IS NOT THE NEWEST MESSAGE
 * ---------------------------------------
 * Same distinction as the Base burn scan, for the same reason: the newest message says where
 * EVENTS are, not where the SCAN got to. Messages arrive ~0.55/day (~1 per 13,155 blocks), so
 * the newest message can trail a completed scan by a very long way; and after a partially failed
 * scan the newest message is AHEAD of the true progress, so resuming from it would skip every
 * block in between — permanently, and invisibly (a slightly shorter history looks like history).
 *
 * So `scannedTo` is published separately and only advances when `covered` is true, and the resume
 * point is the more conservative of the two marks.
 */

import { scanMessages, MESSAGE_ADDRESS, CHUNK } from "./messages-live.js";

/** Blocks of slack before the resume point. A multiple of the chunk: the chunk is the smallest unit that can be re-read. */
export const RESUME_MARGIN = 200;

/**
 * The most any single build-time run will scan.
 *
 * Sized against measurement, not intuition. Walking full blocks costs ~63ms/block in steady state
 * (five consecutive 300-block batches measured at 32.6 / 16.5 / 20.7 / 14.5 / 9.8s — note that a
 * single batch measured 35ms/block, which is why one measurement is not enough to size anything).
 * At 63ms/block this cap is ~12.6 minutes of work, leaving roughly 4x headroom under the refresh
 * workflow's `timeout-minutes: 60` for a slower runner or extra retries.
 *
 * WHY A CAP AT ALL, AND WHY NOT LARGER. Block payloads are huge (~200 transactions per block, so a
 * 300-block batch is tens of MB), and the cost is per block, so a long outage would otherwise
 * produce a run that exceeds the job timeout and fails outright — losing the whole scan rather
 * than making progress on it. Truncating instead means the run always finishes, records how far it
 * got, and continues next time.
 *
 * WHAT A LARGE BACKLOG ACTUALLY COSTS. A week of downtime is ~50,400 blocks, so recovery takes
 * ceil(50400 / 12000) = 5 runs, not one. Because the job is hourly, that is ~5 hours of WALL
 * CLOCK, not 5 x 12.6 minutes of compute — the runs are separated by the schedule, and each one
 * only starts when its hour comes round. (The first pass closes 12,000 blocks, so the visible
 * backlog shrinks steadily rather than at the end.)
 *
 * The alternative — scan only the newest N blocks and drop the rest — would leave a permanent hole
 * in the history, which is the one outcome this design refuses.
 */
export const COLD_START_CAP = 12_000;

/**
 * Where to start scanning.
 *
 * Two cases, and the cold one is the subtle one:
 *
 *   - a published watermark exists: `min(scannedTo, newestMessageBlock) - margin`. Taking the
 *     MINIMUM defends both failure directions at once — a watermark that advanced too far
 *     (a partial scan recorded as complete) and an event position that is stale (a long quiet
 *     stretch). Erring low only costs re-reading.
 *
 *   - no watermark: begin after the newest message already in the snapshot, so the gap since the
 *     snapshot is covered, but never further back than the cap. The snapshot itself supplies
 *     everything older; this scan is only responsible for the range it can actually reach, and
 *     the watermark records exactly how far it got rather than pretending to have covered more.
 *
 * @param {object} opts
 * @param {number} opts.head               current chain head
 * @param {number} opts.snapshotMaxBlock   newest message block already in the snapshot (0 if none)
 * @param {number|null} opts.scannedTo     published watermark, if any
 * @param {number} [opts.margin]
 * @param {number} [opts.cap]
 * @returns {{from:number, reason:string}}
 */
export function scanRange({ head, snapshotMaxBlock, scannedTo, margin = RESUME_MARGIN, cap = COLD_START_CAP }) {
  const newest = Number.isFinite(snapshotMaxBlock) && snapshotMaxBlock > 0 ? snapshotMaxBlock : 0;
  const marks = [scannedTo, newest || null].filter((v) => Number.isFinite(v) && v !== null);

  if (marks.length) {
    const conservative = Math.min(...marks);
    const from = Math.max(1, conservative - margin);
    return { from, reason: `resuming from ${from} (watermark ${scannedTo ?? "none"}, newest message ${newest || "none"})` };
  }

  /* Cold: no watermark and nothing in the snapshot. Start at the cap rather than block 1 — a full
   * history scan is ~920,868 blocks, measured at ~9.6 hours, which is not a thing an hourly job
   * can do. The watermark means the shortfall is carried forward instead of lost. */
  const from = Math.max(1, head - cap);
  return { from, reason: `cold start, capped at ${cap} blocks back` };
}

/**
 * The scan range's upper bound, trimmed so one run cannot exceed the cap.
 *
 * When the gap is larger than the cap, this returns a `to` BELOW the head and the caller must not
 * report the scan as reaching the head. The watermark then advances only to `to`, and the next
 * run picks up the rest — which is what makes a long outage recoverable instead of fatal.
 *
 * @returns {{to:number, truncated:boolean}}
 */
export function scanCeiling({ from, head, cap = COLD_START_CAP }) {
  const to = Math.min(head, from + cap - 1);
  return { to, truncated: to < head };
}

/**
 * The watermark to publish after a scan.
 *
 * Only advances when every block in the range was genuinely read. A partial scan must NOT move
 * the watermark: the blocks it missed are exactly what the resume margin is there to re-cover,
 * and advancing past them turns a transient failure into permanently missing history.
 *
 * @param {object} opts
 * @param {number|null} opts.previous
 * @param {number} opts.to
 * @param {boolean} opts.covered
 * @returns {number|null}
 */
export function nextScannedTo({ previous, to, covered }) {
  const prev = Number.isFinite(previous) ? previous : null;
  if (!covered) return prev;
  return prev === null ? to : Math.max(prev, to);
}

/**
 * Merge scanned messages into the existing snapshot, newest first, de-duplicated by tx hash.
 *
 * The snapshot is the tail of history and the scan is the recent head, so neither replaces the
 * other: an outgoing message must survive a scan that did not happen to re-read it. De-duplication
 * is by transaction hash rather than block, because a block can legitimately carry more than one
 * message and keying on the block would drop all but one.
 *
 * @param {object[]} snapshot
 * @param {object[]} scanned
 * @returns {object[]}
 */
export function mergeMessages(snapshot, scanned) {
  const byTx = new Map();
  for (const m of snapshot || []) if (m && m.tx) byTx.set(m.tx, m);
  for (const m of scanned || []) if (m && m.tx) byTx.set(m.tx, m);
  return [...byTx.values()].sort((a, b) => b.block - a.block);
}

/**
 * Walk the range and report everything the caller needs to decide the watermark.
 *
 * @param {object} opts
 * @param {{batch:Function, call:Function}} opts.rpc
 * @param {number} opts.from
 * @param {number} opts.to
 * @param {number} [opts.chunk]
 * @param {(msg:string)=>void} [opts.log]
 * @returns {Promise<{messages:object[], covered:boolean, missed:object[], batchCalls:number, blockRetries:number, chunk:number}>}
 */
export async function scanMessageRange({ rpc, from, to, chunk = CHUNK, log = () => {} }) {
  const total = Math.max(0, Math.floor((to - from) / chunk) + 1);
  log(`scanning ${from}..${to} (${total} chunks of ${chunk})`);
  const res = await scanMessages({ rpc, from, to, chunk });
  log(
    `scanned ${res.ranges.length} range(s), ${res.messages.length} messages, ${res.batchCalls} batch calls, ` +
      `${res.blockRetries || 0} block retries, ${res.missed.length} missed block(s)${res.covered ? "" : " — NOT COVERED"}`
  );
  return { ...res, chunk };
}

export { MESSAGE_ADDRESS, CHUNK };
