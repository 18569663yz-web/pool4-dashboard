// Full-page screenshots of the running dashboard, in both languages.
//
// The deliverable for a bilingual page is not the first screen — it is the whole
// scroll — so this drives the local Chrome/Edge over the DevTools protocol and captures
// beyond the viewport, in slices if the page is taller than the texture limit.
//
//   node scripts/serve.mjs 5173 &
//   node scripts/shoot.mjs --out shots --url http://127.0.0.1:5173
//
// Zero dependencies: Node's global WebSocket plus the browser you already have.
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const BASE = argOf("--url", "http://127.0.0.1:5173");
const OUTDIR = argOf("--out", "shots");
const WIDTH = Number(argOf("--width", "1440"));
const WAIT_MS = Number(argOf("--wait", "14000"));
const PORT = Number(argOf("--port", "9222"));
const LANGS = argOf("--langs", "zh,en").split(",");

const CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];
const browser = CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.error("no Chrome/Edge found");
  process.exit(1);
}

mkdirSync(ROOT + OUTDIR, { recursive: true });
const profile = join(tmpdir(), "pool4-shoot-" + Date.now());

/** Poll the DevTools endpoint until the browser is listening. */
async function waitForDebugger(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("devtools endpoint never came up");
}

/** A tiny CDP client: send a command, await its id. */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let next = 1;
  const events = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      events.push(msg.method);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", (e) => reject(new Error("ws error: " + (e.message || "unknown"))));
  });
  return {
    ready,
    events,
    send(method, params = {}) {
      const id = next++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  browser,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--window-size=${WIDTH},1000`,
    "about:blank",
  ],
  { stdio: "ignore" }
);

try {
  await waitForDebugger();
  console.log(`browser ready: ${browser}`);

  for (const lang of LANGS) {
    const target = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`${BASE}/?lang=${lang}`)}`, { method: "PUT" });
    const info = await target.json();
    const cdp = connect(info.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await sleep(WAIT_MS);

    const metrics = await cdp.send("Runtime.evaluate", {
      expression: `JSON.stringify({ h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth, title: document.title, state: (document.getElementById('v-state')||{}).textContent || '' })`,
      returnByValue: true,
    });
    const { h, w, title, state } = JSON.parse(metrics.result.value);
    console.log(`${lang}: ${w}x${h}  title="${title}"  state="${state}"`);

    // The compositor refuses very tall captures, so take it in viewport-sized slices.
    const SLICE = Number(argOf("--slice", "8000"));
    const slices = Math.max(1, Math.ceil(h / SLICE));
    const files = [];
    for (let i = 0; i < slices; i++) {
      const y = i * SLICE;
      const height = Math.min(SLICE, h - y);
      const shot = await cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: 0, y, width: w, height, scale: 1 },
      });
      const file = `${OUTDIR}/pool4-${lang}${slices > 1 ? `-${i + 1}` : ""}.png`;
      writeFileSync(ROOT + file, Buffer.from(shot.data, "base64"));
      files.push(file);
      console.log(`  wrote ${file} (${height}px tall)`);
    }

    // …and one single long image, scaled down just enough to fit one capture.
    const TEXTURE_LIMIT = 16000;
    if (h > TEXTURE_LIMIT) {
      const scale = TEXTURE_LIMIT / h;
      const shot = await cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: w, height: h, scale },
      });
      const file = `${OUTDIR}/pool4-${lang}-full.png`;
      writeFileSync(ROOT + file, Buffer.from(shot.data, "base64"));
      files.push(file);
      console.log(`  wrote ${file} (whole page, ${Math.round(w * scale)}x${Math.round(h * scale)}, scale ${scale.toFixed(2)})`);
    }
    cdp.close();
    await fetch(`http://127.0.0.1:${PORT}/json/close/${info.id}`);
    console.log(`  files: ${files.join(", ")}`);
  }
} finally {
  try {
    spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* ignore */
  }
  chrome.kill();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* the browser may still hold a lock; harmless */
  }
}
