/**
 * Snapshot freshness.
 *
 * Everything historical on the page — the trim curve, the 24h/7d trends, the on-chain
 * message timeline — comes from pre-generated JSON that a scheduled job refreshes. If
 * that job stops working, the page keeps rendering happily with week-old history, which
 * is the most misleading failure mode this dashboard has: the numbers still look like
 * numbers.
 *
 * So the age of the oldest snapshot is computed here (pure, testable) and surfaced on the
 * page when it crosses the threshold.
 */

/** Each generator stamps its own field name; accept all of them. */
export const TIMESTAMP_FIELDS = ["builtAt", "scannedAt", "fetchedAt", "generatedAt"];

/**
 * @returns {number|null} epoch milliseconds of the snapshot's own build time
 *
 * A numeric timestamp is ambiguous, and the generators do not agree: the five
 * JSON snapshots write ISO strings, while collect.mjs (data/baseline.json) writes
 * Date.now() — milliseconds. The old rule was "> 1e9 means seconds", which is true
 * of milliseconds as well, so a millisecond stamp was multiplied by 1000 a second
 * time and landed in the year 58,701. Its age came out as −14.3 million hours, i.e.
 * "1600 years in the future" — and because oldestSnapshot() reports the OLDEST
 * source, a future-dated one is never the answer. Adding baseline.json to the
 * monitored set would therefore have silenced the staleness banner permanently,
 * which is the exact opposite of what that banner exists for.
 *
 * So decide on magnitude rather than on a threshold that both units cross. The
 * cutoff sits at 1e12: seconds since 1970 are ~1.8e9 today and will not reach
 * 1e12 for another 30,000 years, while milliseconds passed 1e12 in 2001. The
 * ambiguity is therefore resolved for every timestamp this project can produce.
 */
const MS_PER_SEC = 1000;
/** Below this, a numeric epoch stamp is seconds; at or above it, milliseconds. */
const MS_THRESHOLD = 1e12;

export function snapshotTimestamp(obj) {
  if (!obj || typeof obj !== "object") return null;
  for (const field of TIMESTAMP_FIELDS) {
    const v = obj[field];
    if (typeof v === "string" && v) {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      return v < MS_THRESHOLD ? v * MS_PER_SEC : v;
    }
  }
  return null;
}

/**
 * @param {Record<string, any>} sources name → parsed snapshot (missing ones are skipped)
 * @param {number} [now]
 * @returns {{name: string, ageHours: number}|null} the oldest one, or null if none are timestamped
 */
export function oldestSnapshot(sources, now = Date.now()) {
  let oldest = null;
  for (const [name, obj] of Object.entries(sources || {})) {
    const at = snapshotTimestamp(obj);
    if (at === null) continue;
    const ageHours = (now - at) / 3_600_000;
    if (!oldest || ageHours > oldest.ageHours) oldest = { name, ageHours };
  }
  return oldest;
}
