/**
 * Literal scanning shared by scripts/extract-strings.mjs and the regression guard in
 * scripts/check.mjs.
 *
 * Implemented as a character walker, NOT a regex. A regex cannot handle nested
 * template literals (`a${`b`}c`) — it closes the match at the inner backtick and then
 * runs on into the surrounding code, swallowing hundreds of characters. That failure
 * mode hid three real Chinese strings inside PRESETS while the guard reported zero.
 *
 * Comments are skipped (they are documentation and stay Chinese).
 */

const CJK = /[\u4e00-\u9fff]/;

/**
 * Every string literal in the source, with its starting line and quote character.
 * @returns {{line:number, literal:string, quote:string}[]}
 */
export function scanLiterals(src) {
  const out = [];
  let i = 0;
  let line = 1;
  while (i < src.length) {
    const c = src[i];

    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    // line comment
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    // block comment
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }

    if (c === "`" || c === '"' || c === "'") {
      const startLine = line;
      const quote = c;
      let j = i + 1;
      let depth = 0;
      let text = "";
      while (j < src.length) {
        const d = src[j];
        if (d === "\\") {
          text += d + (src[j + 1] || "");
          if (src[j + 1] === "\n") line++;
          j += 2;
          continue;
        }
        // inside a template literal, ${ opens a nested expression
        if (quote === "`" && d === "$" && src[j + 1] === "{") {
          depth++;
          text += "${";
          j += 2;
          continue;
        }
        if (quote === "`" && depth > 0 && d === "}") {
          depth--;
          text += "}";
          j++;
          continue;
        }
        if (d === quote && depth === 0) break;
        if (d === "\n") line++;
        text += d;
        j++;
      }
      out.push({ line: startLine, literal: text, quote });
      i = j + 1;
      continue;
    }

    i++;
  }
  return out;
}

/** Literals containing Chinese, with the enclosing function. */
export function scanChineseLiterals(src) {
  return scanLiterals(src)
    .filter((r) => CJK.test(r.literal))
    .map((r) => ({ ...r, fn: enclosingFn(src, r.line) }));
}

/** The function a given line sits inside. */
export function enclosingFn(src, line) {
  const lines = src.split("\n").slice(0, Math.max(0, line - 1));
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/);
    if (m) return m[1];
  }
  return "(top level)";
}

/**
 * Turn a template literal into a message with {p0}, {p1} … placeholders.
 *
 * A regex cannot do this. `/\$\{([^}]*)\}/` stops at the first `}`, so
 *
 *   `地址：${list.map((a) => `<code>${esc(a)}</code>`).join(", ")}。`
 *
 * yielded the parameter `list.map((a) => `<code>${esc(a)` — a truncated expression
 * that, once substituted into tr("s.NNN", { p0: … }), is a syntax error in the page.
 * Two entries were damaged that way before this walker replaced the regex.
 *
 * The walker tracks brace depth, and treats a nested backtick string as opaque, so an
 * inner `${…}` cannot unbalance the scan.
 *
 * @returns {{zh: string, params: string[]}}
 */
export function templateToZh(literal) {
  const params = [];
  let out = "";
  let i = 0;
  while (i < literal.length) {
    if (literal[i] === "$" && literal[i + 1] === "{") {
      const start = i + 2;
      let j = start;
      let depth = 1;
      let quote = null;
      while (j < literal.length) {
        const d = literal[j];
        if (quote) {
          if (d === "\\") {
            j += 2;
            continue;
          }
          if (d === quote) quote = null;
          j++;
          continue;
        }
        if (d === '"' || d === "'" || d === "`") {
          quote = d;
          j++;
          continue;
        }
        if (d === "{") depth++;
        else if (d === "}") {
          depth--;
          if (depth === 0) break;
        }
        j++;
      }
      params.push(literal.slice(start, j).trim());
      out += "{p" + (params.length - 1) + "}";
      i = j + 1;
      continue;
    }
    out += literal[i];
    i++;
  }
  return { zh: out, params };
}

/** Are the parentheses/brackets/braces in an expression balanced? (Guards a rewrite.) */
export function isBalanced(expr) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    if (depth < 0) return false;
  }
  return depth === 0 && quote === null;
}

export { CJK };
