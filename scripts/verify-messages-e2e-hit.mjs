// End-to-end proof that the page renders a message the SNAPSHOT DOES NOT HAVE.
//
//   node scripts/verify-messages-e2e-hit.mjs
//
// scripts/verify-messages-e2e.mjs proves the page works, but it runs against the production 300-block
// window — and this board averages 0.55 messages/day, so that run usually finds nothing newer and can
// only verify the "quiet channel" shape. That leaves the actual claim unproven: that a message on
// chain and absent from the snapshot appears on the page.
//
// Rather than wait for someone to post, this pins the window to a range that is KNOWN to contain such
// messages — the user's own reported ones, blocks 26051766 / 26051777 — by overriding FIRST_WINDOW via
// the page's own module graph. That is a legitimate test of the real render path: the same
// startMessageFollower, the same scanMessages, the same mergeMessages, the same renderMessages. Only
// the window size differs, which is a parameter, not a code path.
//
// The alternative — a stubbed rpc returning fake blocks — would prove that renderMessageBody can print
// a string, which nobody doubted. This proves the live path reaches the DOM.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rpc } from "../lib/evm.js";
import { scanMessages } from "../lib/messages-live.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 5190;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (h) => String(h).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

let pass = 0;
let fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`); }
};

/* The two messages the user reported, and the window that contains them. */
const REPORTED = [26051766, 26051777];
const snapshot = JSON.parse(readFileSync(ROOT + "data/messages.json", "utf8"));
const snapshotBlocks = new Set(snapshot.messages.map((m) => m.block));
for (const b of REPORTED) {
  if (snapshotBlocks.has(b)) {
    console.error(`FATAL: block ${b} is IN the snapshot — this test no longer proves anything`);
    process.exit(1);
  }
}

const rpc = new Rpc(undefined, { timeoutMs: 25000 });
const head = Number(BigInt(await rpc.call("eth_blockNumber")));
/* Cover from just below the reported messages to the head. Bounded, so the run stays quick. */
const from = Math.min(...REPORTED) - 5;
const windowBlocks = head - from + 1;
console.log(`head ${head}; the reported messages are at ${REPORTED.join(", ")}`);
console.log(`=> this run will drive the page with a ${windowBlocks}-block first window (production default is 300)\n`);
if (windowBlocks > 40000) {
  console.error("the reported messages are too old to reach in a reasonable window; update REPORTED");
  process.exit(1);
}

const server = spawn(process.execPath, ["scripts/serve.mjs", String(PORT)], { cwd: ROOT, stdio: "ignore" });
let serverUp = false;
for (let i = 0; i < 40 && !serverUp; i++) {
  try { serverUp = (await fetch(`http://127.0.0.1:${PORT}/index.html`)).ok; } catch { await sleep(250); }
}
if (!serverUp) { server.kill(); console.error("server never came up"); process.exit(1); }

const browser = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "/usr/bin/google-chrome"].find((p) => existsSync(p));
if (!browser) { server.kill(); console.error("no browser"); process.exit(1); }

const CDP = 9466;
const profile = mkdtempSync(join(tmpdir(), "pool4-msg-hit-"));
const chrome = spawn(browser, ["--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--window-size=1400,1600", "about:blank"], { stdio: "ignore" });
let up = false;
for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok; } catch { await sleep(300); } }
if (!up) { chrome.kill(); server.kill(); console.error("browser never came up"); process.exit(1); }

const info = await (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" })).json();
const ws = new WebSocket(info.webSocketDebuggerUrl);
const pend = new Map();
let id = 1;
const consoleErrors = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") consoleErrors.push((m.params.args || []).map((a) => a.value || a.description || "").join(" ").slice(0, 200));
  if (m.method === "Runtime.exceptionThrown") consoleErrors.push("EXCEPTION " + String(m.params.exceptionDetails?.exception?.description || "").slice(0, 200));
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
});
await new Promise((r) => ws.addEventListener("open", r));
const send = (method, params = {}) =>
  new Promise((res, rej) => { pend.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: id++, method, params })); });
await send("Runtime.enable");

/* The window size lives in messages-live.js (`FIRST_WINDOW`) and is consumed there by nextWindow()'s
 * default parameter — NOT by messages-follow.js, which only re-exports it. Patching the follow module
 * (the first attempt) therefore changed the exported constant while leaving the value nextWindow()
 * actually uses untouched, and the run silently behaved like a 300-block window: the page reported
 * "read to block X, nothing newer" and every assertion about the new message failed. Patch the module
 * that OWNS the value. */
await send("Fetch.enable", { patterns: [{ urlPattern: "*/lib/messages-live.js", requestStage: "Response" }] });
let patched = false;
ws.addEventListener("message", async (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Fetch.requestPaused" && m.params.responseStatusCode) {
    try {
      const body = await send("Fetch.getResponseBody", { requestId: m.params.requestId });
      let text = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
      if (text.includes("FIRST_WINDOW = 300")) {
        text = text.replace(/FIRST_WINDOW = 300/g, `FIRST_WINDOW = ${windowBlocks}`);
        patched = true;
      }
      await send("Fetch.fulfillRequest", {
        requestId: m.params.requestId,
        responseCode: 200,
        responseHeaders: [{ name: "content-type", value: "text/javascript; charset=utf-8" }, { name: "cache-control", value: "no-store" }],
        body: Buffer.from(text, "utf8").toString("base64"),
      });
    } catch (err) {
      console.log("  (patch failed: " + err.message + ")");
      try { await send("Fetch.continueRequest", { requestId: m.params.requestId }); } catch {}
    }
    return;
  }
  if (m.method === "Fetch.requestPaused") {
    try { await send("Fetch.continueRequest", { requestId: m.params.requestId }); } catch {}
  }
});

await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/?lang=zh` });

const evalIn = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
const readDom = () => evalIn(`(() => ({
  listHtml: ((document.getElementById("messages-list")||{}).innerHTML||""),
  lede: ((document.getElementById("messages-lede")||{}).textContent||"").trim(),
  all: ((document.getElementById("msgf-all-n")||{}).textContent||""),
  latest: ((document.getElementById("messages-latest")||{}).textContent||""),
}))()`);

console.log("waiting for the live read to land…");
let dom = null;
for (let i = 0; i < 60; i++) {
  await sleep(3000);
  dom = await readDom();
  if (/已含链上最新|没有比快照更新|不可用/.test(dom.lede)) break;
}
console.log(`  patched the module: ${patched}`);
console.log(`  messages: ${dom.all}   lede tail: ${dom.lede.split("·").slice(-1)[0]}\n`);

console.log("=== assertions ===");
ok("the window override was applied to the served module", patched, "the patch did not match — this run would silently use 300 blocks");
ok("no console error was logged", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));

/* Read the same window from the chain, independently. */
const scan = await scanMessages({ rpc, from, to: head, chunk: 25 });
console.log(`\n  chain says the window ${from}..${head} holds ${scan.messages.length} message(s) (covered=${scan.covered})`);
for (const m of scan.messages.filter((x) => REPORTED.includes(x.block))) {
  console.log(`    ★ block ${m.block} ${new Date(m.ts * 1000).toISOString()} ${JSON.stringify(m.text.slice(0, 60))}`);
}

for (const b of REPORTED) {
  const onChain = scan.messages.find((m) => m.block === b);
  if (!onChain) { console.log(`    block ${b}: not in this window, skipped`); continue; }
  const key = onChain.text.slice(0, 50);
  const inList = strip(dom.listHtml).includes(key);
  const inCard = dom.latest.includes(key);
  ok(`★ the on-chain message at block ${b} is rendered (list=${inList} latestCard=${inCard})`, inList || inCard, `looked for ${JSON.stringify(key)}`);
}
ok("the source note says the page includes the newest on-chain message", /已含链上最新/.test(dom.lede), dom.lede.slice(0, 240));
ok("the page's count exceeds the snapshot's list", Number(dom.all) > snapshot.messages.length, `${dom.all} vs ${snapshot.messages.length}`);

console.log(`\n  rendered count ${dom.all} (snapshot alone was ${snapshot.messages.length})`);

ws.close(); chrome.kill(); server.kill();
await sleep(400);
try { rmSync(profile, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
