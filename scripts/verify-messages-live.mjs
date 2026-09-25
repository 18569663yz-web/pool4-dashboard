// Proof that the live message read actually works, and that the snapshot really is behind.
//
// Runs the real lib/messages-live.js against mainnet, prints what it found with block numbers and
// timestamps, and puts the snapshot's newest message next to it for comparison. Read-only.
//
//   node scripts/verify-messages-live.mjs
//   node scripts/verify-messages-live.mjs --window 600 --json out.json
//
// Exit code is the result: 0 when the live read worked AND the merge kept the snapshot's
// annotations, non-zero when either fails. A verifier that prints a failure and exits 0 is worse
// than no verifier, because CI would call it green.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { Rpc } from "../lib/evm.js";
import {
  MESSAGE_ADDRESS,
  FIRST_WINDOW,
  CHUNK,
  scanMessages,
  mergeMessages,
  messageFreshness,
  nextWindow,
} from "../lib/messages-live.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const WINDOW = Number(argOf("--window", String(FIRST_WINDOW)));
const OUT = argOf("--json", null);

const iso = (sec) => new Date(sec * 1000).toISOString().replace("T", " ").slice(0, 19);
const clip = (s, n = 70) => String(s).replace(/\s+/g, " ").slice(0, n);

let pass = 0;
let fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}${detail ? "\n       " + detail : ""}`);
  }
};

const snapshot = JSON.parse(readFileSync(ROOT + "data/messages.json", "utf8"));
const rpc = new Rpc(undefined, { timeoutMs: 25000 });

console.log("=== the snapshot the page used to render ===");
console.log(`  fetchedAt   ${snapshot.fetchedAt}  (${((Date.now() - Date.parse(snapshot.fetchedAt)) / 3.6e6).toFixed(2)} hours ago)`);
console.log(`  newest msg  block ${snapshot.messages[0].block}  ${iso(snapshot.messages[0].ts)}`);
console.log(`  counts      txs ${snapshot.counts.txs} / decoded ${snapshot.counts.decoded} / undecodable ${snapshot.counts.undecodable}`);

const head = Number(BigInt(await rpc.call("eth_blockNumber")));
console.log(`\n=== chain head ===\n  block ${head}`);
console.log(`  the snapshot's newest message is ${head - snapshot.messages[0].block} blocks behind head`);

/* ---------- 1. the live scan ---------- */
console.log(`\n=== live scan: last ${WINDOW} blocks (${((WINDOW * 12) / 3600).toFixed(1)} hours) ===`);
const t0 = Date.now();
const scan = await scanMessages({ rpc, from: head - WINDOW + 1, to: head });
const ms = Date.now() - t0;
console.log(`  ${scan.batchCalls} batch call(s), ${ms}ms, covered=${scan.covered}`);
console.log(`  live messages decoded: ${scan.messages.length}`);
if (scan.missed.length) console.log(`  MISSED ${scan.missed.length} range(s): ${JSON.stringify(scan.missed.slice(0, 3))}`);

for (const m of scan.messages.slice().sort((a, b) => b.block - a.block)) {
  console.log(`\n  block ${m.block}  ${iso(m.ts)}  ${m.isDev ? "DEV " : "COMM"}${m.selfSend ? " self-send" : ""}`);
  console.log(`    from ${m.from}`);
  console.log(`    tx   ${m.tx}`);
  console.log(`    text ${JSON.stringify(clip(m.text, 300))}`);
}

/* ---------- 2. the merge ---------- */
console.log(`\n=== merged with the snapshot ===`);
const merged = mergeMessages({ snapshot, live: scan.messages });
console.log(`  snapshot ${merged.snapshotCount} + live ${merged.liveCount} (overlap ${merged.overlap}) -> ${merged.messages.length} rendered`);
console.log(`  newest on screen: block ${merged.messages[0].block}  ${iso(merged.messages[0].ts)}  source=${merged.messages[0].source}`);

const fr = messageFreshness({ merged, snapshot, liveHead: head, liveReadAt: Date.now() });
console.log(`  freshness: liveHead=${fr.liveHead}  liveIsAhead=${fr.liveIsAhead}  newestAgeHours=${fr.newestAgeHours.toFixed(2)}`);

/* The overlap is the interesting part: a message present in BOTH must not lose its annotation. */
const annotated = merged.messages.filter((m) => m.important).length;
const snapAnnotated = snapshot.messages.filter((m) => m.important).length;

/* ---------- 3. incremental window ---------- */
console.log(`\n=== incremental tick (the polling case) ===`);
const w = nextWindow({ head, lastSeen: head - 2 });
const inc = await scanMessages({ rpc, from: w.from, to: w.to });
console.log(`  lastSeen=${head - 2} -> next window ${w.from}..${w.to} = ${w.to - w.from + 1} block(s), ${inc.batchCalls} batch call(s), covered=${inc.covered}`);

/* ---------- 4. assertions ---------- */
console.log(`\n=== assertions ===`);
ok(`the live read covered the whole window (${WINDOW} blocks)`, scan.covered, JSON.stringify(scan.missed.slice(0, 3)));
ok("the live scan used batched requests, not one per block", scan.batchCalls <= Math.ceil(WINDOW / CHUNK) + 1, `${scan.batchCalls} batch calls for ${WINDOW} blocks (CHUNK=${CHUNK})`);
ok("the merge is sorted newest-first", merged.messages.every((m, i) => i === 0 || merged.messages[i - 1].block >= m.block));
ok("no duplicate blocks survive the merge", new Set(merged.messages.map((m) => m.block)).size === merged.messages.length);

/* The annotation-carry check is the one that would fail on a naive merge, so it is asserted
 * explicitly rather than eyeballed. */
ok(
  `the snapshot's ${snapAnnotated} block annotations survive the merge (found ${annotated})`,
  annotated >= snapAnnotated,
  `merge dropped ${snapAnnotated - annotated} annotation(s)`
);

/* Every snapshot message must still be present: the live layer adds, it does not replace. */
const snapBlocks = new Set(snapshot.messages.map((m) => m.block));
const kept = [...snapBlocks].filter((b) => merged.messages.some((m) => m.block === b)).length;
ok(`all ${snapBlocks.size} snapshot messages are still in the merged list`, kept === snapBlocks.size, `${snapBlocks.size - kept} lost`);

ok("the incremental window is small (only new blocks)", w.to - w.from + 1 <= 15, `${w.to - w.from + 1} blocks`);
ok("the incremental scan found no false messages", inc.messages.every((m) => m.from && m.tx && m.text));

/* If the live read surfaced something newer than the snapshot, that is the bug from the report —
 * worth calling out loudly, but it is not a REQUIRED outcome: the board is quiet most of the time
 * and a passing run must not depend on someone having posted in the last hour. */
if (fr.liveIsAhead) {
  const newOnes = merged.messages.filter((m) => m.source === "live" && m.block > snapshot.messages[0].block);
  console.log(`\n  ★ the chain is AHEAD of the snapshot by ${newOnes.length} message(s):`);
  for (const m of newOnes) console.log(`      block ${m.block}  ${iso(m.ts)}  ${JSON.stringify(clip(m.text, 60))}`);
} else {
  console.log(`\n  (the chain had nothing newer than the snapshot in this ${((WINDOW * 12) / 3600).toFixed(1)}h window — the board is quiet; not a failure)`);
}

if (OUT) {
  writeFileSync(
    OUT,
    JSON.stringify({ head, window: WINDOW, ms, scan, merged: { ...merged, liveBlocks: undefined }, freshness: fr }, null, 2)
  );
  console.log(`\nwrote ${OUT}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
