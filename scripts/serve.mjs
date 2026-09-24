// Zero-dependency static file server for local preview.
//
//   node scripts/serve.mjs [port]
//
// Serves the project root, so /index.html, /assets/*, /lib/* and /data/* all resolve
// exactly as they do on a static host.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, join, normalize, sep } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = Number(process.argv[2] || 5173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p === "/") p = "/index.html";
    const abs = normalize(join(ROOT, p));
    if (!abs.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const body = await readFile(abs);
    res.writeHead(200, {
      "content-type": TYPES[extname(abs).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    res.end(body);
  } catch (e) {
    if (e.code === "ENOENT") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("404 " + req.url);
    } else {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end("500 " + e.message);
    }
  }
});

server.listen(PORT, () => {
  console.log(`pool4-dashboard → http://127.0.0.1:${PORT}/`);
  console.log(`root: ${ROOT}`);
});
