/**
 * The forward simulator, as a pure function so it can be unit-tested.
 *
 * Every formula here mirrors CappedBurnHook.sol; the line numbers are the contract's.
 *   held          = L * (sqrtP - sqrtLower) / 2^96          L337-342 (getAmount1Delta, floors)
 *   ratchet target= cap - (cap - held) * ratchetBps / 10000 L963
 *   rate floor    = cap - capDecayTokensPerDay*elapsed/86400 L966-968
 *   capFloor      = capFloor                                 L969
 *   excess        = held - cap                               L991
 *   liquidityOut  = floor(L * excess / held)                 L997
 *   rewarded      = floor(removed * rewardShareBps / 10000)  L1033
 *   burned        = removed - rewarded                       L1034
 */

export const Q96 = 1n << 96n;
const SCALE = 10n ** 9n;

export function isqrt(n) {
  if (n < 0n) throw new Error("isqrt of negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** Human IMD (may be fractional) -> 18-decimal wei, without float drift at these magnitudes. */
export function imdToWei(v) {
  const neg = v < 0;
  const abs = Math.abs(v);
  const whole = Math.floor(abs);
  const frac = Math.round((abs - whole) * 1e6);
  const wei = BigInt(whole) * 10n ** 18n + BigInt(frac) * 10n ** 12n;
  return neg ? -wei : wei;
}

/**
 * @param {object} p protocol state, all bigints except nowSec
 * @param {object} i inputs: inflowWei (bigint), pricePct (number)
 */
export function simulate(p, i) {
  const { positionLiquidity: L, heldNow, capNow, capFloor, sqrtPriceX96: sqrtP, ratchetBps, capDecayTokensPerDay, lastCapDecayAt, minTrimTokens, rewardShareBps, nowSec } = p;

  if (!L || L === 0n || !sqrtP || sqrtP === 0n) {
    return { error: "market position is empty or price unavailable" };
  }

  // Price scaling without needing sqrtLower.
  //
  //   held = L * (sqrtP - sqrtLower) / 2^96
  //   held' = L * (sqrtP*k - sqrtLower) / 2^96      where k = sqrt(1 + p)
  //   held' - held = L * sqrtP * (k - 1) / 2^96
  //
  // The delta depends only on quantities we have on chain, so a zero price change
  // reproduces `held` exactly instead of drifting by a wei from inverting sqrtLower.
  const ratioScaled = BigInt(Math.max(1, Math.round((1 + i.pricePct / 100) * 1e9)));
  const kScaled = isqrt(ratioScaled * SCALE); // sqrt(1+p) * 1e9
  const sqrtPNew = (sqrtP * kScaled) / SCALE;
  const delta = (L * sqrtP * (kScaled - SCALE)) / (Q96 * SCALE); // signed
  const heldAfterPrice = heldNow + delta;
  const held = heldAfterPrice + i.inflowWei;
  if (held < 0n) return { error: "net outflow larger than the position" };

  // Informational only: the position's implied lower bound, recovered for display.
  const sqrtLowerApprox = sqrtP - (heldNow * Q96) / L;

  // --- ratchet branch (L960-989): only when held < cap ---
  let cap = capNow;
  let ratcheted = false;
  let ratchetTarget = null;
  let rateFloor = null;
  if (held < cap) {
    const gap = cap - held;
    ratchetTarget = cap - (gap * ratchetBps) / 10000n; // L963
    const elapsed = BigInt(Math.max(0, Math.floor(nowSec) - Number(lastCapDecayAt))); // L965
    const allowance = (capDecayTokensPerDay * elapsed) / 86400n; // L966
    rateFloor = cap > allowance ? cap - allowance : 0n; // L967
    let next = ratchetTarget;
    if (next < rateFloor) next = rateFloor; // L968
    if (next < capFloor) next = capFloor; // L969
    if (next < cap) {
      // L971
      cap = next;
      ratcheted = true;
    }
  }

  // --- trim branch (L991-1007) ---
  const excess = held > cap ? held - cap : 0n; // L991
  const belowMin = excess < minTrimTokens; // L992
  const willTrim = excess > 0n && !belowMin;
  const liquidityToRemove = willTrim ? (L * excess) / held : 0n; // L997
  const rewarded = willTrim ? (excess * rewardShareBps) / 10000n : 0n; // L1033
  const burned = willTrim ? excess - rewarded : 0n; // L1034
  const positionLiquidityAfter = L - liquidityToRemove; // L1001

  return {
    sqrtLowerApprox,
    sqrtPNew,
    heldAfterPrice,
    held,
    cap,
    capBefore: capNow,
    ratcheted,
    ratchetTarget,
    rateFloor,
    excess,
    belowMin,
    willTrim,
    liquidityToRemove,
    positionLiquidityAfter,
    burned,
    rewarded,
    gapAfter: cap > held ? cap - held : 0n,
    stateAfter: held > cap ? "LIVE" : cap === capFloor ? "DORMANT" : "CRITICAL",
  };
}

/**
 * Walk `days` forward, adding `perDayWei` each day and trimming whenever the cap is breached.
 * This is a deliberately simple accumulation, not an AMM replay — see NOTES.md §14.
 */
export function simulateHorizon(p, { startHeld, startCap, perDayWei, days }) {
  let held = startHeld;
  let cap = startCap;
  let fired = 0;
  let totalBurned = 0n;
  let totalRewarded = 0n;
  let firstFireDay = null;
  const events = [];
  const maxDays = Math.min(days, 3650);
  for (let day = 1; day <= maxDays; day++) {
    held += perDayWei;
    if (held > cap) {
      const ex = held - cap;
      const rw = (ex * p.rewardShareBps) / 10000n;
      totalBurned += ex - rw;
      totalRewarded += rw;
      events.push({ day, excess: ex, burned: ex - rw });
      held = cap; // the trim leaves the position exactly at the cap
      fired++;
      if (firstFireDay === null) firstFireDay = day;
    }
  }
  return { fired, firstFireDay, totalBurned, totalRewarded, endHeld: held, endCap: cap, events: events.slice(0, 50) };
}
