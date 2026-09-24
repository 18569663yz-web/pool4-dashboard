// Verify a deployed instance against the chain, item by item.
//
// The page is a client-side renderer: what it shows cannot be checked by fetching the HTML
// (which contains no numbers) and should not be taken on trust from a screenshot. So this
// opens the real page in a real browser, reads the numbers out of the DOM, reads the same
// numbers straight from Ethereum, and compares them.
//
//   node scripts/verify-live-site.mjs                        # https://imd.kymmppee.xyz
//   node scripts/verify-live-site.mjs --url http://127.0.0.1:5173
//
// Tolerances are explicit: the page refreshes every 60s, so a block number a few hundred
// blocks behind is expected, and pool balances move between the two readings.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rpc } from "../lib/evm.js";
import { collect } from "../lib/contracts.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const URL_ = argOf("--url", "https://imd.kymmppee.xyz") + (argOf("--url", "").includes("?") ? "" : "/?lang=zh");
const WAIT_MS = Number(argOf("--wait", "18000"));

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
const num = (s) => Number(String(s).replace(/[^0-9.\-−]/g, "").replace("−", "-"));
const e18 = (v) => Number(v) / 1e18;

/* ---------- 1. what the deployed page shows ---------- */
const browser = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
].find((p) => existsSync(p));
if (!browser) {
  console.error("no Chrome/Edge found");
  process.exit(1);
}

const PORT = 9455;
const profile = mkdtempSync(join(tmpdir(), "pool4-verify-"));
const chrome = spawn(browser, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--window-size=1400,1200", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const deadline = Date.now() + 20000;
let up = false;
while (Date.now() < deadline && !up) {
  try {
    up = (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok;
  } catch {
    await sleep(300);
  }
}
if (!up) {
  chrome.kill();
  console.error("browser never came up");
  process.exit(1);
}

const info = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_)}`, { method: "PUT" })).json();
const ws = new WebSocket(info.webSocketDebuggerUrl);
const pending = new Map();
let id = 1;
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
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
await send("Page.enable");
await send("Runtime.enable");
await sleep(WAIT_MS);

const domText = async (elId) => {
  const r = await send("Runtime.evaluate", { expression: `(document.getElementById(${JSON.stringify(elId)})||{}).textContent || ""`, returnByValue: true });
  return String(r.result?.value || "");
};
/** First stat tile's value inside a container — the card's own text also holds an address. */
const firstStatValue = async (containerId) => {
  const r = await send("Runtime.evaluate", {
    expression: `(document.querySelector(${JSON.stringify("#" + containerId + " .stat .v")})||{}).textContent || ""`,
    returnByValue: true,
  });
  return String(r.result?.value || "");
};

const shown = {
  block: await domText("st-block"),
  rpc: await domText("st-rpc"),
  updated: await domText("st-updated"),
  headline: await domText("sum-headline"),
  state: await domText("v-state"),
  held: await domText("v-held"),
  pending: await domText("v-pending"),
  awaiting: await domText("awaiting-stats"),
  awaitingFirst: await firstStatValue("awaiting-stats"),
  footer: await domText("footer-src"),
};

/* Interaction checks: the numbers being right does not mean the page works. These exercise
 * the parts a screenshot cannot show — the collapsible groups and the nav links into them,
 * which is the code that broke the headless suites (window.addEventListener) while being
 * perfectly fine in a browser. If it were broken here too, that would be a site bug. */
const interaction = {
  groups: await send("Runtime.evaluate", { expression: `document.querySelectorAll("details.group").length`, returnByValue: true }).then((r) => r.result?.value),
  navOpens: await send("Runtime.evaluate", {
    expression: `(() => {
      const a = document.querySelector(".anchors a");
      if (!a) return "no nav link found";
      const target = document.querySelector(a.getAttribute("href"));
      if (!target) return "nav target missing";
      const group = target.closest("details.group");
      if (!group) return "nav target is not inside a group";
      group.open = false;
      a.click();
      return group.open ? "ok" : "click did not open the group";
    })()`,
    returnByValue: true,
  }).then((r) => r.result?.value),
  hashOpens: await send("Runtime.evaluate", {
    expression: `(async () => {
      const groups = [...document.querySelectorAll("details.group")];
      if (groups.length < 2) return "fewer than two groups";
      groups.forEach((g) => (g.open = false));
      const inner = groups[1].querySelector("[id]");
      if (!inner) return "second group has no anchor target";
      location.hash = "#" + inner.id;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      await new Promise((r) => setTimeout(r, 150));
      return groups[1].open ? "ok" : "hashchange did not open the group";
    })()`,
    returnByValue: true,
    awaitPromise: true,
  }).then((r) => r.result?.value),
  consoleErrors: await send("Runtime.evaluate", { expression: `window.__err || "none"`, returnByValue: true }).then((r) => r.result?.value),
};
ws.close();
chrome.kill();
await sleep(400);
try {
  rmSync(profile, { recursive: true, force: true });
} catch {}

console.log(`deployed page: ${URL_}`);
console.log(`  block ${shown.block}   rpc "${shown.rpc}"   updated ${shown.updated}`);
console.log(`  state "${shown.state}"   headline "${shown.headline.slice(0, 60)}"`);

/* ---------- 2. the same values, straight from the chain ---------- */
const rpc = new Rpc(undefined, { timeoutMs: 25000 });
const snap = await collect(rpc, { includeBase: false });
const d = snap.derived;
console.log(`\nchain: block ${snap.blockNumber}   state ${d.state}   held ${e18(d.held).toFixed(4)}   pendingTrim ${e18(d.pendingTrim).toFixed(4)}`);
console.log(`  bridge queue ${e18(d.pendingBridge).toFixed(4)}   drippable ${e18(d.drippable).toFixed(4)}`);

/* ---------- 3. compare ---------- */
console.log("\nthe page against the chain");
{
  const pageBlock = num(shown.block);
  const lag = snap.blockNumber - pageBlock;
  ok(`block number is real and recent (page ${pageBlock}, chain ${snap.blockNumber}, ${lag} blocks behind)`, Number.isFinite(pageBlock) && lag >= 0 && lag < 600, `lag ${lag}`);
}
{
  // Pool balances move every swap, so compare within a tolerance rather than exactly.
  const pageHeld = num(shown.held);
  const chainHeld = e18(d.held);
  const rel = Math.abs(pageHeld - chainHeld) / chainHeld;
  ok(`held IMD agrees within 2% (page ${pageHeld}, chain ${chainHeld.toFixed(4)})`, rel < 0.02, `${(rel * 100).toFixed(2)}% apart`);
}
{
  const pagePending = num(shown.pending);
  const chainPending = e18(d.pendingTrim);
  // Both render as "0.0000" when the value is a few wei — that is agreement, not a 100% gap.
  const bothTiny = pagePending < 0.001 && chainPending < 0.001;
  const rel = bothTiny ? 0 : chainPending > 0 ? Math.abs(pagePending - chainPending) / chainPending : Math.abs(pagePending);
  ok(`pending trim agrees (page ${pagePending}, chain ${chainPending.toFixed(4)})`, rel < 0.05, `${(rel * 100).toFixed(2)}% apart`);
}
{
  // The second door's queue: read the stat tile, not the card text (which contains an address
  // whose trailing digits look like an amount — that fooled an earlier version of this check).
  const chainBridge = e18(d.pendingBridge);
  const pageBridge = num(shown.awaitingFirst);
  /* An empty queue is the common case — BurnExecutor holds nothing most of the time — and it
   * used to fail this check: dividing by `chainBridge` 0 gave NaN, and NaN < 0.05 is false.
   * Both sides reading ~0 is agreement, exactly like the pending-trim check above. The bug was
   * only ever latent because the queue happened to be non-zero when this ran. */
  const bothEmpty = pageBridge < 0.01 && chainBridge < 0.01;
  const rel = bothEmpty ? 0 : chainBridge > 0 ? Math.abs(pageBridge - chainBridge) / chainBridge : Math.abs(pageBridge);
  ok(
    `bridge queue agrees within 5% (page ${pageBridge}, chain ${chainBridge.toFixed(4)})`,
    Number.isFinite(pageBridge) && rel < 0.05,
    `${(rel * 100).toFixed(2)}% apart (raw "${shown.awaitingFirst}")`
  );
}
{
  // State names come from the locale, so compare against the three known readings.
  const known = { LIVE: /工作|working/i, CRITICAL: /临界|critical|触发线|line/i, DORMANT: /已停|stopped|dormant/i };
  const pageLooks = Object.entries(known).find(([, re]) => re.test(shown.state));
  ok(`state label is one of the three (page "${shown.state}" → ${pageLooks ? pageLooks[0] : "?"}, chain ${d.state})`, !!pageLooks, `chain says ${d.state}`);
}
{
  ok("the page reports a healthy RPC connection", /正常|ok|healthy/i.test(shown.rpc), shown.rpc);
  ok("the footer names an endpoint and a block", /https?:\/\/|区块|block/i.test(shown.footer), shown.footer.slice(0, 100));
  ok("no zero placeholders where a real value is expected", num(shown.held) > 0, shown.held);
}

console.log("\ninteraction (what a screenshot cannot show)");
{
  ok(`the page renders its collapsible groups (${interaction.groups} found)`, Number(interaction.groups) > 1, String(interaction.groups));
  ok("a nav link opens the group it points into", interaction.navOpens === "ok", String(interaction.navOpens));
  ok("a hash change opens the matching group", interaction.hashOpens === "ok", String(interaction.hashOpens));
}

console.log(`\n${pass} passed, ${fail} failed`);
await new Promise((resolve) => process.stdout.write("", resolve));
process.exit(fail === 0 ? 0 : 1);
