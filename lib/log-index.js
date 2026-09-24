/**
 * Merging a fresh log scan into the existing event index.
 *
 * Extracted from scripts/index-logs.mjs so the boundaries can be tested directly. They
 * deserve it: the carry-over rule decides whether previously indexed history survives, and
 * getting it wrong loses data silently — the index simply has fewer events than before, and
 * every consumer downstream reports a smaller, plausible-looking history.
 *
 * The rule is "keep what this scan did not cover":
 *
 *   carry over  ⟺  block < start  OR  block > head
 *
 * The second half matters. When `head < start` — a lagging endpoint, a reorged tip, a
 * misconfigured chain — the scan loop does not execute at all, so nothing is covered and
 * everything must be carried over. Testing `block < start` alone looks equivalent in the
 * normal case and quietly drops the whole [start, prevScanTo] range in the abnormal one.
 */

/** Block number of a log object, from its hex `blockNumber`. */
export const logBlock = (l) => parseInt(l.blockNumber, 16);

/** Was this log inside the range the current scan actually covered? */
export function isWithinScan(block, start, head) {
  return block >= start && block <= head;
}

/**
 * @param {object} opts
 * @param {Record<string,string>} opts.topic0ByName event name -> topic0 hash
 * @param {Record<string,string>} opts.signatures   event name -> human-readable signature
 * @param {(topic0:string) => string|undefined} opts.nameByTopic reverse lookup
 * @param {object} [opts.prevEvents] the previous index's `events`
 * @param {any[]} [opts.freshLogs]   logs from this scan
 * @param {number} opts.start        first block this scan covered
 * @param {number} opts.head         last block this scan covered
 * @returns {{events:object, carried:number, unknown:number, indexedLogs:number}}
 */
export function mergeEventIndex({ topic0ByName, signatures, nameByTopic, prevEvents = {}, freshLogs = [], start, head }) {
  const events = {};
  for (const [name, topic0] of Object.entries(topic0ByName)) {
    events[name] = { topic0, signature: signatures[name], logs: [] };
  }

  let carried = 0;
  for (const [name, prev] of Object.entries(prevEvents || {})) {
    if (!events[name]) continue; // an event type that is no longer indexed
    for (const l of prev.logs || []) {
      if (!isWithinScan(logBlock(l), start, head)) {
        events[name].logs.push(l);
        carried++;
      }
    }
  }

  let unknown = 0;
  for (const l of freshLogs) {
    const name = nameByTopic((l.topics?.[0] || "").toLowerCase());
    if (!name) {
      unknown++;
      continue;
    }
    events[name].logs.push(l);
  }

  // Defensive: (blockNumber, logIndex) is unique chain-wide, so this only fires if a
  // previous index was written with overlapping windows.
  const seen = new Set();
  for (const e of Object.values(events)) {
    e.logs = e.logs.filter((l) => {
      const key = l.blockNumber + ":" + (l.logIndex || "0x0");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    e.logs.sort((a, b) => logBlock(a) - logBlock(b) || parseInt(a.logIndex || "0x0", 16) - parseInt(b.logIndex || "0x0", 16));
    e.count = e.logs.length;
  }

  const indexedLogs = Object.values(events).reduce((n, e) => n + e.count, 0);
  return { events, carried, unknown, indexedLogs };
}

/**
 * Where an incremental scan should resume.
 *
 * `scanFrom` is the floor of the whole index and never moves; resuming from it would rescan
 * everything. `scanTo` is where the previous run stopped, so that is the resume point, minus
 * a margin so a reorg at the tip cannot leave a hole.
 */
export function resumePoint({ prevScanTo, floor, margin = 200, force = false }) {
  if (force || !prevScanTo) return floor;
  return Math.max(floor, prevScanTo - margin);
}

/**
 * Is a chain head that is behind the indexed height plausible?
 *
 * Endpoints lag each other by a few blocks all the time, so a small gap is normal and the
 * index should simply not move backwards. A large one is not lag: it means the wrong chain,
 * a broken endpoint, or a corrupted index — and continuing would rewrite history with a
 * shorter one.
 */
export function classifyHead({ head, prevScanTo, tolerance = 100 }) {
  if (!prevScanTo) return "first-run";
  if (head >= prevScanTo) return "ok";
  if (prevScanTo - head <= tolerance) return "lagging";
  return "behind";
}

/**
 * Where the index claims to reach after this run.
 *
 * Never backwards: a momentarily lower head (endpoint lag, a reorg being resolved) must not
 * make the next run rescan from a lower point, and must not make the index look like it
 * covers less than it does.
 */
export function nextScanTo(head, prevScanTo = 0) {
  return Math.max(head, prevScanTo || 0);
}
