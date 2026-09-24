/**
 * Minimal HTML scan, shared by scripts/check-html-i18n.mjs and the coverage test.
 *
 * Deliberately not a DOM. It only needs to answer two questions:
 *   1. which text nodes and attributes still contain Chinese, and
 *   2. for each of those, is something going to replace it at runtime
 *      (a data-i18n / data-i18n-html attribute, or an id that app.js writes into)?
 *
 * No dependencies, no parser to keep in sync — just enough structure to make the
 * "English mode must not leak Chinese" rule enforceable in CI.
 */

const CJK = /[\u4e00-\u9fff]/;

/** Tags that never have children, so they must not be pushed on the stack. */
const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const TOKEN = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

function parseAttrs(raw) {
  const attrs = {};
  const re = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(raw))) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

const countLines = (s) => (s.match(/\n/g) || []).length;

/**
 * @param {string} html
 * @returns {{
 *   texts: {text:string, line:number, covered:boolean, via:string, containerId:string|null, tag:string}[],
 *   attrs: {name:string, value:string, line:number, covered:boolean, via:string, tag:string, containerId:string|null}[],
 *   ids: Set<string>
 * }}
 */
export function scanHtml(html) {
  const texts = [];
  const attrs = [];
  const ids = new Set();
  const stack = [];
  let line = 1;
  let cursor = 0;

  const containerId = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const id = stack[i].attrs.id;
      if (id) return id;
    }
    return null;
  };
  /** Is any element on the stack (or the element itself) wired to be replaced? */
  const coverageOf = (extraAttrs) => {
    const all = [...stack.map((e) => e.attrs), extraAttrs || {}];
    for (const a of all) {
      if (a["data-i18n"]) return { covered: true, via: `data-i18n=${a["data-i18n"]}` };
      if (a["data-i18n-html"]) return { covered: true, via: `data-i18n-html=${a["data-i18n-html"]}` };
    }
    return { covered: false, via: "" };
  };

  const handleText = (text, textLine) => {
    if (!CJK.test(text)) return;
    const { covered, via } = coverageOf(null);
    texts.push({
      text: text.replace(/\s+/g, " ").trim(),
      line: textLine,
      covered,
      via,
      containerId: containerId(),
      tag: stack.length ? stack[stack.length - 1].tag : "(root)",
    });
  };

  let m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(html))) {
    const [whole, closing, tagName, attrRaw, selfClose] = m;
    const tokenLine = line;
    if (m.index > cursor) handleText(html.slice(cursor, m.index), line);
    line += countLines(whole);
    cursor = m.index + whole.length;

    if (whole.startsWith("<!--")) continue;
    const tag = String(tagName).toLowerCase();

    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    const a = parseAttrs(attrRaw || "");
    if (a.id) ids.add(a.id);

    // attributes on the element itself
    for (const name of ["aria-label", "title", "placeholder", "alt", "content"]) {
      const value = a[name];
      if (typeof value !== "string" || !CJK.test(value)) continue;
      const wired = a["data-i18n-attr"] === name || name === "content" ? coverageOf(a) : coverageOf(a);
      attrs.push({
        name,
        value: value.replace(/\s+/g, " ").trim(),
        line: tokenLine,
        covered: wired.covered,
        via: wired.via,
        tag,
        containerId: a.id || containerId(),
      });
    }

    if (!VOID.has(tag) && !selfClose) stack.push({ tag, attrs: a });
  }
  // trailing text
  if (cursor < html.length) handleText(html.slice(cursor), line);

  return { texts, attrs, ids };
}

/**
 * Ids that app.js fills in at runtime, in two flavours:
 *   replaced — element.innerHTML is overwritten, so its children are app-managed
 *   text     — only textContent is set; sibling markup stays static
 *
 * Aliases count: app.js writes most of its ledes as
 *   const lede = $("messages-lede"); … lede.innerHTML = …
 * so a search that only looks at `$("id").innerHTML` misses them and reports live
 * containers as untranslated Chinese.
 */
export function dynamicIds(appSource) {
  const replaced = new Set();
  const text = new Set();
  const aliases = new Map(); // local variable -> Set of element ids it may hold
  const alias = (name, id) => {
    if (!aliases.has(name)) aliases.set(name, new Set());
    aliases.get(name).add(id);
  };
  // `lede` is reused in three different render functions, so one name maps to several
  // ids; every one of them is a live container.
  for (const m of appSource.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\$\("([^"]+)"\)/g)) {
    alias(m[1], m[2]);
  }
  for (const m of appSource.matchAll(/setHtml\(\s*"([^"]+)"/g)) replaced.add(m[1]);
  for (const m of appSource.matchAll(/\$\("([^"]+)"\)\s*\.\s*innerHTML\s*=/g)) replaced.add(m[1]);
  for (const m of appSource.matchAll(/\$\("([^"]+)"\)\s*\.\s*textContent\s*=/g)) text.add(m[1]);
  for (const m of appSource.matchAll(/([A-Za-z_$][\w$]*)\s*\.\s*innerHTML\s*=/g)) {
    for (const id of aliases.get(m[1]) || []) replaced.add(id);
  }
  for (const m of appSource.matchAll(/([A-Za-z_$][\w$]*)\s*\.\s*textContent\s*=/g)) {
    for (const id of aliases.get(m[1]) || []) text.add(id);
  }
  return { replaced, text };
}

/** The language buttons name each language in its own language — on purpose. */
const EXEMPT_CONTAINERS = new Set(["langswitch", "lang-zh", "lang-en"]);

/**
 * Every Chinese string in the static page that would still be Chinese after the user
 * switches to English.
 *
 * An element is fine when either:
 *   * it (or an ancestor) carries data-i18n / data-i18n-html, or
 *   * app.js overwrites it at runtime, so its static text never reaches the screen.
 *
 * @returns {{kind:string, where:string, line:number, value:string}[]}
 */
export function findI18nLeaks(html, appSource) {
  const { texts, attrs } = scanHtml(html);
  const { replaced, text } = dynamicIds(appSource);

  const isDynamic = (containerId, tag) => {
    if (tag === "title") return true; // document.title is set by renderSummary
    if (!containerId) return false;
    return replaced.has(containerId) || text.has(containerId);
  };
  const skip = (containerId) => EXEMPT_CONTAINERS.has(containerId);

  const leaks = [];
  for (const t of texts) {
    if (t.covered || isDynamic(t.containerId, t.tag) || skip(t.containerId)) continue;
    leaks.push({
      kind: "text",
      where: `<${t.tag}${t.containerId ? ` id=${t.containerId}` : ""}>`,
      line: t.line,
      value: t.text,
    });
  }
  for (const a of attrs) {
    if (a.covered || isDynamic(a.containerId, a.tag) || skip(a.containerId)) continue;
    leaks.push({
      kind: `attr ${a.name}`,
      where: `<${a.tag}${a.containerId ? ` id=${a.containerId}` : ""}>`,
      line: a.line,
      value: a.value,
    });
  }
  return leaks;
}

export { CJK };
