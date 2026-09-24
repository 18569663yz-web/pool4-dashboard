// Pin down exactly when the sIMD book ratio moved, and by how much.
// Two questions: (a) where did 1.0 -> 7.90 come from?  (b) when did it stop moving?
import { Rpc, encodeCall, decodeReturns, fmt18, fmtUnits } from "../lib/evm.js";
import { ADDR } from "../lib/contracts.js";

const rpc = new Rpc(
  ["https://eth.drpc.org", "https://gateway.tenderly.co/public/mainnet", "https://rpc.mevblocker.io", "https://eth-mainnet.public.blastapi.io"],
  { timeoutMs: 30000 }
);
const hx = (n) => "0x" + BigInt(n).toString(16);

async function ratioAt(blk) {
  const tag = typeof blk === "number" ? hx(blk) : blk;
  const out = await rpc.batch([
    { method: "eth_call", params: [{ to: ADDR.simd, data: encodeCall("totalAssets()") }, tag] },
    { method: "eth_call", params: [{ to: ADDR.simd, data: encodeCall("totalSupply()") }, tag] },
  ]);
  if (out.some((o) => !o.ok)) return null;
  const a = decodeReturns(["uint256"], out[0].result)[0];
  const s = decodeReturns(["uint256"], out[1].result)[0];
  return { a, s, r: s > 0n ? (a * 10n ** 24n) / s : 0n };
}

/** binary-search the last block at which the ratio differed from `target` */
async function lastChange(lo, hi, target) {
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const v = await ratioAt(mid);
    if (!v) return { block: null, note: "archive miss" };
    if (v.r === target) hi = mid;
    else lo = mid;
  }
  return { block: hi };
}

console.log("=== (a) the 1.0 -> 7.90 jump: dense scan of the first day ===");
const A0 = 25887100;
const A1 = 25896500;
let prev = null;
for (let i = 0; i <= 24; i++) {
  const blk = A0 + Math.round(((A1 - A0) * i) / 24);
  const v = await ratioAt(blk);
  if (!v) {
    console.log(`  #${blk}  (archive miss)`);
    continue;
  }
  const mark = prev && v.r !== prev.r ? "  <-- RATIO MOVED" : "";
  console.log(`  #${blk}  assets=${fmt18(v.a, 4).padStart(16)}  supply=${fmtUnits(v.s, 24, 4).padStart(16)}  ratio=${fmt18(v.r, 6)}${mark}`);
  prev = v;
  await new Promise((r) => setTimeout(r, 150));
}

console.log("\n=== (b) when did the ratio freeze? ===");
const cur = await ratioAt("latest");
console.log(`  latest ratio = ${fmt18(cur.r, 9)}`);
const res = await lastChange(25960000, 26036500, cur.r);
if (res.block) {
  const before = await ratioAt(res.block - 1);
  const after = await ratioAt(res.block);
  console.log(`  ratio last changed at block ${res.block}`);
  console.log(`    #${res.block - 1}  ratio=${fmt18(before.r, 9)}  assets=${fmt18(before.a, 4)}  supply=${fmtUnits(before.s, 24, 4)}`);
  console.log(`    #${res.block}      ratio=${fmt18(after.r, 9)}  assets=${fmt18(after.a, 4)}  supply=${fmtUnits(after.s, 24, 4)}`);
  console.log(`  last Trimmed was block 25964166, last ClaimsSettled 25964244`);
}

console.log("\n=== (c) how much of the ratio is reward flow vs a one-off? ===");
const at = async (b) => ratioAt(b);
const p1 = await at(25896439);
const p2 = await at(25971152);
console.log(`  #25896439 ratio=${fmt18(p1.r, 9)} supply=${fmtUnits(p1.s, 24, 4)}`);
console.log(`  #25971152 ratio=${fmt18(p2.r, 9)} supply=${fmtUnits(p2.s, 24, 4)}`);
console.log(`  hook lifetime totalRewarded = 5,162.51 IMD; distributor stakingEarned = 1,548.75 IMD`);
