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
 *
 * NOTE: this answers "how old is the single worst source?". That is the right question for
 * deciding whether ONE figure can still be trusted, and the wrong question for describing a
 * PARTIAL outage — see snapshotAges() below, which exists because of exactly that difference.
 * Its return shape is asserted by scripts/selftest.mjs and its call-site text is parsed by
 * scripts/check-last-trim.mjs, so it is kept byte-for-byte compatible on purpose.
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

/**
 * Every monitored source with its own age, plus how many are past the threshold.
 *
 * WHY THIS IS A SEPARATE FUNCTION, NOT A CHANGE TO oldestSnapshot()
 *
 * The banner used to report only the single oldest source. That is correct arithmetic and a
 * misleading sentence, because a refresh job can fail per-step rather than all at once. The
 * real project state on 2026-09-25 was exactly that shape and was measured twice, minutes
 * apart, while this was written:
 *
 *     one reading:  timeline fresh, base/volume/messages/bridge-history ~9.3h stale
 *     later:        timeline/volume/bridge-history fresh, base/messages ~9.4h stale
 *
 * Both readings light the banner and both honestly report "base, 9.4h" — while hiding that
 * OTHER sources were stale too, and that the set of stale ones MOVED between readings. A page
 * that says "the oldest source is 9.4h old" while three of six are frozen is not lying about
 * any number; it is lying by omission about the extent. Partial failure is harder to notice
 * than total failure precisely because the page still shows fresh-looking data, so the banner
 * has to be able to say "N of M are stale, here they are".
 *
 * Kept alongside rather than merged into oldestSnapshot() for a second, practical reason:
 * oldestSnapshot()'s `{name, ageHours}` shape is asserted by scripts/selftest.mjs and its call
 * site is textually parsed by scripts/check-last-trim.mjs. Widening its return value would
 * quietly change what a guard reads.
 *
 * Calling this is NOT the same as deciding that any particular sentence on the page is stale.
 * The page's "X ago or more recent" qualifier asks whether the TIMELINE could have missed a
 * burn; that is a question about one source, not about the worst of six. Reporting coverage
 * and judging reliability are different questions and must not share a scalar.
 *
 * @param {Record<string, any>} sources name → parsed snapshot (missing/silent ones are skipped)
 * @param {number} [now]
 * @param {number} [thresholdHours] ages above this count as stale
 * @returns {{all: Array<{name: string, ageHours: number}>, stale: Array<{name: string, ageHours: number}>,
 *            staleCount: number, total: number, oldest: {name: string, ageHours: number}|null}}
 *          `all` is sorted oldest-first; `oldest` is identical to oldestSnapshot()'s result.
 */
export function snapshotAges(sources, now = Date.now(), thresholdHours = Infinity) {
  const all = [];
  for (const [name, obj] of Object.entries(sources || {})) {
    const at = snapshotTimestamp(obj);
    if (at === null) continue;
    all.push({ name, ageHours: (now - at) / 3_600_000 });
  }
  /* Ties broken by name so the order is deterministic across runs — the banner takes the first
   * few stale names, and an unstable order would make its text flicker between refreshes
   * without any data changing. */
  all.sort((a, b) => (b.ageHours !== a.ageHours ? b.ageHours - a.ageHours : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const stale = all.filter((s) => s.ageHours > thresholdHours);
  return { all, stale, staleCount: stale.length, total: all.length, oldest: all[0] || null };
}
