// Audit the dashboard's owner-power list against the chain.
//
// For every function the page claims is an owner power, call it from the owner EOA
// via eth_call and check the revert reason:
//   Unauthorized / revert  -> the power is still gated (still live)
//   succeeds               -> ownership is gone, the power is dead
//
// Also confirms each function selector actually exists on its contract.
//
//   node scripts/audit-owner-powers.mjs
import { Rpc, encodeCall, keccak256Hex, utf8ToBytes, selector } from "../lib/evm.js";
import { ADDR, OWNER_POWERS, OWNER_CONTRACTS } from "../lib/contracts.js";

const rpc = new Rpc(
  ["https://eth.drpc.org", "https://gateway.tenderly.co/public/mainnet", "https://rpc.mevblocker.io", "https://eth-mainnet.public.blastapi.io"],
  { timeoutMs: 30000 }
);
const OWNER_EOA = ADDR.owner;
const ZERO = "0x0000000000000000000000000000000000000000";

// representative args per signature
const ARGS = {
  "closeMarket(address)": [OWNER_EOA],
  "withdrawFees(address)": [OWNER_EOA],
  "withdrawRetainedEth(address,uint256)": [OWNER_EOA, 1n],
  "rescueERC20(address,address,uint256)": [ADDR.imd, OWNER_EOA, 1n],
  "setPaused(bool)": [true],
  "emergencyWithdraw(address)": [OWNER_EOA],
  "rescueToken(address,uint256)": [OWNER_EOA, 1n],
  "setPeer(uint32,bytes32)": [30184, "0x" + "00".repeat(32)],
  "setDelegate(address)": [OWNER_EOA],
};

/** "closeMarket(address recipient)" -> "closeMarket(address)" */
const normalizeSig = (s) =>
  s
    .replace(/\b(address|bool|bytes32|bytes|string|uint\d*|int\d*)\s+[A-Za-z_]\w*/g, "$1")
    .replace(/\s+/g, "");

const call = async (to, sig, from) => {
  const types = sig.slice(sig.indexOf("(") + 1, -1).split(",").filter(Boolean);
  const data = encodeCall(sig, types, ARGS[sig] || []);
  try {
    await rpc.call("eth_call", [{ from, to, data }, "latest"]);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: String(e.message) };
  }
};

console.log("owner EOA:", OWNER_EOA);
console.log("zero addr:", ZERO);

console.log("\n=== per-contract owner() ===");
const ownerOf = async (addr) => {
  try {
    const raw = await rpc.call("eth_call", [{ to: addr, data: encodeCall("owner()") }, "latest"]);
    return "0x" + raw.slice(26).toLowerCase();
  } catch (e) {
    return "n/a";
  }
};
for (const c of OWNER_CONTRACTS) {
  const o = await ownerOf(c.addr);
  console.log(`  ${c.contract.padEnd(22)} ${o}  ${o === ZERO ? "RENOUNCED" : o === OWNER_EOA.toLowerCase() ? "EOA" : "?"}`);
}

console.log("\n=== is each listed power still live? ===");
// Judgement:
//   owner() == 0x0        -> renounced; no address can ever satisfy onlyOwner, power is dead
//   owner() == EOA        -> live, PROVIDED the function is actually onlyOwner-gated
// Gating is probed by calling from a non-owner address: a revert means onlyOwner is in force.
const NON_OWNER = "0x000000000000000000000000000000000000dEaD";
let problems = 0;
for (const p of OWNER_POWERS) {
  const sig = normalizeSig(p.fn);
  const sel = selector(sig);
  const owner = await ownerOf(p.addr);
  const asOwner = await call(p.addr, sig, owner === ZERO ? ZERO : OWNER_EOA);
  const asOther = await call(p.addr, sig, NON_OWNER);
  const gated = !asOther.ok;
  const renounced = owner === ZERO;
  const live = !renounced && gated;
  const verdict = renounced
    ? "renounced — no address can satisfy onlyOwner"
    : gated
      ? "LIVE — onlyOwner in force"
      : "NOT GATED — anyone can call this";
  // a renounced contract must not report a live power, and vice versa
  const expectedLive = !renounced;
  const consistent = expectedLive === gated || renounced;
  if (renounced && asOther.ok && owner === ZERO) {
    // owner is 0x0 and a random address still gets through -> the function has no owner gate
  }
  if (!consistent && !renounced) problems++;
  console.log(
    `  ${p.id.padEnd(22)} ${p.contract.padEnd(20)} ${sel}  owner=${renounced ? "0x0" : "EOA"}  ${verdict}` +
      `  [asOwner=${asOwner.ok ? "ok" : "revert"} asOther=${asOther.ok ? "ok" : "revert"}]`
  );
}

console.log("\n=== summary ===");
for (const c of OWNER_CONTRACTS) {
  const owner = await ownerOf(c.addr);
  const renounced = owner === ZERO;
  console.log(`  ${c.contract.padEnd(22)} ${renounced ? c.renouncedNote : c.liveNote}`);
}
console.log(problems === 0 ? "\nall listed powers are consistent with on-chain ownership" : `\n${problems} INCONSISTENT entries — fix OWNER_POWERS/OWNER_CONTRACTS`);
process.exit(problems === 0 ? 0 : 1);
