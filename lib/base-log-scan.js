/**
 * Scanning Base for BurnExecuted logs, resumably, with a scan watermark that is not the
 * same thing as "where the last burn was".
 *
 * WHY THIS EXISTS
 * ---------------
 * `base.json`'s Base half used to come from `base.blockscout.com`'s v1 `getLogs` endpoint in
 * one request (`fromBlock=1&toBlock=latest`). That upstream became unreachable, and because
 * `build-data.mjs` treats a missing Base half as "keep the previous file", the Base section of
 * the page silently stopped being current — the same shape of failure as the messages outage.
 * Reading the logs from a Base RPC removes the external HTTP dependency entirely.
 *
 * WHY THE WALK IS NOT `getLogs(from=1)` IN A LOOP
 * -----------------------------------------------
 * Measured against public Base RPCs, `eth_getLogs` is capped at a 2,000-block range:
 *
 *     mainnet.base.org        window 2000  -> ok
 *     base-rpc.publicnode.com window 2000  -> ok
 *     base.drpc.org           window 2000  -> "ranges over 10000 blocks are not supported"
 *     window 10000 / 100000 / 1..head      -> "eth_getLogs is limited to a 2,000 range"
 *
 * So the range has to be tiled, and the cost is set by where the tiling starts. Starting at
 * block 1 means 25,881 windows (~248 min sequential). The contract's own deploy block is the
 * correct floor, found with `eth_getCode` by binary search (25 probes, ~seconds) rather than by
 * scanning: **block 46,046,062**. That is 2,858 windows — 9.1x cheaper — and it is exact, not an
 * estimate. Cross-checked against the data: the first BurnExecuted event in the committed
 * snapshots is 231 blocks after this block, which is what "the contract was deployed and then
 * used immediately" looks like.
 *
 * Public nodes do answer `eth_getCode` at 46M-old blocks, so locating the floor needs no archive
 * access. `eth_getLogs` over a 2,000-block window works at the same depth.
 *
 * THE WATERMARK, AND WHY IT IS NOT THE LAST BURN
 * ----------------------------------------------
 * The obvious incremental design is "resume from the highest burn block we have". That is
 * wrong, and wrong in the worst way — silently, permanently:
 *
 *   - `burns` records where EVENTS are. A scan can advance all the way to head while finding
 *     no event at all (the average gap between burns is ~107,000 blocks), so the newest burn
 *     can sit far behind the newest scanned block;
 *   - worse, if a scan fails partway, the newest burn is still ahead of where the scan actually
 *     got to. Resuming from the burn would then skip every window in between — and the only
 *     symptom is a few missing rows in a historical chart.
 *
 * So the scan cursor (`scannedTo`) is stored separately from the event positions, and the
 * resume point is the MORE CONSERVATIVE of the two:
 *
 *     resumeFrom = min(scannedTo, lastBurnBlock) - margin
 *
 * The two watermarks fail differently — `scannedTo` is written progress, `lastBurnBlock` is
 * observed data — and taking the minimum defends against both. `margin` exists because the
 * windows immediately before the resume point are the ones most likely to have been lost to a
 * failure, and because reorgs rewrite recent blocks:
 *
 *   - failure margin: 4 windows. The caller retries twice and each window makes 3 attempts, so
 *     the last few windows are the ones at risk; 4 windows of slack covers them.
 *   - reorg margin: 1 window minimum. A reorg is a few blocks deep, but a 2,000-block window is
 *     the smallest unit this scan can re-read — re-scanning 5 blocks is not expressible. One
 *     window therefore dominates any realistic reorg depth at the cost of a single request.
 *
 * Neither margin is a heuristic about chain behaviour; both are sized against the smallest unit
 * the scan can actually operate on.
 */

import { scanLogWindows } from "./log-scan.js";
import { keccak256Hex, utf8ToBytes } from "./evm.js";

/** The Base burn receiver. Verified on Base, solc 0.8.26. */
export const BURN_RECEIVER = "0xf9d7cbf5bef2f5c9ba93a70f31ddca6457716793";

/**
 * `event BurnExecuted(address indexed caller, address indexed token)`.
 *
 * Carries NO amount — the amount only shows up as a falling totalSupply, which is why the page
 * reads `totalSupply()` separately. Derived, not pasted, so it cannot drift from the signature.
 */
export const BURN_TOPIC = keccak256Hex(utf8ToBytes("BurnExecuted(address,address)"));

/** Blocks per getLogs request. The public cap measured above is 2,000. */
export const WINDOW = 2000;

/** Windows of slack before the resume point, covering a failed tail. */
export const FAILURE_MARGIN_WINDOWS = 4;

/** Windows of slack for reorgs; 1 because a window is the smallest re-readable unit. */
export const REORG_MARGIN_WINDOWS = 1;

export const MARGIN_BLOCKS = (FAILURE_MARGIN_WINDOWS + REORG_MARGIN_WINDOWS) * WINDOW;

const hex = (n) => "0x" + Number(n).toString(16);

/**
 * Find the first block at which `address` has code, by binary search on `eth_getCode`.
 *
 * This is how the scan's floor is established without scanning, and without assuming an
 * archive node: public Base RPCs answer `eth_getCode` at 46M-old blocks. Returns `null` when
 * the address never has code within the range, so a typo'd address fails loudly instead of
 * producing an empty scan that looks like "no events".
 *
 * @param {(method:string, params:any[]) => Promise<any>} call
 * @param {string} address
 * @param {{low?:number, high:number}} range
 * @returns {Promise<number|null>}
 */
export async function findDeployBlock(call, address, { low = 1, high }) {
  const codeAt = async (block) => {
    const code = await call("eth_getCode", [address, hex(block)]);
    return typeof code === "string" && code !== "0x" && code.length > 2;
  };
  if (!(await codeAt(high))) return null;
  if (await codeAt(low)) return low; // deployed at or before `low`
  let lo = low;
  let hi = high;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await codeAt(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Where to resume scanning from, given what is already known.
 *
 * Exported and tested on its own because getting this wrong is silent: too high skips events,
 * too low merely re-reads. When in doubt it must err low.
 *
 * @param {object} opts
 * @param {number|null} opts.scannedTo   highest block known to have been scanned
 * @param {number|null} opts.lastBurnBlock highest block with a known burn event
 * @param {number} opts.deployBlock      floor; never scan before this
 * @param {number} [opts.margin]         blocks of slack
 * @returns {number}
 */
export function resumeFrom({ scannedTo, lastBurnBlock, deployBlock, margin = MARGIN_BLOCKS }) {
  const marks = [scannedTo, lastBurnBlock].filter((v) => Number.isFinite(v) && v !== null);
  // Nothing known yet: a cold start begins at the contract's first block.
  if (!marks.length) return deployBlock;
  const conservative = Math.min(...marks);
  return Math.max(deployBlock, conservative - margin);
}

/**
 * Scan a block range for BurnExecuted logs.
 *
 * Delegates the windowing/retry/failure reporting to `scanLogWindows`, which already exists for
 * exactly this reason (see its header: an unreported failed window is indistinguishable from a
 * chain that simply had no events). This function adds only what is Base-specific: the burn
 * topic, the window cap, and progress reporting for a long cold start.
 *
 * @param {object} opts
 * @param {(method:string, params:any[]) => Promise<any>} opts.call
 * @param {number} opts.from
 * @param {number} opts.to
 * @param {number} [opts.window]
 * @param {(msg:string)=>void} [opts.log] progress sink
 * @returns {Promise<{logs:object[], failures:object[], retries:number, windows:number, covered:boolean}>}
 */
export async function scanBaseBurns({ call, from, to, window = WINDOW, log = () => {} }) {
  if (from > to) return { logs: [], failures: [], retries: 0, windows: 0, covered: true };

  const total = Math.floor((to - from) / window) + 1;
  let done = 0;
  log(`scanning ${from}..${to} (${total} windows of ${window})`);

  const res = await scanLogWindows({
    from,
    to,
    window,
    fetchWindow: (a, b) =>
      call("eth_getLogs", [
        {
          address: BURN_RECEIVER,
          topics: [BURN_TOPIC],
          fromBlock: hex(a),
          toBlock: hex(b),
        },
      ]),
  });

  done = res.windows;
  log(`scanned ${done}/${total} windows, ${res.logs.length} burns, ${res.retries} retries, ${res.failures.length} failed windows`);

  return { ...res, covered: res.failures.length === 0 };
}

/**
 * The scan watermark to publish alongside the events.
 *
 * Only advances when every window answered. A partial scan must NOT move `scannedTo`, because
 * the holes it leaves are exactly what `resumeFrom` is trying to cover — advancing here would
 * convert a transient failure into permanently missing history.
 *
 * @param {object} opts
 * @param {number} opts.previous  the watermark already published
 * @param {number} opts.to        the block this run scanned up to
 * @param {boolean} opts.covered  did every window in this run answer?
 * @returns {number}
 */
export function nextScannedTo({ previous, to, covered }) {
  const prev = Number.isFinite(previous) ? previous : 0;
  return covered ? Math.max(prev, to) : prev;
}
