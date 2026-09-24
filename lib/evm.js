/**
 * pool4-dashboard · minimal, dependency-free EVM toolkit.
 *
 * Works in both the browser (`<script type="module">`) and Node (`import`).
 * Contains: hex helpers, keccak-256, a small ABI codec, and a failover JSON-RPC client.
 *
 * Everything here is read-only. No signing, no transactions, no wallet.
 */

/* ------------------------------------------------------------------ *
 * hex helpers
 * ------------------------------------------------------------------ */

export function strip0x(h) {
  return h.startsWith("0x") || h.startsWith("0X") ? h.slice(2) : h;
}

export function bytesToHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex) {
  const h = strip0x(hex);
  const out = new Uint8Array(h.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

export function utf8ToBytes(str) {
  return new TextEncoder().encode(str);
}

export function bytesToUtf8(bytes) {
  return new TextDecoder().decode(bytes);
}

/* ------------------------------------------------------------------ *
 * keccak-256 (original Keccak padding 0x01, NOT NIST SHA3)
 * ------------------------------------------------------------------ */

const MASK64 = (1n << 64n) - 1n;

const KECCAK_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// RHO[x][y]
const KECCAK_RHO = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

function rotl64(v, n) {
  const s = BigInt(n) & 63n;
  if (s === 0n) return v & MASK64;
  return ((v << s) | (v >> (64n - s))) & MASK64;
}

function keccakF1600(s) {
  const B = new Array(25);
  const C = new Array(5);
  const D = new Array(5);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) {
      C[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      D[x] = C[(x + 4) % 5] ^ rotl64(C[(x + 1) % 5], 1);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) s[x + 5 * y] = (s[x + 5 * y] ^ D[x]) & MASK64;
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(s[x + 5 * y], KECCAK_RHO[x][y]);
      }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const i = x + 5 * y;
        s[i] = (B[i] ^ (~B[((x + 1) % 5) + 5 * y] & MASK64 & B[((x + 2) % 5) + 5 * y])) & MASK64;
      }
    }
    s[0] = (s[0] ^ KECCAK_RC[round]) & MASK64;
  }
}

/** @param {Uint8Array} input @returns {Uint8Array} 32 raw bytes */
export function keccak256(input) {
  const rate = 136; // 1088 bits
  const s = new Array(25).fill(0n);
  const padLen = rate - (input.length % rate);
  const padded = new Uint8Array(input.length + padLen);
  padded.set(input);
  padded[input.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;

  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      s[i] ^= lane;
    }
    keccakF1600(s);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = s[i];
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

export function keccak256Hex(input) {
  const bytes = typeof input === "string" ? utf8ToBytes(input) : input;
  return "0x" + bytesToHex(keccak256(bytes));
}

/* ------------------------------------------------------------------ *
 * ABI codec — the small static-type subset this dashboard needs
 * ------------------------------------------------------------------ */

function pad32(hexNo0x) {
  return hexNo0x.padStart(64, "0");
}

/** Encode a single 32-byte static word. */
function encodeStatic(type, value) {
  if (type === "bool") return pad32(value ? "1" : "0");
  if (type === "address") {
    if (typeof value !== "string") throw new Error("address must be a string");
    return pad32(strip0x(value).toLowerCase());
  }
  if (type === "bytes32") return pad32(strip0x(value).toLowerCase());
  if (/^uint(\d*)$/.test(type)) {
    let v = BigInt(value);
    if (v < 0n) throw new Error("negative value for " + type);
    return pad32(v.toString(16));
  }
  if (/^int(\d*)$/.test(type)) {
    let v = BigInt(value);
    if (v < 0n) v = (1n << 256n) + v; // two's complement over the full word
    return pad32(v.toString(16));
  }
  throw new Error("unsupported static type: " + type);
}

function isDynamic(type) {
  return type === "bytes" || type === "string" || type.endsWith("[]");
}

/**
 * Encode a function call.
 * @param {string} signature e.g. "balanceOf(address)"
 * @param {string[]} types
 * @param {any[]} values
 * @returns {string} 0x-prefixed calldata
 */
export function encodeCall(signature, types = [], values = []) {
  let head = "";
  const tailParts = [];
  let tailLen = 0;
  const headWords = [];

  // First pass: build heads, collect dynamic tails
  for (let i = 0; i < types.length; i++) {
    const t = types[i];
    if (isDynamic(t)) {
      headWords.push({ dynamic: true, index: tailParts.length });
      const enc = encodeDynamic(t, values[i]);
      tailParts.push(enc);
      tailLen += enc.length / 2;
    } else {
      headWords.push({ dynamic: false, word: encodeStatic(t, values[i]) });
    }
  }

  let headSize = headWords.length * 32;
  let running = headSize;
  for (const h of headWords) {
    if (h.dynamic) {
      head += pad32(running.toString(16));
      running += tailParts[h.index].length / 2;
    } else {
      head += h.word;
    }
  }
  const body = tailParts.join("");
  return "0x" + bytesToHex(keccak256(utf8ToBytes(signature))).slice(0, 8) + head + body;
}

function encodeDynamic(type, value) {
  if (type === "string" || type === "bytes") {
    const bytes = type === "string" ? utf8ToBytes(value) : hexToBytes(value);
    let out = pad32(bytes.length.toString(16));
    let data = bytesToHex(bytes);
    const rem = data.length % 64;
    if (rem !== 0) data += "0".repeat(64 - rem);
    return out + data;
  }
  throw new Error("unsupported dynamic type: " + type);
}

/** Compute a 4-byte selector. */
export function selector(signature) {
  return "0x" + bytesToHex(keccak256(utf8ToBytes(signature))).slice(0, 8);
}

function wordAt(hex, i) {
  return hex.slice(i * 64, (i + 1) * 64);
}

function decodeStatic(type, word) {
  if (!word || word.length < 64) throw new Error("short word for " + type);
  if (type === "bool") return BigInt("0x" + word) !== 0n;
  if (type === "address") return "0x" + word.slice(24).toLowerCase();
  if (type === "bytes32") return "0x" + word;
  if (/^uint(\d*)$/.test(type)) return BigInt("0x" + word);
  if (/^int(\d*)$/.test(type)) {
    const bits = type === "int" ? 256 : parseInt(type.slice(3), 10);
    let v = BigInt("0x" + word);
    if (v >= 1n << BigInt(bits - 1)) v -= 1n << 256n;
    return v;
  }
  throw new Error("unsupported static type: " + type);
}

/**
 * Decode ABI-encoded return data given a flat list of output types.
 * Supports static types plus `string`/`bytes` (single dynamic tail).
 */
export function decodeReturns(types, data) {
  const hex = strip0x(data);
  const out = [];
  for (let i = 0; i < types.length; i++) {
    const t = types[i];
    if (t === "string" || t === "bytes") {
      const off = Number(BigInt("0x" + wordAt(hex, i)));
      const len = Number(BigInt("0x" + hex.slice(off * 2, off * 2 + 64)));
      const raw = hex.slice(off * 2 + 64, off * 2 + 64 + len * 2);
      out.push(t === "string" ? bytesToUtf8(hexToBytes(raw)) : "0x" + raw);
    } else {
      out.push(decodeStatic(t, wordAt(hex, i)));
    }
  }
  return out;
}

/** Decode a tuple whose members are all static, laid out as consecutive words. */
export function decodeStaticTuple(types, data) {
  return decodeReturns(types, data);
}

/* ------------------------------------------------------------------ *
 * JSON-RPC with endpoint failover
 * ------------------------------------------------------------------ */

const BUILTIN_RPCS = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.drpc.org",
  "https://gateway.tenderly.co/public/mainnet",
  "https://eth-mainnet.public.blastapi.io",
  "https://rpc.mevblocker.io",
  "https://eth-pokt.nodies.app",
  "https://1rpc.io/eth",
  "https://rpc.flashbots.net",
];

/**
 * Endpoints can be overridden from the environment — `POOL4_RPC_URLS=a,b,c`.
 *
 * This exists for CI: GitHub's runners may be rate-limited or blocked by a public
 * endpoint that works fine from a laptop, and the fix should not be a code change. The
 * built-in list stays the default everywhere else. Guarded for the browser, where
 * `process` does not exist.
 */
const ENV_RPCS =
  typeof process !== "undefined" && process.env && process.env.POOL4_RPC_URLS
    ? String(process.env.POOL4_RPC_URLS)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

export const DEFAULT_RPCS = ENV_RPCS.length ? ENV_RPCS : BUILTIN_RPCS;

/**
 * Apply the same override to a script's own endpoint list.
 *
 * Several scripts prefer a specific subset (archive-capable nodes, nodes that allow wide
 * eth_getLogs windows). Those lists stay the default; the environment still wins, so CI
 * can point a refresh at endpoints that are reachable from a runner.
 */
export function rpcEndpoints(fallback) {
  return ENV_RPCS.length ? ENV_RPCS : fallback;
}

export class RpcError extends Error {}

export class Rpc {
  /**
   * @param {string[]} urls ordered preference; the first healthy one serves.
   * @param {{timeoutMs?: number, fetchImpl?: typeof fetch}} [opts]
   */
  constructor(urls = DEFAULT_RPCS, opts = {}) {
    this.urls = urls.length ? urls.slice() : DEFAULT_RPCS.slice();
    this.timeoutMs = opts.timeoutMs ?? 20000;
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.active = 0;
    this._id = 0;
    /** @type {{url:string, ok:boolean, ms:number, error?:string}[]} */
    this.health = this.urls.map((url) => ({ url, ok: true, ms: 0 }));
  }

  get endpoint() {
    return this.urls[this.active];
  }

  async _post(url, payload) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new RpcError(`HTTP ${res.status} from ${url}`);
      const json = await res.json();
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Single JSON-RPC call with failover across endpoints. */
  async call(method, params = []) {
    let lastErr;
    const start = this.active;
    for (let k = 0; k < this.urls.length; k++) {
      const idx = (start + k) % this.urls.length;
      const url = this.urls[idx];
      const t0 = Date.now();
      try {
        const json = await this._post(url, { jsonrpc: "2.0", id: ++this._id, method, params });
        if (json.error) {
          const err = new RpcError(json.error.message || JSON.stringify(json.error));
          // -32601 method-not-whitelisted / -32601 not found are endpoint policy,
          // not the call's fault: try the next endpoint. A revert (code 3) is the
          // call's own answer and will be identical everywhere, so stop retrying.
          err.code = json.error.code;
          err.definitive = json.error.code === 3 || /revert/i.test(err.message);
          if (err.definitive) throw err;
          lastErr = err;
          this.health[idx] = { url, ok: false, ms: Date.now() - t0, error: err.message };
          continue;
        }
        this.active = idx;
        this.health[idx] = { url, ok: true, ms: Date.now() - t0 };
        return json.result;
      } catch (err) {
        lastErr = err;
        this.health[idx] = { url, ok: false, ms: Date.now() - t0, error: String(err.message || err) };
        if (err && err.definitive) break;
      }
    }
    throw new RpcError(`all ${this.urls.length} endpoints failed for ${method}: ${lastErr && lastErr.message}`);
  }

  /**
   * Batch JSON-RPC calls.
   *
   * Per-item failures (a reverting view, a function that does not exist) are
   * returned as `{ok:false}` entries instead of throwing — the dashboard wants to
   * render "this one call failed", not lose the other 90 values.
   *
   * @param {{method:string, params:any[]}[]} requests
   * @returns {Promise<Array<{ok:true,result:any}|{ok:false,error:string}>>}
   */
  async batch(requests) {
    if (requests.length === 0) return [];
    const start = this.active;
    let lastErr;
    for (let k = 0; k < this.urls.length; k++) {
      const idx = (start + k) % this.urls.length;
      const url = this.urls[idx];
      const t0 = Date.now();
      try {
        const payload = requests.map((r, i) => ({
          jsonrpc: "2.0",
          id: i + 1,
          method: r.method,
          params: r.params,
        }));
        const json = await this._post(url, payload);
        if (!Array.isArray(json)) throw new RpcError("endpoint did not return a batch array");
        const byId = new Map(json.map((r) => [r.id, r]));
        const out = requests.map((_, i) => {
          const r = byId.get(i + 1);
          if (!r) return { ok: false, error: `batch response missing id ${i + 1}` };
          if (r.error) return { ok: false, error: r.error.message || JSON.stringify(r.error) };
          return { ok: true, result: r.result };
        });
        this.active = idx;
        this.health[idx] = { url, ok: true, ms: Date.now() - t0 };
        return out;
      } catch (err) {
        lastErr = err;
        this.health[idx] = { url, ok: false, ms: Date.now() - t0, error: String(err.message || err) };
      }
    }
    // Fallback: sequential singles across the whole pool, still per-item tolerant.
    const out = [];
    for (const r of requests) {
      try {
        out.push({ ok: true, result: await this.call(r.method, r.params) });
      } catch (e) {
        out.push({ ok: false, error: String(e.message || e) });
      }
    }
    if (out.every((o) => !o.ok)) {
      throw new RpcError(`all ${this.urls.length} endpoints failed for batch: ${lastErr && lastErr.message}`);
    }
    return out;
  }

  async blockNumber() {
    return Number(BigInt(await this.call("eth_blockNumber", [])));
  }

  /**
   * The highest head any endpoint reports, and which endpoint reported it.
   *
   * `blockNumber()` returns the first endpoint that answers, which is right for a dashboard
   * and wrong for an indexer: a node that is thousands of blocks behind answers happily, and
   * the index would then "scan" a range that ends behind where it already got to. Asking
   * everyone and taking the maximum removes the guess — a few extra requests, once per run.
   *
   * @returns {Promise<{url:string, n:number, spread:number, endpoints:number}>}
   */
  async highestBlockNumber() {
    const results = await Promise.all(
      this.urls.map(async (url, idx) => {
        const t0 = Date.now();
        try {
          const json = await this._post(url, { jsonrpc: "2.0", id: ++this._id, method: "eth_blockNumber", params: [] });
          if (json.error) throw new RpcError(json.error.message || JSON.stringify(json.error));
          const n = Number(BigInt(json.result));
          this.health[idx] = { url, ok: true, ms: Date.now() - t0 };
          return { url, n };
        } catch (err) {
          this.health[idx] = { url, ok: false, ms: Date.now() - t0, error: String(err.message || err) };
          return null;
        }
      })
    );
    const ok = results.filter(Boolean).sort((a, b) => b.n - a.n);
    if (!ok.length) throw new RpcError(`no endpoint reported a block number (${this.urls.length} tried)`);
    return { ...ok[0], spread: ok[0].n - ok[ok.length - 1].n, endpoints: ok.length };
  }

  async chainId() {
    return Number(BigInt(await this.call("eth_chainId", [])));
  }

  async getBlock(n) {
    const tag = typeof n === "number" ? "0x" + n.toString(16) : n;
    return this.call("eth_getBlockByNumber", [tag, false]);
  }

  /** @param {string} to @param {string} data @returns {Promise<string>} raw hex result */
  async ethCall(to, data, block = "latest") {
    return this.call("eth_call", [{ to, data }, block]);
  }
}

/* ------------------------------------------------------------------ *
 * ABI-typed contract facade
 * ------------------------------------------------------------------ */

/** Normalize a human ABI entry into {sig, types, outs}. */
export function fn(name, inputs = [], outputs = []) {
  return { name, sig: `${name}(${inputs.join(",")})`, types: inputs, outs: outputs };
}

export class Contract {
  /**
   * @param {Rpc} rpc
   * @param {string} address
   * @param {Record<string, {sig:string, types:string[], outs:string[]}>} abi
   */
  constructor(rpc, address, abi) {
    this.rpc = rpc;
    this.address = address;
    this.abi = abi;
    for (const key of Object.keys(abi)) {
      const entry = abi[key];
      this[key] = async (...args) => {
        const data = encodeCall(entry.sig, entry.types, args);
        const raw = await rpc.ethCall(this.address, data);
        const decoded = decodeReturns(entry.outs, raw);
        return decoded.length === 1 ? decoded[0] : decoded;
      };
      this[key].entry = entry;
    }
  }

  /** Build a {method, params} request for use in a batch. */
  request(key, ...args) {
    const entry = this.abi[key];
    return {
      method: "eth_call",
      params: [{ to: this.address, data: encodeCall(entry.sig, entry.types, args) }, "latest"],
      __key: `${this.address}:${key}`,
      __outs: entry.outs,
    };
  }
}

/* ------------------------------------------------------------------ *
 * fixed-point helpers
 * ------------------------------------------------------------------ */

export const Q96 = 1n << 96n;
export const Q192 = 1n << 192n;

/** Convert a bigint to a JS number, keeping `dp` decimal places of precision. */
export function toNum(v, dp = 6) {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const scale = 10n ** BigInt(dp);
  const scaled = abs / (10n ** 18n / scale); // v is assumed 18-decimals
  const n = Number(scaled) / Number(scale);
  return neg ? -n : n;
}

/** Format an 18-decimal bigint as a fixed-precision string. */
export function fmt18(v, dp = 6, group = true) {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** 18n;
  const whole = abs / base;
  const frac = abs % base;
  let fs = frac.toString().padStart(18, "0").slice(0, dp);
  if (dp === 0) fs = "";
  let ws = whole.toString();
  if (group) ws = ws.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + ws + (fs ? "." + fs : "");
}

/** Format with an arbitrary number of decimals. */
export function fmtUnits(v, decimals, dp = 6, group = true) {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  let fs = frac.toString().padStart(decimals, "0").slice(0, dp);
  if (dp === 0) fs = "";
  let ws = whole.toString();
  if (group) ws = ws.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + ws + (fs ? "." + fs : "");
}

/** Multiply two 18-decimal bigints, keeping 18 decimals. */
export function mul18(a, b) {
  return (a * b) / 10n ** 18n;
}

/** Divide two 18-decimal bigints, keeping 18 decimals. */
export function div18(a, b) {
  if (b === 0n) return 0n;
  return (a * 10n ** 18n) / b;
}

export function minBig(a, b) {
  return a < b ? a : b;
}

export function maxBig(a, b) {
  return a > b ? a : b;
}
