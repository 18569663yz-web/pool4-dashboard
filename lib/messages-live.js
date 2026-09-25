/**
 * Reading the on-chain message board LIVE, and merging what comes back with the snapshot.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The page used to render `data/messages.json` and nothing else. That file is refreshed by
 * `.github/workflows/refresh-snapshots.yml` once an hour, so a reader who watched someone post a
 * message sat in front of a page that would not show it for up to an hour — and if the workflow
 * failed, for ever. That is exactly what was reported: "the dev just posted a message and the page
 * still has not updated". The defect was never in the renderer; the renderer was faithfully drawing
 * a file that was eight hours upstream of stale.
 *
 * WHY THERE IS NO eth_getLogs PATH HERE
 * -------------------------------------
 * The obvious reach is `eth_getLogs`, because this project already scans logs elsewhere
 * (lib/log-scan.js). It does not work for this address and never will: the board is a plain EOA
 * (`0x200E71…fB1`), and EOAs do not emit logs. Measured directly against publicnode — a 1,000-block
 * window and a 5,000-block window over that address both return `[]`. A message here is the
 * CALLDATA of an ordinary transfer, so it lives in the transaction, not in a receipt and not in a
 * log. Anything that reads this board has to walk blocks and look inside their transactions.
 *
 * WHY THE WALK IS BATCHED AND SHORT
 * ---------------------------------
 * Per-block `eth_getBlockByNumber(tag, true)` costs one RPC per block; 300 of them is 300 requests,
 * which is both slow and rude to a free public fleet. JSON-RPC batches collapse the same window
 * into a handful of HTTP requests, and the fleet tolerates large batches well: measured at
 * chunk=100 a 300-block window rides in 3 batch calls, and even a 500-request batch answers in
 * ~7.6s. This module therefore walks in chunks and never issues one request per block.
 *
 * A long lookback is ALSO impossible, which is the second half of why the window is short. The
 * board is a low-traffic channel: 70 decoded messages over 128 days is 0.55/day, one per ~13,155
 * blocks, with a longest observed silence of ~372,000 blocks — 51 days. Covering a quiet stretch
 * would need a window no public node will serve. So the honest design is not "look back far"; it is
 *
 *     short window on first paint  +  only-new-blocks afterwards  +  snapshot for older history
 *
 * which is what this file implements. The snapshot is not replaced, it is the tail: live reading
 * covers the recent hours, the snapshot covers everything before that, and the two are merged by
 * block number so the reader sees one continuous timeline with an honest boundary between them.
 *
 * WHAT "LATEST" CANNOT MEAN
 * -------------------------
 * Only mined transactions are visible. A message still sitting in the mempool cannot be read by any
 * `eth_getBlockByNumber`, so the page must say "latest message packed on chain, data as of …" and
 * must never promise second-level realtime. `liveAsOf`/`snapshotAsOf` below exist so the UI can say
 * precisely which of the two it is showing.
 */

import { decodeMessage } from "./decode-message.js";
import { snapshotTimestamp } from "./snapshots.js";

/** The dev's message board: a plain EOA, so a message is the calldata of a transfer to it. */
export const MESSAGE_ADDRESS = "0x200E710aCAA6A93bbc77146026328C40F1d60fB1";

/**
 * Addresses treated as "the dev". Same pair as scripts/fetch-messages.mjs.
 *
 * NOTE the deliberate asymmetry with the fetch script: both the board itself (self-sends) and the
 * protocol owner EOA post announcements, and a message is only "from dev" if the SENDER is one of
 * these. A community member sending TO the board is not dev.
 */
export const DEV_ADDRESSES = [
  "0x200e710acaa6a93bbc77146026328c40f1d60fb1",
  "0x047f606fd5b2baa5f5c6c4ab8958e45cb6b054b7",
];

/**
 * Blocks per JSON-RPC batch request, with FULL transactions.
 *
 * 25, measured in a browser rather than reasoned about — because the two differ, and the difference is
 * invisible from Node.
 *
 * The tempting figure is 100: this project already probes the fleet with `eth_getBlockByNumber(tag,
 * false)` (block headers only, ~2MB per 100) and a batch of 100 answers 100/100 in well under a
 * second. But this scan needs `true` — full transaction objects, because a message is a transaction's
 * calldata — and that is a different payload by ~20x: ~44MB for 100 blocks.
 *
 * Measured in Chrome against the real endpoint, worst case of three windows per size:
 *
 *   chunk 100, full=true  →  54/100 ok     46 items: "response too large"
 *   chunk  50, full=true  →  ~48/50 ok     a contiguous TAIL of each batch dropped
 *   chunk  40, full=true  →  40/40 ok
 *   chunk  30, full=true  →  30/30 ok
 *   chunk  25, full=true  →  25/25 ok
 *   chunk  15, full=true  →  15/15 ok
 *
 * The failure mode is what makes this worth a long note. It is PER ITEM, not a thrown error: the
 * endpoint answers HTTP 200 and marks individual entries `{ok:false, error:"response too large"}`. So
 * a too-large batch does not look like a failure — it looks like a scan that read 285 of 300 blocks,
 * which sets `covered:false` and stops the follower advancing its watermark. The page then re-reads
 * the same window every 30 seconds for ever and never leaves "reading…". That is precisely the symptom
 * observed, and it only appeared under a browser: Node's fetch tolerated 100.
 *
 * 25 is chosen well under the measured cliff (40) because the limit depends on how busy the blocks
 * are, not just how many there are — a quiet stretch may fit 40 where a busy one does not. The cost is
 * more requests: a 300-block first read becomes 12 batches (~1s each), still far better than 300.
 */
export const CHUNK = 25;

/**
 * How many times a single block is re-requested before it is accepted as unavailable.
 *
 * Needed because of the per-item failure above, and because "one block would not answer" and "the
 * range is unreadable" must not be treated the same. Retrying a straggler costs one small request; not
 * retrying costs the watermark, because a single permanent hole keeps `covered` false for ever and the
 * follower then re-reads the same 300 blocks every 30 seconds without ever progressing.
 *
 * The retry is for the block, not the chunk: asking again for 25 blocks to recover 3 wastes the
 * budget that caused the drop. One request per missing block, capped.
 */
export const BLOCK_RETRIES = 2;

/**
 * Blocks per BACKFILL segment — the background walk that closes the stretch the snapshot does not cover.
 *
 * Larger than FIRST_WINDOW because this runs in the background where a slower segment is acceptable,
 * and because the number of segments is what decides how long the reader waits for a *complete*
 * answer: 14,406 uncovered blocks at 300/segment is 49 segments, at 600 it is 25.
 *
 * 600 is deliberately NOT larger. Each segment is a foreground-quality read of a busy chain, and a
 * bigger segment means a longer gap between the page being able to say anything new; it also raises
 * the chance of hitting the per-item size rejection that CHUNK exists to avoid. At 25 blocks/request
 * that is 24 requests per segment.
 */
export const BACKFILL_SEGMENT = 600;

/**
 * How many backfill segments may run back-to-back before yielding to the incremental poll.
 *
 * The incremental poll (new blocks, a handful per tick) is the one that catches a LIVE message, so it
 * must never be starved by history. Backfilling in bursts of a few segments with a pause between them
 * keeps the newest-block read frequent while still closing the gap steadily.
 */
export const BACKFILL_BURST = 3;

/**
 * How far back the first paint looks.
 *
 * 300 blocks is ~60 minutes at 12s/block. It is chosen against two measured constraints, and the
 * second one is the surprising one:
 *
 *   - it must be small enough to be cheap: 300 blocks = 3 batch calls, seconds not minutes;
 *   - it must be small enough to be *allowed*, and this is the binding one. A 20,000-block window
 *     over this address is rejected outright by publicnode ("Archive requests require a personal
 *     token"), so any design that reaches back days is dead on arrival regardless of cost.
 *
 * The window is NOT sized to "contain a message" — at 0.55 messages/day it usually will not, and
 * pretending otherwise would be the same overclaiming this fix exists to remove. It is sized to
 * contain the *burst*: the observed failure was two messages inside 7 minutes, and a live channel
 * that has just been active is the one a reader is looking at. When the burst is older than the
 * window, the snapshot still supplies it, and the page says which is which.
 */
export const FIRST_WINDOW = 300;

/**
 * Only-new-blocks polling: a floor on how much to re-read each tick.
 *
 * A reorg can rewrite the last block or two, so resuming exactly at head+1 can leave a hole where a
 * message briefly existed. Re-reading a small margin is nearly free (a handful of blocks) and makes
 * the incremental path reorg-tolerant without a special case.
 */
export const REORG_MARGIN = 5;

const lc = (a) => String(a || "").toLowerCase();
const hexToNum = (h) => parseInt(h, 16);
export const blockTag = (n) => "0x" + Number(n).toString(16);

/**
 * Turn one block's full transaction list into message records.
 *
 * Pure and synchronous so it can be tested against a hand-written block without a network. The
 * filter is "this transaction is addressed to the board OR was sent by it": the board receives its
 * messages, and because it is an EOA the dev also posts by sending from it, so both directions are
 * a message and a `to`-only filter would silently drop half the channel (the 37 self-send
 * announcements in the snapshot are all the `from` direction).
 *
 * A transaction with empty calldata is a plain value transfer, not a message — decodeMessage
 * returns null for it and it is skipped. This is not an edge case to shrug at: a message-board
 * address receives ordinary sweeps too, and the snapshot's own counts show 79 txs decoding to 70
 * messages.
 *
 * @param {object} block a raw eth_getBlockByNumber(_, true) result
 * @param {string} [board] the board address (lowercased internally)
 * @returns {object[]} message records, ascending by block
 */
export function messagesInBlock(block, board = MESSAGE_ADDRESS) {
  if (!block || !Array.isArray(block.transactions)) return [];
  const want = lc(board);
  const devSet = new Set(DEV_ADDRESSES.map(lc));
  const blockNumber = hexToNum(block.number);
  const ts = hexToNum(block.timestamp);
  const out = [];
  for (const t of block.transactions) {
    const from = lc(t.from);
    const to = lc(t.to);
    /* EITHER direction. A `to`-only filter silently loses half the board's traffic, and the half it
     * loses is not hypothetical: the project's own announcements were posted by sending FROM the
     * board's address TO somewhere else, so those transactions have `from = board` and `to` = an
     * unrelated address. Filtering on `to` alone drops exactly those.
     *
     * Testing the `from` direction with a SELF-SEND is not enough to catch this: in a self-send
     * `to` IS the board, so a to-only filter matches it anyway and the test passes for the wrong
     * reason. That is how this survived — mutation testing found it, by deleting the `from` check
     * and watching the whole suite stay green. The distinguishing case is `from = board`,
     * `to = something else`, which is what scripts/test-messages-live.mjs now asserts.
     *
     * A transfer that touches neither side is still not a message, which is the next guard down. */
    if (to !== want && from !== want) continue;
    const text = decodeMessage(t.input || t.raw_input);
    if (text === null) continue;
    out.push({
      block: blockNumber,
      ts,
      tx: t.hash,
      from: t.from,
      to: t.to || null,
      selfSend: from === to,
      isDev: devSet.has(from),
      important: null,
      text,
    });
  }
  return out;
}

/**
 * Walk a block range and collect every message in it, in batched chunks.
 *
 * Failure handling is the point of this function existing separately from its caller. A batch is
 * sent through `rpc.batch`, whose contract is per-item: a window can come back partly answered, and
 * `rpc.batch` already degrades to sequential singles across the fleet. What it does NOT do is tell
 * the caller which blocks were covered, and the caller must not report "no messages since block N"
 * when what actually happened is "we never read block N".
 *
 * So the range is reported back explicitly: `ranges` lists what was genuinely answered, and
 * `covered` is false whenever anything was missed. A partial read is never silently promoted to a
 * complete one — that is the same class of bug as the old `catch {}` around the bridge scan, which
 * dropped events and reported a smaller, entirely plausible history.
 *
 * @param {object} opts
 * @param {{batch:Function, call:Function}} opts.rpc
 * @param {number} opts.from inclusive
 * @param {number} opts.to inclusive
 * @param {number} [opts.chunk]
 * @param {number} [opts.blockRetries] single-block re-requests for entries a batch dropped (see BLOCK_RETRIES)
 * @param {number} [opts.retryThreshold] skip the retry pass once this FRACTION of a chunk is missing (default 0.5)
 * @returns {Promise<{messages:object[], covered:boolean, ranges:{from:number,to:number}[], head:number, missed:{from:number,to:number}[], batchCalls:number, blockRetries:number}>}
 */
export async function scanMessages({ rpc, from, to, chunk = CHUNK, blockRetries = BLOCK_RETRIES, retryThreshold = 0.5 }) {
  const messages = [];
  const ranges = [];
  const missed = [];
  let batchCalls = 0;
  let blockRetryCount = 0;

  if (!(to >= from)) {
    /* An empty range is COVERED, and getting this backwards is not cosmetic.
     *
     * `to < from` happens on every tick where the head has not advanced — a lagging endpoint, a
     * quiet chain, two ticks inside the same 12-second block. The caller decides whether to advance
     * its watermark from `covered`. Reporting an empty range as uncovered would make a follower
     * that is momentarily level with the head believe it had a hole, so it would retry the same
     * empty range forever and never move on. Nothing was skipped here, so nothing is missed. */
    return { messages, covered: true, ranges, head: to, missed, batchCalls };
  }

  for (let start = from; start <= to; start += chunk) {
    const end = Math.min(start + chunk - 1, to);
    const reqs = [];
    for (let b = start; b <= end; b++) reqs.push({ method: "eth_getBlockByNumber", params: [blockTag(b), true] });
    batchCalls++;

    let out;
    try {
      out = await rpc.batch(reqs);
    } catch (err) {
      // Whole chunk unreachable: record it as a hole rather than as "no messages".
      missed.push({ from: start, to: end, error: String((err && err.message) || err).slice(0, 120) });
      continue;
    }

    /* Track exactly which block numbers came back. `out` is positionally aligned with `reqs`, so
     * index i is block start+i — but relying on position alone would trust the transport. The
     * block's own `number` is decoded and checked, so a misaligned or duplicated response is
     * detected instead of quietly attributing messages to the wrong block. */
    let okFrom = null;
    let okTo = null;
    const gaps = [];
    for (let i = 0; i < reqs.length; i++) {
      const want = start + i;
      const o = out && out[i];
      const blk = o && o.ok ? o.result : null;
      if (!blk || hexToNum(blk.number) !== want) {
        gaps.push(want);
        continue;
      }
      if (okFrom === null) okFrom = want;
      okTo = want;
      messages.push(...messagesInBlock(blk));
    }

    /* Re-request the stragglers one at a time before calling them missed.
     *
     * This is not politeness — it is what keeps the follower moving. A per-item size rejection (or any
     * transient per-block failure) otherwise leaves a hole that never heals: `covered` stays false for
     * ever, the watermark never advances, and the page re-reads the same window every 30 seconds
     * without ever reaching a state it can report. Asking for 3 blocks singly costs almost nothing and
     * turns a permanent stall into a recoverable hiccup.
     *
     * The blocks that DID answer in this pass are kept regardless, so a retry that also fails still
     * leaves the reader with everything that was read. */
    /* The retry pass is skipped when MOST of a chunk is missing: that is an outage, not a size
     * rejection, and asking for 25 blocks one at a time would spend 25 requests to confirm it. */
    let stillGaps = gaps;
    if (gaps.length && gaps.length < reqs.length * retryThreshold && blockRetries > 0) {
      stillGaps = [];
      for (const b of gaps) {
        let got = null;
        for (let attempt = 0; attempt < blockRetries && !got; attempt++) {
          blockRetryCount++;
          try {
            const single = await rpc.call("eth_getBlockByNumber", [blockTag(b), true]);
            if (single && hexToNum(single.number) === b) got = single;
          } catch {
            /* fall through to the next attempt; a failed retry is not an error the caller needs */
          }
        }
        if (got) {
          messages.push(...messagesInBlock(got));
          okFrom = okFrom === null ? b : Math.min(okFrom, b);
          okTo = okTo === null ? b : Math.max(okTo, b);
        } else {
          stillGaps.push(b);
        }
      }
    }

    if (!stillGaps.length) {
      ranges.push({ from: start, to: end });
    } else if (stillGaps.length < reqs.length) {
      /* Partial: report the contiguous stretch that DID answer, and list the holes. Collapsing a
       * partial window into "covered" is how a missing message becomes an invisible one. */
      if (okFrom !== null) ranges.push({ from: okFrom, to: okTo });
      for (const g of stillGaps) missed.push({ from: g, to: g, error: "block not returned" });
    } else {
      /* Nothing in the chunk answered. Recorded as ONE range rather than N single-block holes: the
       * caller's question is "what did I fail to read", and a whole chunk failing is one contiguous
       * gap. Listing 100 separate entries for one endpoint that was down would bury the real shape
       * of the outage in noise. */
      missed.push({ from: start, to: end, error: "no block in chunk returned" });
    }
  }

  return { messages, covered: missed.length === 0, ranges, head: to, missed, batchCalls, blockRetries: blockRetryCount };
}

/**
 * The polling window for a follower tick.
 *
 * `lastSeen` is the highest block already read. On the first tick there is none, so the floor is
 * `head - FIRST_WINDOW + 1` — a bounded first read rather than "since genesis".
 *
 * A head that moved BACKWARDS (endpoint lag, reorg) is handled by clamping to at least the reorg
 * margin below `lastSeen`: re-reading a handful of blocks is cheap and correct, whereas trusting a
 * lower head would create an untracked gap.
 *
 * @returns {{from:number, to:number}} inclusive; `to < from` means nothing to do
 */
export function nextWindow({ head, lastSeen, firstWindow = FIRST_WINDOW, margin = REORG_MARGIN }) {
  if (lastSeen === null || lastSeen === undefined) {
    return { from: Math.max(1, head - firstWindow + 1), to: head };
  }
  return { from: Math.max(1, Math.min(lastSeen + 1, lastSeen - margin + 1)), to: head };
}

/**
 * The next segment to read while BACKFILLING the stretch between the snapshot and what has been read.
 *
 * WHY BACKFILLING EXISTS AT ALL
 * -----------------------------
 * The first read is intentionally short (FIRST_WINDOW) so the page paints quickly. But the snapshot is
 * not refreshed in step with the chain: at the time of writing its newest message was block 26,038,179
 * while the head was 26,052,585 — an UNCOVERED stretch of 14,406 blocks, about 48 hours. A 300-block
 * first read therefore covers ~2% of it.
 *
 * The bug that follows from that is not "we did not find the message". It is that the page then SAID
 * "no message newer than the snapshot" — an assertion about the whole 14,406-block interval, made from
 * evidence covering 2% of it. That is the same failure family this project keeps hitting: the
 * mechanism ran, the report succeeded, and the range it checked is not the range it claimed. A reader
 * who watched someone post minutes earlier was told, in effect, that nothing had been posted.
 *
 * So the short first read is kept, and `backfillNext` walks the rest in the background, newest-first,
 * until it reaches the snapshot's own newest message. Until that happens the page must not claim
 * "nothing newer" — see `messageCoverage()`.
 *
 * `upper` is exclusive and moves DOWN as segments complete, so this returns the segment immediately
 * below what has been covered. Reading downwards means a newly posted message is found by the cheap
 * incremental path (which always runs first) while the expensive history closes in from behind.
 *
 * @param {object} opts
 * @param {number} opts.upper exclusive: the lowest block already covered
 * @param {number} opts.floor inclusive: stop here (the snapshot's newest block)
 * @param {number} [opts.segment]
 * @returns {{from:number, to:number}|null} null when there is nothing left to backfill
 */
export function backfillNext({ upper, floor, segment = BACKFILL_SEGMENT }) {
  if (!Number.isFinite(upper) || !Number.isFinite(floor)) return null;
  if (upper <= floor) return null;
  const to = upper - 1;
  const from = Math.max(floor, to - segment + 1);
  return { from, to };
}

/**
 * Can the page honestly claim "no message newer than the snapshot"?
 *
 * This function is the whole point: the claim is about an INTERVAL, so it is only allowed when the
 * interval has actually been read. Everything else is reported as an incomplete read — a weaker, true
 * statement — never as an absence.
 *
 * `gapFrom` is the first block AFTER the snapshot's newest message; that is the stretch that must be
 * covered for the claim to hold. `lowestRead` is the lowest block the live scan has genuinely read
 * (backfill moves it down; the incremental poll never moves it).
 *
 * `unreadRanges` is what makes the count correct, and it was added after a real mis-report. The first
 * version handled holes by returning `head - lowestRead + 1` — the size of the WHOLE span — whenever
 * any read had failed. That number is both wrong and non-monotonic: with the head fixed and the walk
 * progressing, an unread count can only shrink, yet the page showed it growing from 2,107 to 5,122 as
 * the walk advanced, because a hole anywhere made it report the entire interval as missing. A count
 * that moves the wrong way is not a cosmetic bug in a label whose entire job is to size an uncertainty.
 *
 * So the caller passes the ranges it could NOT read, and the answer is computed from them: unread is
 * the portion of [gapFrom, head] not covered by any read range.
 *
 * @param {object} opts
 * @param {number|null} opts.snapshotNewestBlock the snapshot's highest message block
 * @param {number|null} opts.lowestRead the lowest block the live scan has read
 * @param {number|null} opts.head the highest block read
 * @param {Array<{from:number,to:number}>} [opts.missed] ranges that could not be read
 * @returns {{complete:boolean, gapFrom:number|null, missing:number|null, reason:string}}
 */
export function messageCoverage({ snapshotNewestBlock, lowestRead, head, missed = [] }) {
  if (snapshotNewestBlock === null || snapshotNewestBlock === undefined || lowestRead === null || lowestRead === undefined) {
    /* Nothing to compare against, or nothing read yet: not complete, and there is no number to report
     * because no interval has been established. */
    return { complete: false, gapFrom: null, missing: null, reason: "unknown" };
  }
  const gapFrom = snapshotNewestBlock + 1;
  if (head !== null && head !== undefined && head < gapFrom) {
    /* The snapshot is AHEAD of what we read (it contains blocks we have not reached). There is no
     * uncovered interval in that case, and the snapshot's own messages are the newest thing there is. */
    return { complete: true, gapFrom, missing: 0, reason: "snapshot-ahead" };
  }

  /* Count only the part of [gapFrom, head] that no read range covered.
   *
   * Holes are clipped to that window and merged, because they come from two sources with different
   * shapes: the incremental poll reports single blocks near the head, and backfill reports whole
   * segments. Overlaps are normal (the walk re-reads a margin), so a naive sum would double-count.
   *
   * THE UPPER CLIP WAS `lowestRead - 1` AND THAT WAS A BUG — caught by
   * scripts/test-messages-follow.mjs's "an unreachable segment does not wedge the walk".
   *
   * `lowestRead` is the lowest block the walk has READ. It is not a licence to assume everything
   * above it was read — a hole is precisely the thing that is above it and was not. When the walk
   * advances past an unreachable stretch (which it must, or one bad segment freezes coverage for
   * ever) and then reaches ground below it, `lowestRead` drops BELOW the hole. Clipping the hole's
   * `to` down to `lowestRead - 1` then produced `to < from`, the range filtered out, `unread`
   * came back 0, and this function answered `complete: true, reason: "fully-read"` for an interval
   * containing a stretch nobody had read.
   *
   * That is the same class of failure as the reported bug — a claim wider than what was actually
   * checked — only reached by a different route, and it converts a recorded hole into a silent
   * absence, which is the one thing this function exists to prevent. The clip's job was only ever
   * to drop the part BELOW the interval, so that is all it does now. */
  const holes = (missed || [])
    .filter((m) => m && Number.isFinite(m.from) && Number.isFinite(m.to))
    .map((m) => ({ from: Math.max(m.from, gapFrom), to: m.to }))
    .filter((m) => m.to >= m.from)
    .sort((a, b) => a.from - b.from);

  let unread = 0;
  let cursor = gapFrom;
  for (const h of holes) {
    if (h.from > cursor) unread += h.from - cursor; // read stretch before this hole
    if (h.to + 1 > cursor) cursor = h.to + 1;
  }
  if (cursor <= lowestRead - 1) unread += lowestRead - cursor; // the tail, after the last hole

  if (lowestRead <= gapFrom && unread === 0) {
    return { complete: true, gapFrom, missing: 0, reason: "fully-read" };
  }
  /* Which failure dominates, so the label can say something true: a hole means a stretch WAS walked and
   * could not be read; "partial" means the walk has simply not arrived yet. */
  const hasHole = holes.length > 0;
  return { complete: false, gapFrom, missing: unread, reason: hasHole ? "holes" : "partial" };
}

/**
 * Merge live messages with the snapshot into the single list the page renders.
 *
 * Ordering and de-duplication are by BLOCK NUMBER, not by transaction hash. Two transactions in one
 * block are two distinct messages and both survive; the same message seen through both sources
 * collapses. Re-scanning overlapping windows is normal (that is what REORG_MARGIN does), so
 * duplicate suppression is a correctness requirement, not tidiness.
 *
 * On conflict the LIVE record wins, and the reason is the `important` field: the snapshot's copy
 * carries a hand-written Chinese annotation keyed by block, while a freshly decoded live copy has
 * `important: null`. Taking the live copy wholesale would silently strip those annotations off every
 * message in the overlap — including the 10 flagged ones the page has a whole filter for. So the
 * annotation and the snapshot's `isDev` classification are carried ONTO the live record, and only
 * the fields that are actually fresh (text, ts, from/to, tx) come from the chain.
 *
 * @param {object} opts
 * @param {object|null} opts.snapshot the parsed data/messages.json
 * @param {object[]} opts.live messages read from the chain
 * @returns {{messages:object[], liveCount:number, snapshotCount:number, overlap:number, liveBlocks:Set<number>}}
 */
export function mergeMessages({ snapshot, live }) {
  const liveList = Array.isArray(live) ? live : [];
  const snapList = snapshot && Array.isArray(snapshot.messages) ? snapshot.messages : [];

  const byBlock = new Map();
  const liveBlocks = new Set();

  for (const m of snapList) {
    if (m && Number.isFinite(m.block)) byBlock.set(m.block, { ...m, source: "snapshot" });
  }

  let overlap = 0;
  for (const m of liveList) {
    if (!m || !Number.isFinite(m.block)) continue;
    liveBlocks.add(m.block);
    const prev = byBlock.get(m.block);
    if (prev) overlap++;
    byBlock.set(m.block, {
      ...(prev || {}),
      ...m,
      /* Carry the annotation forward; a live decode has no way to know it. */
      important: m.important || (prev && prev.important) || null,
      isDev: prev && prev.important !== undefined && prev.isDev ? prev.isDev : m.isDev,
      source: "live",
    });
  }

  const messages = [...byBlock.values()].sort((a, b) => b.block - a.block);
  return { messages, liveCount: liveList.length, snapshotCount: snapList.length, overlap, liveBlocks };
}

/**
 * Freshness labels for the message section.
 *
 * Kept as a pure function returning DATA (block numbers and epoch ms) rather than sentences: the
 * wording belongs in locales/*.json, and a module that formats strings cannot be tested without a
 * dictionary. The page turns these into the two labels it needs.
 *
 * `liveAsOf` is the timestamp of the newest block actually READ — not `Date.now()`. That distinction
 * is the whole point: "we checked and the newest message is 3 hours old" and "we checked just now"
 * are different claims, and a dashboard that prints `Date.now()` next to stale content is asserting
 * a freshness it did not verify.
 *
 * @param {object} opts
 * @param {object} opts.merged result of mergeMessages
 * @param {object|null} opts.snapshot
 * @param {number|null} opts.liveHead the highest block the live scan actually covered
 * @param {number|null} opts.liveReadAt epoch ms when the scan completed
 * @param {number|null} [opts.lowestRead] the LOWEST block the live scan has read (backfill moves this)
 * @param {Array<{from:number,to:number}>} [opts.missed] ranges that could not be read, so the uncovered
 *   count is computed from what is genuinely missing rather than from the span's size
 * @param {number} [opts.now]
 */
export function messageFreshness({ merged, snapshot, liveHead, liveReadAt, lowestRead = null, missed = [], now = Date.now() }) {
  const newest = merged.messages[0] || null;
  const snapAt = snapshotTimestamp(snapshot);
  const newestLive = merged.messages.find((m) => m.source === "live") || null;
  const snapshotNewestBlock = snapshot && snapshot.messages && snapshot.messages.length ? snapshot.messages[0].block : null;
  const coverage = messageCoverage({ snapshotNewestBlock, lowestRead, head: liveHead, missed });
  return {
    /** Newest message the page is showing, and which source it came from. */
    newestBlock: newest ? newest.block : null,
    newestTs: newest ? newest.ts : null,
    newestSource: newest ? newest.source : null,
    /** How far the live read reached. null when the chain was never readable this session. */
    liveHead: liveHead ?? null,
    liveReadAt: liveReadAt ?? null,
    /** The lowest block read so far — the other end of the interval the page can speak about. */
    lowestRead: lowestRead ?? null,
    /** When the snapshot file was generated (epoch ms; ISO or numeric, per snapshots.js). */
    snapshotAsOf: snapAt,
    /** The newest block/message the snapshot alone contained. */
    snapshotNewestBlock,
    /** Did the live read actually surface anything the snapshot did not have? */
    liveIsAhead: !!(newestLive && (!snapshot || !snapshot.messages || !snapshot.messages.length || newestLive.block > snapshotNewestBlock)),
    /**
     * Whether "no message newer than the snapshot" is a claim the page has EARNED.
     *
     * Carried here rather than recomputed in the renderer so there is exactly one definition of the
     * condition and the label cannot drift from it. See messageCoverage() for why this exists.
     */
    coverage,
    coverageComplete: coverage.complete,
    /** How many blocks between the snapshot and the lowest block read are still unread. */
    uncoveredBlocks: coverage.complete ? 0 : coverage.missing,
    /** Total age of the newest message on screen, in hours. */
    newestAgeHours: newest ? (now / 1000 - newest.ts) / 3600 : null,
  };
}
