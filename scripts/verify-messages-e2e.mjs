// End-to-end proof that the message section updates itself from the chain.
//
//   node scripts/verify-messages-e2e.mjs
//   node scripts/verify-messages-e2e.mjs --url http://127.0.0.1:5173
//   node scripts/verify-messages-e2e.mjs --keep-open      # leave the browser up to look at it
//
// Starts the real static server, opens the real page in a real browser, and reads the message section
// out of the DOM — twice: once as soon as the page is up, and again after the background follower has
// had time to walk its first 300-block window. Then it reads the same blocks straight from Ethereum
// and checks that what the page shows is what the chain holds.
//
// Why this file exists rather than a screenshot: the whole feature is a DATA SOURCE change. The old
// page rendered its HTML perfectly — that was never the bug. So "does the section look right" proves
// nothing; what has to be shown is that the rendered text contains a message that exists on chain and
// did NOT exist in data/messages.json. That is the assertion below, and it is the only one that
// matters.
//
// It is written to pass EITHER WAY on the thing that is out of our control: the board averages 0.55
// messages a day, so a 300-block window usually contains none, and demanding one would make this test
// a coin flip. When the window is empty it verifies the fallback shape instead (snapshot rendered,
// source label honest, no fabrication) and says which branch it took.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rpc } from "../lib/evm.js";
import { scanMessages, mergeMessages, FIRST_WINDOW, MESSAGE_ADDRESS } from "../lib/messages-live.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const PORT = Number(argOf("--port", "5173"));
const URL_ = argOf("--url", `http://127.0.0.1:${PORT}/?lang=zh`);
/** The follower waits 2.5s before its first read, and a 300-block window takes seconds. */
const SETTLE_MS = Number(argOf("--settle", "45000"));
const KEEP_OPEN = process.argv.includes("--keep-open");

let pass = 0;
let fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (h) => String(h).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/* ---------- 1. the server ---------- */
const server = spawn(process.execPath, ["scripts/serve.mjs", String(PORT)], { cwd: ROOT, stdio: "ignore" });
let serverUp = false;
for (let i = 0; i < 40 && !serverUp; i++) {
  try {
    serverUp = (await fetch(`http://127.0.0.1:${PORT}/index.html`)).ok;
  } catch {
    await sleep(250);
  }
}
if (!serverUp) {
  server.kill();
  console.error("the static server never came up");
  process.exit(1);
}
console.log(`serving ${ROOT} at http://127.0.0.1:${PORT}/\n`);

/* ---------- 2. the browser ---------- */
const browser = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
].find((p) => existsSync(p));
if (!browser) {
  server.kill();
  console.error("no Chrome/Edge found");
  process.exit(1);
}

const CDP_PORT = 9456;
const profile = mkdtempSync(join(tmpdir(), "pool4-msg-e2e-"));
const chrome = spawn(
  browser,
  ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--window-size=1400,1600", "about:blank"],
  { stdio: "ignore" }
);

let up = false;
for (let i = 0; i < 80 && !up; i++) {
  try {
    up = (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok;
  } catch {
    await sleep(300);
  }
}
if (!up) {
  chrome.kill();
  server.kill();
  console.error("the browser never came up");
  process.exit(1);
}

/* Collect console errors: app.js catches its own render failures, so a silent failure would otherwise
 * be invisible — the page would simply render an empty section and this test would have nothing to
 * go on. */
const consoleErrors = [];
const info = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(URL_)}`, { method: "PUT" })).json();
const ws = new WebSocket(info.webSocketDebuggerUrl);
const pending = new Map();
let id = 1;
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    consoleErrors.push((m.params.args || []).map((a) => a.value || a.description || "").join(" ").slice(0, 200));
  }
  if (m.method === "Runtime.exceptionThrown") {
    consoleErrors.push("EXCEPTION " + String(m.params.exceptionDetails?.exception?.description || "").slice(0, 200));
  }
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
});
await new Promise((r) => ws.addEventListener("open", r));
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id: id++, method, params }));
  });
await send("Runtime.enable");
await send("Page.enable");

const evalIn = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.value;
};

/** Everything this test cares about, read out of the live DOM. */
const readDom = () =>
  evalIn(`(() => {
    const txt = (id) => ((document.getElementById(id) || {}).textContent || "").trim();
    const html = (id) => ((document.getElementById(id) || {}).innerHTML || "");
    return {
      lede: txt("messages-lede"),
      listHtml: html("messages-list"),
      listText: txt("messages-list"),
      latestText: txt("messages-latest"),
      latestCardShown: (document.getElementById("messages-latest-card") || {}).style
        ? document.getElementById("messages-latest-card").style.display !== "none"
        : false,
      tech: txt("messages-tech"),
      numberAll: txt("msgf-all-n"),
      numberDev: txt("msgf-dev-n"),
      numberComm: txt("msgf-community-n"),
      numberKey: txt("msgf-key-n"),
      blocksRendered: document.querySelectorAll("#messages-list .msg").length,
      staleBanner: txt("stale-banner"),
      rpcBanner: txt("rpc-banner"),
      rpcBannerClass: (document.getElementById("rpc-banner") || {}).className || "",
    };
  })()`);

/* ---------- 3. first paint, before the follower has finished ---------- */
await sleep(6000);
const early = await readDom();
console.log("=== first paint (before the live read lands) ===");
console.log(`  ${early.numberAll} messages, ${early.blocksRendered} rendered`);
console.log(`  lede: ${early.lede.slice(0, 200)}`);

/* ---------- 4. wait for the follower ---------- */
/* The wait must key on the LABEL reaching a settled state, not on a fixed duration. The follower's
 * first read goes out through lib/evm.js's two-pass failover (2 x 8 endpoints), so a slow or partly
 * throttled fleet can take appreciably longer than one pass — an earlier version of this script gave
 * it 45s and occasionally photographed the label mid-flight, reporting a failure that was really a
 * race. The ceiling is generous and the loop exits as soon as the answer is in. */
const SETTLED = /已含链上最新|没有比快照更新|不可用/;
console.log(`\n=== waiting up to ${(SETTLE_MS / 1000).toFixed(0)}s for the background live read ===`);
const deadline = Date.now() + SETTLE_MS;
let settled = null;
let last = early;
while (Date.now() < deadline) {
  await sleep(2500);
  last = await readDom();
  if (SETTLED.test(last.lede)) {
    settled = last;
    break;
  }
}
const dom = settled || last;
console.log(`  settled=${!!settled}  (after ~${((SETTLE_MS - (deadline - Date.now())) / 1000).toFixed(0)}s)`);
console.log(`  ${dom.numberAll} messages, ${dom.blocksRendered} rendered`);
console.log(`  lede: ${dom.lede.slice(0, 300)}`);

/* ---------- 5. what the chain says, independently ---------- */
console.log("\n=== reading the same window straight from Ethereum ===");
const snapshot = JSON.parse(readFileSync(ROOT + "data/messages.json", "utf8"));
const rpc = new Rpc(undefined, { timeoutMs: 25000 });
const head = Number(BigInt(await rpc.call("eth_blockNumber")));
const scan = await scanMessages({ rpc, from: head - FIRST_WINDOW + 1, to: head });
const merged = mergeMessages({ snapshot, live: scan.messages });

console.log(`  head ${head}   window ${head - FIRST_WINDOW + 1}..${head}   covered=${scan.covered}`);
console.log(`  chain messages in the window: ${scan.messages.length}`);
for (const m of scan.messages) {
  console.log(`    block ${m.block} ${new Date(m.ts * 1000).toISOString()} ${m.isDev ? "DEV " : "COMM"} ${JSON.stringify(m.text.slice(0, 70))}`);
}
console.log(`  the snapshot's newest: block ${snapshot.messages[0].block} (${(head - snapshot.messages[0].block).toLocaleString()} blocks behind head)`);

/* ---------- 6. assertions ---------- */
console.log("\n=== assertions ===");

/* The page must not have failed to boot into the section at all. */
ok("the message section rendered something", dom.blocksRendered > 0, `rendered ${dom.blocksRendered}`);
ok("the numbers show a non-empty list", Number(dom.numberAll) > 0, dom.numberAll);
ok("the 'latest from the dev' card is shown", dom.latestCardShown === true);
ok("no console error was logged by app.js", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));

/* The details block must describe the data path actually in use, and the old "this is only a
 * pre-generated snapshot" sentence must be gone — it would now be false. */
ok("the details block describes the live read", /eth_getBlockByNumber/.test(dom.tech), dom.tech.slice(0, 120));
ok("the details block names the mempool limit", /内存池|mempool/.test(dom.tech), dom.tech.slice(0, 200));
ok("the details block no longer claims to be snapshot-only", !/预生成快照，不是实时值/.test(dom.tech));

/* THE central assertion: a message that is on chain but NOT in the snapshot appears in the DOM.
 *
 * The ★ messages the user reported (blocks 26051766 / 26051777) are the natural target, but they age
 * out of a 300-block window within a couple of hours of being posted — so this cannot require them by
 * block number without becoming a test that only passes during the hour after someone posts, which is
 * the definition of an unusable regression test. Instead the assertion is driven by WHATEVER the same
 * window holds, read independently from the chain a moment earlier. That is a stronger test anyway:
 * it compares the page against the chain rather than against a hard-coded expectation. */
const snapshotBlocks = new Set(snapshot.messages.map((m) => m.block));
const newOnChain = scan.messages.filter((m) => !snapshotBlocks.has(m.block));
/** The two messages the user reported, if they happen to be in range. */
const REPORTED = [26051766, 26051777];

if (newOnChain.length) {
  console.log(`\n  the chain holds ${newOnChain.length} message(s) the snapshot does not:`);
  for (const m of newOnChain) {
    const key = m.text.slice(0, 50);
    const inDom = strip(dom.listHtml).includes(key) || dom.latestText.includes(key);
    console.log(`    block ${m.block}  in DOM: ${inDom}  "${key}…"`);
    ok(`the on-chain message at block ${m.block} is rendered on the page`, inDom, `looked for ${JSON.stringify(key)}`);
  }
  ok("the page's count exceeds the snapshot's own list", Number(dom.numberAll) > snapshot.messages.length, `page ${dom.numberAll} vs snapshot ${snapshot.messages.length}`);
  ok("the source note says the page includes the newest on-chain message", /已含链上最新/.test(dom.lede), dom.lede.slice(0, 240));
} else {
  /* Quiet window. The live path must still be visibly working, and the page must SAY it is current
   * rather than pretending or going silent. */
  console.log("\n  (the window held no message newer than the snapshot — verifying the quiet-path shape)");
  ok("the source note reports the chain was read and held nothing newer", /没有比快照更新/.test(dom.lede), dom.lede.slice(0, 240));
  /* The block number must be a real reading, never a placeholder. `Number(null).toLocaleString()` is
   * "0" — a confidently wrong value that this assertion caught in an earlier revision of the label. */
  const blockInNote = (dom.lede.match(/区块\s*([\d,]+)/) || [])[1];
  ok("the source note names the real block it read to", !!blockInNote && Number(blockInNote.replace(/,/g, "")) > 1000000, `block "${blockInNote}" in: ${dom.lede.slice(0, 200)}`);
  ok("the snapshot's full history is still rendered", Number(dom.numberAll) >= snapshot.messages.length, `${dom.numberAll} vs ${snapshot.messages.length}`);
}

/* The user's own two messages are the acceptance target. Report their fate explicitly rather than
 * silently, whichever branch was taken. */
console.log("\n  the two messages the user reported:");
for (const b of REPORTED) {
  const inWindow = scan.messages.some((m) => m.block === b);
  const inDom = strip(dom.listHtml).includes(b.toLocaleString()) || strip(dom.listHtml).includes(String(b));
  const inSnap = snapshotBlocks.has(b);
  console.log(`    block ${b}: in snapshot=${inSnap}  in the live window=${inWindow}  rendered=${inDom}`);
}
/* If they are in the window they MUST be on the page — that is the non-negotiable half. */
for (const b of REPORTED) {
  if (scan.messages.some((m) => m.block === b)) {
    const text = scan.messages.find((m) => m.block === b).text.slice(0, 50);
    ok(`the reported message at block ${b} is on the page while it is in the window`, strip(dom.listHtml).includes(text), text);
  }
}

/* The realtime claim must stay bounded: no sentence may promise seconds. */
ok("the page does not claim second-level realtime", !/实时(更新|同步)/.test(dom.lede.replace(/正在读取链上最新留言/, "")), dom.lede.slice(0, 240));

/* The 10 annotated "key" messages must survive the merge — this is the field a naive merge drops. */
const snapKey = snapshot.messages.filter((m) => m.important).length;
ok(`the ${snapKey} annotated key messages survive the merge`, Number(dom.numberKey) >= snapKey, `page shows ${dom.numberKey}`);

console.log(`\n=== console errors (${consoleErrors.length}) ===`);
for (const e of consoleErrors.slice(0, 5)) console.log(`  ${e}`);

if (!KEEP_OPEN) {
  ws.close();
  chrome.kill();
  server.kill();
  await sleep(400);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
} else {
  console.log(`\nleft running: ${URL_}  (chrome CDP on ${CDP_PORT})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
