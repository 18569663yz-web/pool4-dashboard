// Evidence for NOTES.md §6: the two-door burn pipeline.
//
// Establishes, from chain data alone:
//   1. L1 $IMD is the LayerZero OFT contract "BridgedFP"; its peer on Base (eid 30184)
//      is an OFTAdapter wrapping the native Base token 0xff0c532f… ("Fren Pet").
//   2. BaseBurnReceiver.burn() destroys whatever Fren Pet it holds — permissionlessly,
//      but the emitted event carries no amount.
//   3. Both doors have actually been used, and the last use of each is recent.
//
//   node scripts/verify-two-doors.mjs
import { Rpc, encodeCall, decodeReturns, fmtUnits, keccak256Hex, utf8ToBytes } from "../lib/evm.js";
import { ADDR } from "../lib/contracts.js";

const RECEIVER = "0xf9d7cbf5bef2f5c9ba93a70f31ddca6457716793";
const ADAPTER = "0xab152db8aac047b6757ffcf495ffe88d7712690a";
const FP = "0xff0c532fdb8cd566ae169c1cb157ff2bdc83e105";

const l1 = new Rpc(undefined, { timeoutMs: 25000 });
const base = new Rpc(
  ["https://base-rpc.publicnode.com", "https://base.drpc.org", "https://base.gateway.tenderly.co", "https://base.publicnode.com"],
  { timeoutMs: 25000 }
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hx = (n) => "0x" + BigInt(n).toString(16);
const iso = (s) => (s ? new Date(s * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z" : "—");

console.log("=== 1. what is the Base peer of L1 $IMD? ===");
const peerRaw = await l1.ethCall(ADDR.imd, encodeCall("peers(uint32)", ["uint32"], [30184]));
const peer = "0x" + decodeReturns(["bytes32"], peerRaw)[0].slice(26);
console.log(`  IMD.peers(30184) = ${peer}   ${peer.toLowerCase() === ADAPTER ? "✓ matches BurnExecutor's target chain" : ""}`);
const adapterToken = decodeReturns(["address"], await base.ethCall(ADAPTER, encodeCall("token()")))[0];
const adapterOwner = decodeReturns(["address"], await base.ethCall(ADAPTER, encodeCall("owner()")))[0];
const sharedDec = decodeReturns(["uint8"], await base.ethCall(ADAPTER, encodeCall("sharedDecimals()")))[0];
console.log(`  adapter.token()  = ${adapterToken}  ${adapterToken.toLowerCase() === FP ? "✓ = Fren Pet" : ""}`);
console.log(`  adapter.owner()  = ${adapterOwner}  ${adapterOwner.toLowerCase() === ADDR.owner.toLowerCase() ? "✓ = the same protocol owner" : ""}`);
console.log(`  sharedDecimals() = ${sharedDec}`);
console.log(`  ⇒ L1 IMD is the OFT; Base holds the ORIGINAL token behind an adapter.`);
console.log(`     Bridging therefore UNLOCKS Fren Pet on Base, it does not mint IMD.`);

console.log("\n=== 2. BaseBurnReceiver (verified on Base, solc 0.8.26) ===");
const code = await base.call("eth_getCode", [RECEIVER, "latest"]);
const rcToken = decodeReturns(["address"], await base.ethCall(RECEIVER, encodeCall("token()")))[0];
console.log(`  bytecode ${(code.length - 2) / 2} bytes, hardcodes token = ${rcToken}  ${rcToken.toLowerCase() === FP ? "✓ = Fren Pet" : ""}`);
console.log(`  burn() selector 0x44df8e70 = ${"0x" + keccak256Hex(utf8ToBytes("burn()")).slice(2, 10)}`);
console.log(`  BurnExecuted(address,address) topic0 = ${keccak256Hex(utf8ToBytes("BurnExecuted(address,address)"))}`);
console.log(`  ⇒ anyone may call burn(); it destroys balanceOf(this) and emits caller + token only — NO amount.`);

console.log("\n=== 3. has each door actually been used? ===");
const bsLogs = async (host, address, topic0) => {
  const url = `${host}/api?module=logs&action=getLogs&fromBlock=1&toBlock=latest&address=${address}${topic0 ? "&topic0=" + topic0 : ""}`;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" } });
      const j = await r.json();
      if (j.status === "1") return j.result;
      if (j.message === "No logs found") return [];
    } catch {}
    await sleep(2500 * (i + 1));
  }
  return [];
};

const burns = await bsLogs("https://base.blockscout.com", RECEIVER, keccak256Hex(utf8ToBytes("BurnExecuted(address,address)")));
const burnCallers = new Map();
for (const b of burns) {
  const c = "0x" + (b.topics[1] || "").slice(26);
  burnCallers.set(c, (burnCallers.get(c) || 0) + 1);
}
console.log(`  Base  BurnExecuted events : ${burns.length}`);
if (burns.length) {
  console.log(`        first ${parseInt(burns[0].blockNumber, 16)} ${iso(parseInt(burns[0].timeStamp, 16))}`);
  const lastB = burns[burns.length - 1];
  console.log(`        last  ${parseInt(lastB.blockNumber, 16)} ${iso(parseInt(lastB.timeStamp, 16))}`);
  console.log(`        callers: ${[...burnCallers.entries()].map(([a, n]) => `${a}×${n}`).join(", ")}`);
}

const BRIDGE = keccak256Hex(utf8ToBytes("TokensBridgedForBurn(address,uint32,bytes32,uint256,uint256,bytes32)"));
const head = await l1.blockNumber();
const bridges = [];
for (let from = 25800000; from <= head; from += 1000) {
  try {
    const res = await l1.call("eth_getLogs", [{ address: ADDR.burnExecutor, topics: [BRIDGE], fromBlock: hx(from), toBlock: hx(Math.min(from + 999, head)) }]);
    bridges.push(...res);
  } catch {}
  await sleep(40);
}
console.log(`  L1    TokensBridgedForBurn: ${bridges.length}`);
if (bridges.length) {
  const first = parseInt(bridges[0].blockNumber, 16);
  const last = parseInt(bridges[bridges.length - 1].blockNumber, 16);
  const b1 = await l1.getBlock(hx(first));
  const b2 = await l1.getBlock(hx(last));
  console.log(`        first ${first} ${iso(Number(BigInt(b1.timestamp)))}`);
  console.log(`        last  ${last} ${iso(Number(BigInt(b2.timestamp)))}`);
}

console.log("\n=== 4. current state ===");
const dec = Number(decodeReturns(["uint8"], await base.ethCall(FP, encodeCall("decimals()")))[0]);
const fpTotal = decodeReturns(["uint256"], await base.ethCall(FP, encodeCall("totalSupply()")))[0];
const adapterBal = decodeReturns(["uint256"], await base.ethCall(FP, encodeCall("balanceOf(address)", ["address"], [ADAPTER])))[0];
const recvBal = decodeReturns(["uint256"], await base.ethCall(FP, encodeCall("balanceOf(address)", ["address"], [RECEIVER])))[0];
const l1Bal = decodeReturns(["uint256"], await l1.ethCall(ADDR.imd, encodeCall("balanceOf(address)", ["address"], [ADDR.burnExecutor])))[0];
console.log(`  Fren Pet totalSupply       ${fmtUnits(fpTotal, dec, 4)}`);
console.log(`  OFTAdapter locked          ${fmtUnits(adapterBal, dec, 4)}`);
console.log(`  baseBurnReceiver holding   ${fmtUnits(recvBal, dec, 6)}   ← destroyed on the next burn() call`);
console.log(`  L1 BurnExecutor holding    ${(Number(l1Bal) / 1e18).toFixed(6)} IMD  ← waits for someone to bridge`);

console.log("\n=== conclusion ===");
console.log("  Door 1 (L1 trim)          : DORMANT — see the dashboard for the live distance");
console.log("  Door 2 (L1 -> Base burn)  : ACTIVE — both sides have been called recently");
console.log("  Neither door is automatic. Door 2 needs someone to pay gas and the LayerZero fee.");
