// Triple verification of the sIMD ownership claim, plus a per-contract owner audit.
//
// The dashboard previously hard-coded "renounceOwnership 未调用" without reading
// simd.owner() at all. That was wrong. This script establishes the facts:
//
//   1. the receipt of the cited tx actually called StakedIMD.renounceOwnership()
//   2. archived eth_call shows owner() flipping from the EOA to 0x0 across that block
//   3. owner() still reads 0x0 now
//
//   node scripts/verify-ownership.mjs
import { Rpc, encodeCall, decodeReturns, keccak256Hex, utf8ToBytes } from "../lib/evm.js";
import { ADDR } from "../lib/contracts.js";

const ARCHIVE = [
  "https://eth.drpc.org",
  "https://gateway.tenderly.co/public/mainnet",
  "https://eth-mainnet.public.blastapi.io",
  "https://rpc.mevblocker.io",
  "https://eth-pokt.nodies.app",
];
const rpc = new Rpc(ARCHIVE, { timeoutMs: 30000 });
const hx = (n) => "0x" + BigInt(n).toString(16);

const TX = "0x519fdbdd5b504476efe91f31a20b4091aeb15cb7caed51071151d3ee87b81851";
const RENOUNCE = "0x" + keccak256Hex(utf8ToBytes("renounceOwnership()")).slice(2, 10);
const ZERO = "0x0000000000000000000000000000000000000000";

console.log("=== 1. what did that transaction actually do? ===");
console.log(`  renounceOwnership() selector = ${RENOUNCE}`);
const tx = await rpc.call("eth_getTransactionByHash", [TX]);
if (!tx) {
  console.log("  tx not found");
} else {
  const receipt = await rpc.call("eth_getTransactionReceipt", [TX]);
  const block = parseInt(tx.blockNumber, 16);
  console.log(`  block      ${block}`);
  console.log(`  from       ${tx.from}`);
  console.log(`  to         ${tx.to}`);
  console.log(`  status     ${receipt ? (parseInt(receipt.status, 16) === 1 ? "success" : "FAILED") : "?"}`);
  console.log(`  calldata   ${tx.input.slice(0, 10)}  (${(tx.input.length - 2) / 2} bytes)`);
  const sel = tx.input.slice(0, 10).toLowerCase();
  console.log(`  calls StakedIMD.renounceOwnership()? ${sel === RENOUNCE.toLowerCase() && tx.to.toLowerCase() === ADDR.simd ? "YES" : "NO"}`);
  if (receipt) {
    const logs = receipt.logs || [];
    console.log(`  logs       ${logs.length}`);
    for (const l of logs) {
      console.log(`    topic0 ${l.topics[0]}  addr ${l.address}`);
    }
    // Solady Ownable emits OwnershipTransferred(address indexed previousOwner, address indexed newOwner)
    const OWNERSHIP = "0x" + keccak256Hex(utf8ToBytes("OwnershipTransferred(address,address)")).slice(2, 10);
    const ev = logs.find((l) => l.topics[0].toLowerCase().startsWith(OWNERSHIP.toLowerCase()));
    if (ev) {
      const prev = "0x" + ev.topics[1].slice(26);
      const next = "0x" + ev.topics[2].slice(26);
      console.log(`  OwnershipTransferred: ${prev} -> ${next}`);
      console.log(`  ⇒ new owner is the zero address? ${next.toLowerCase() === ZERO ? "YES — renounced" : "NO"}`);
    }
  }
}

console.log("\n=== 2. owner() before and after that block (archived eth_call) ===");
const ownerAt = async (addr, block) => {
  try {
    const raw = await rpc.ethCall(addr, encodeCall("owner()"), hx(block));
    return decodeReturns(["address"], raw)[0];
  } catch (e) {
    return "ERR: " + String(e.message).slice(0, 50);
  }
};
const txBlock = tx ? parseInt(tx.blockNumber, 16) : 26014070;
for (const [label, blk] of [["before (block-1)", txBlock - 1], ["at tx block", txBlock], ["after (block+1)", txBlock + 1]]) {
  const o = await ownerAt(ADDR.simd, blk);
  console.log(`  StakedIMD.owner() ${label.padEnd(18)} block ${blk}: ${o}`);
}

console.log("\n=== 3. owner() right now ===");
const now = await ownerAt(ADDR.simd, await rpc.blockNumber());
console.log(`  StakedIMD.owner() = ${now}`);
console.log(`  renounced? ${now.toLowerCase() === ZERO ? "YES" : "NO"}`);

console.log("\n=== per-contract owner audit ===");
const CONTRACTS = [
  ["StakedIMD (sIMD)", ADDR.simd],
  ["RewardDripper", ADDR.dripper],
  ["CappedBurnHook", ADDR.hook],
  ["RewardDistributor", ADDR.distributor],
  ["BurnExecutor", ADDR.burnExecutor],
  ["$IMD (BridgedFP)", ADDR.imd],
];
const rows = [];
for (const [name, addr] of CONTRACTS) {
  const o = await ownerAt(addr, await rpc.blockNumber());
  const renounced = typeof o === "string" && o.toLowerCase() === ZERO;
  let extra = "";
  if (renounced) {
    // confirm the powers really are gone: these should now revert
    for (const [sig, label] of [
      ["rescueERC20(address,address,uint256)", "rescueERC20"],
      ["setPaused(bool)", "setPaused"],
      ["emergencyWithdraw(address)", "emergencyWithdraw"],
      ["closeMarket(address)", "closeMarket"],
      ["rescueToken(address,uint256)", "rescueToken"],
    ]) {
      try {
        await rpc.ethCall(addr, encodeCall(sig, sig.includes("bool") ? ["bool"] : sig.includes("uint256)") && sig.startsWith("rescueERC20") ? ["address", "address", "uint256"] : ["address"], sig.includes("bool") ? [false] : sig.startsWith("rescueERC20") ? [ZERO, ZERO, 0n] : [ZERO]));
        extra += ` ${label}=reachable`;
      } catch (e) {
        const msg = String(e.message);
        if (/revert|OwnableUnauthorized|Unauthorized/i.test(msg)) extra += ` ${label}=BLOCKED`;
        else extra += ` ${label}=?`;
      }
    }
  }
  rows.push({ name, addr, owner: o, renounced, extra });
  console.log(`  ${name.padEnd(20)} ${String(o).padEnd(44)} ${renounced ? "RENOUNCED" : "EOA-controlled"}${extra}`);
}

console.log("\n=== summary for the dashboard ===");
for (const r of rows) {
  console.log(`  ${r.name.padEnd(20)} ${r.renounced ? "资金不可被 owner 提取（已 renounce）" : "owner 仍是 EOA —— 提取权仍然有效"}`);
}
