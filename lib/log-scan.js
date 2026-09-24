/**
 * Scanning a block range for one event topic, in windows, without ever dropping a window.
 *
 * Extracted from build-data.mjs for the same reason lib/log-index.js was extracted from
 * index-logs.mjs: the interesting behaviour is the failure path, and a failure path that
 * lives inline in a 300-line script can only be exercised by breaking the network.
 *
 * The bug this exists for: the L1 bridge scan was
 *
 *     try { bridgeLogs.push(...(await l1.call("eth_getLogs", [...]))); } catch {}
 *
 * One throttled window on CI dropped its events with no log line, no retry, and no trace.
 * The only symptom was verify-snapshots.mjs reporting one fewer bridge than the previous run
 * (62 → 61) — which reads like something that happened on chain, not like an HTTP request
 * that failed. Public endpoints rate-limit; 247 windows per run is plenty of chances.
 *
 * The contract here is deliberately the opposite of the old one: a window that never answers
 * is reported, and the caller decides. Silence is not an option the caller can fall into by
 * accident.
 */

/**
 * @param {object} opts
 * @param {(from:number, to:number) => Promise<any[]>} opts.fetchWindow one window; must throw on failure
 * @param {number} opts.from        first block, inclusive
 * @param {number} opts.to          last block, inclusive
 * @param {number} [opts.window]    blocks per request (default 1000)
 * @param {number} [opts.attempts]  tries per window (default 3)
 * @param {number} [opts.backoffMs] base delay between tries; grows linearly (default 400)
 * @param {(ms:number)=>Promise<void>} [opts.sleep]
 * @returns {Promise<{logs:any[], failures:{from:number,to:number,error:string}[], retries:number, windows:number}>}
 */
export async function scanLogWindows({
  fetchWindow,
  from,
  to,
  window = 1000,
  attempts = 3,
  backoffMs = 400,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const logs = [];
  const failures = [];
  let retries = 0;
  let windows = 0;

  for (let start = from; start <= to; start += window) {
    const end = Math.min(start + window - 1, to);
    windows++;
    let got = null;
    let lastErr = null;
    for (let attempt = 0; attempt < attempts && got === null; attempt++) {
      try {
        got = await fetchWindow(start, end);
      } catch (err) {
        lastErr = err;
        /* Counted only when another attempt actually follows, so `retries` means "requests
         * that had to be repeated" rather than "failures". */
        if (attempt < attempts - 1) {
          retries++;
          await sleep(backoffMs * (attempt + 1));
        }
      }
    }
    if (got === null) {
      failures.push({ from: start, to: end, error: String((lastErr && lastErr.message) || lastErr).slice(0, 120) });
    } else {
      logs.push(...got);
    }
  }

  return { logs, failures, retries, windows };
}
