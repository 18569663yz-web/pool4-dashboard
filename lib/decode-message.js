/**
 * Decoding for the on-chain message board.
 *
 * Kept in its own side-effect-free module: fetch-messages.mjs is a script whose
 * top level starts fetching, so importing it just to reuse this function would kick
 * off a network crawl.
 */
import { hexToBytes, bytesToUtf8 } from "./evm.js";

/**
 * calldata -> utf8, or null when it is not clean printable text.
 *
 * The message board is a plain EOA, so a "message" is just the `input` of a
 * zero-value self-send. Anything that fails these checks is a real contract call or
 * binary payload, not a message.
 */
export function decodeMessage(rawInput) {
  if (!rawInput || rawInput === "0x") return null;
  const hex = rawInput.slice(2);
  if (hex.length % 2 !== 0) return null;
  let bytes;
  try {
    bytes = hexToBytes(hex);
  } catch {
    return null;
  }
  if (bytes.length < 4) return null;
  let text;
  try {
    text = bytesToUtf8(bytes);
  } catch {
    return null;
  }
  // must be printable text, not a contract call
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return null;
  const printable = [...text].filter((c) => c.charCodeAt(0) >= 32 || c === "\n" || c === "\t").length;
  if (printable / text.length < 0.97) return null;
  // a selector-shaped call (4 bytes then binary) usually fails the above already
  if (/^[0-9a-f]{8}$/i.test(hex.slice(0, 8)) && !/\s/.test(text.slice(0, 12)) && text.length < 12) return null;
  return text;
}

/** Why decodeMessage rejected a payload — for diagnostics, not for the page. */
export function explainUndecodable(rawInput) {
  if (!rawInput || rawInput === "0x") return "empty calldata (plain value transfer, no message)";
  const hex = rawInput.slice(2);
  if (hex.length % 2 !== 0) return "odd-length hex";
  let bytes;
  try {
    bytes = hexToBytes(hex);
  } catch {
    return "not valid hex";
  }
  if (bytes.length < 4) return `only ${bytes.length} byte(s) of calldata`;
  let text;
  try {
    text = bytesToUtf8(bytes);
  } catch {
    return "not valid UTF-8";
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return "contains control characters (looks like a contract call)";
  const printable = [...text].filter((c) => c.charCodeAt(0) >= 32 || c === "\n" || c === "\t").length;
  const ratio = printable / text.length;
  if (ratio < 0.97) return `only ${(ratio * 100).toFixed(1)}% printable bytes (binary payload)`;
  if (/^[0-9a-f]{8}$/i.test(hex.slice(0, 8)) && !/\s/.test(text.slice(0, 12)) && text.length < 12) return "4-byte selector followed by short binary";
  return "unknown";
}
