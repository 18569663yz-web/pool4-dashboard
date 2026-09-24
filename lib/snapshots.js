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

/** @returns {number|null} epoch milliseconds of the snapshot's own build time */
export function snapshotTimestamp(obj) {
  if (!obj || typeof obj !== "object") return null;
  for (const field of TIMESTAMP_FIELDS) {
    const v = obj[field];
    if (typeof v === "string" && v) {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
    if (typeof v === "number" && v > 1e9) return v * 1000; // epoch seconds
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
