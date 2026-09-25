/**
 * i18n runtime — flat keys, interpolation, plural rules, graceful fallback.
 *
 * Language resolution order: ?lang=  >  localStorage  >  navigator.language
 *   zh-* -> zh, everything else -> en.
 *
 * Design notes:
 *  - Flat keys (hero.title, state.critical.desc) so diffs are readable.
 *  - Missing key in the active locale falls back to zh, then to the key itself —
 *    and warns, because a key name leaking onto the page is a bug, not a fallback.
 *  - Plurals go through Intl.PluralRules, never a hand-rolled "s".
 */

export const LANGS = ["zh", "en"];
export const DEFAULT_LANG = "zh";

const state = {
  lang: DEFAULT_LANG,
  dict: {}, // active
  fallback: {}, // zh
  listeners: [],
};

/** Resolve the language to use, without touching the DOM. */
export function resolveLang(search, stored, navLang) {
  const q = new URLSearchParams(search || "").get("lang");
  if (q && LANGS.includes(q.toLowerCase())) return q.toLowerCase();
  if (stored && LANGS.includes(String(stored).toLowerCase())) return String(stored).toLowerCase();
  const nav = String(navLang || "").toLowerCase();
  return nav.startsWith("zh") ? "zh" : nav ? "en" : DEFAULT_LANG;
}

export function getLang() {
  return state.lang;
}

/** Does the active locale define this key? Lets callers fall back quietly. */
export function has(key) {
  return typeof state.dict[key] === "string";
}

/** Load one locale file. */
async function loadDict(lang) {
  const r = await fetch(`locales/${lang}.json`);
  if (!r.ok) throw new Error(`locales/${lang}.json -> HTTP ${r.status}`);
  return r.json();
}

/**
 * @param {{lang?: string, fetchImpl?: typeof fetch}} [opts]
 */
export async function initI18n(opts = {}) {
  const loc = typeof location !== "undefined" ? location : { search: "", pathname: "/" };
  const stored = typeof localStorage !== "undefined" ? localStorage.getItem("pool4.lang") : null;
  const nav = typeof navigator !== "undefined" ? navigator.language : "";
  state.lang = opts.lang && LANGS.includes(opts.lang) ? opts.lang : resolveLang(loc.search, stored, nav);

  const [active, fallback] = await Promise.all([loadDict(state.lang), loadDict(DEFAULT_LANG)]);
  state.dict = active;
  state.fallback = fallback;
  applyDocumentLang();
  return state.lang;
}

/**
 * Look up a key.
 * @param {string} key
 * @param {Record<string, any>} [params] interpolation values; `count` drives plurals
 */
export function t(key, params) {
  let s = state.dict[key];
  if (s === undefined) {
    s = state.fallback[key];
    if (s === undefined) {
      if (typeof console !== "undefined") console.warn(`[i18n] missing key: ${key}`);
      return key; // last resort — visible in dev, and the test suite flags it
    }
    if (typeof console !== "undefined") console.warn(`[i18n] "${key}" missing in ${state.lang}, fell back to ${DEFAULT_LANG}`);
  }
  s = selectPlural(s, params, state.lang);
  return interpolate(s, params, state.lang);
}

/**
 * Pick a plural form before interpolating. Locale files write:
 *   "key": "Stopped for {count} day|Stopped for {count} days"
 *
 * zh declares its convention in locales/zh.json's own `_note`: "含 | 的条目是复数形式（en 用，
 * zh 只用第一段）" — entries with | are plural forms, for English; Chinese uses only the FIRST
 * segment. This function did not honour that, and the failure was invisible in English and wrong
 * in Chinese:
 *
 *   Intl.PluralRules("zh").resolvedOptions().pluralCategories === ["other"]
 *
 * Chinese has one category, so `cat` is always "other", so a two-form entry always returned
 * forms[1] — the SECOND segment. title.stopped is written
 * "IMD 烧毁引擎状态 — 已停 {count} 天|IMD 烧毁引擎状态 — 已停", where segment 1 is the one with
 * the day count and segment 2 is the no-count fallback. A Chinese reader therefore saw
 * "已停" with no number, at every duration, while the English page said "stopped for 5 days".
 * The key's own comment says zh uses the first segment; it was getting the last.
 *
 * So zh (and any language whose cardinal categories are just ["other"]) takes the first segment.
 * That is what the convention says AND what reads correctly: the first form is the general one.
 */
function selectPlural(s, params, lang) {
  if (typeof s !== "string" || !s.includes("|") || !params || params.count === undefined) return s;
  const forms = s.split("|").map((x) => x.trim());
  if (forms.length === 1) return forms[0];

  let cat = "other";
  try {
    cat = new Intl.PluralRules(lang).select(Number(params.count));
  } catch {
    cat = Number(params.count) === 1 ? "one" : "other";
  }
  /* A language with a single category has no plural distinction to make, so the first form is
   * the answer — never the last. This is the fix; the rest of the function is unchanged. */
  let categories = ["other"];
  try {
    categories = new Intl.PluralRules(lang).resolvedOptions().pluralCategories || ["other"];
  } catch {
    categories = ["other"];
  }
  if (categories.length === 1) return forms[0];

  if (forms.length === 2) return cat === "one" ? forms[0] : forms[1];
  return forms.find((f) => f.startsWith(cat + ":")) || forms.find((f) => f.startsWith("other:")) || forms[forms.length - 1];
}

function interpolate(s, params, lang) {
  if (!params) return s;
  return String(s).replace(/\{(\w+)\}/g, (whole, name) => {
    const v = params[name];
    return v === undefined || v === null ? whole : String(v);
  });
}

/** Fill every [data-i18n] node, plus title/description/og:title. */
export function applyStatic(root) {
  const doc = root || (typeof document !== "undefined" ? document : null);
  if (!doc) return;
  for (const el of doc.querySelectorAll("[data-i18n]")) {
    const key = el.getAttribute("data-i18n");
    const attr = el.getAttribute("data-i18n-attr");
    const val = t(key);
    if (attr) el.setAttribute(attr, val);
    else el.textContent = val;
  }
  for (const el of doc.querySelectorAll("[data-i18n-html]")) {
    el.innerHTML = t(el.getAttribute("data-i18n-html"));
  }
}

/** <html lang>, meta description, og:title/og:description.
 *  NOTE: <title> is deliberately NOT set here — it carries the engine's current
 *  state (see renderSummary), and letting this function overwrite it would drop
 *  the conclusion from the tab and from shared links. */
export function applyDocumentLang() {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("lang", state.lang === "zh" ? "zh-CN" : "en");
  const setMeta = (selector, content) => {
    const el = document.querySelector(selector);
    if (el) el.setAttribute("content", content);
  };
  setMeta('meta[name="description"]', t("meta.description"));
  setMeta('meta[property="og:title"]', t("meta.ogTitle"));
  setMeta('meta[property="og:description"]', t("meta.description"));
  setMeta('meta[property="og:locale"]', state.lang === "zh" ? "zh_CN" : "en_US");
}

/** Switch language: reload dicts, sync URL, re-render everything. */
export async function setLang(lang, opts = {}) {
  if (!LANGS.includes(lang) || lang === state.lang) return state.lang;
  state.lang = lang;
  const [active, fallback] = await Promise.all([loadDict(lang), loadDict(DEFAULT_LANG)]);
  state.dict = active;
  state.fallback = fallback;
  if (typeof localStorage !== "undefined") localStorage.setItem("pool4.lang", lang);
  if (opts.syncUrl !== false && typeof history !== "undefined" && typeof location !== "undefined") {
    const u = new URL(location.href);
    u.searchParams.set("lang", lang);
    history.replaceState(null, "", u.toString());
  }
  applyDocumentLang();
  for (const fn of state.listeners) {
    try {
      fn(lang);
    } catch (e) {
      console.warn("[i18n] listener failed", e);
    }
  }
  return lang;
}

export function onLangChange(fn) {
  state.listeners.push(fn);
}

/* ------------------------------------------------------------------ *
 * locale-aware formatting
 * ------------------------------------------------------------------ */

const locale = () => (state.lang === "zh" ? "zh-CN" : "en-US");

/** Date + time, always labelled UTC. zh: 2026-09-23 13:45 · en: Sep 23, 2026 13:45 */
export function fmtDateTime(tsSec, withZone = true) {
  const d = new Date(tsSec * 1000);
  const opts = { year: "numeric", month: state.lang === "zh" ? "2-digit" : "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" };
  let s;
  try {
    s = new Intl.DateTimeFormat(locale(), opts).format(d);
  } catch {
    s = d.toISOString().slice(0, 16).replace("T", " ");
  }
  return withZone ? `${s} UTC` : s;
}

/**
 * Identifiers (block numbers, addresses, hashes, CIDs) are NOT quantities: they must
 * render byte-for-byte identically in both languages, with no thousands separators.
 */
export function fmtIdentifier(v) {
  return String(v);
}

/** Amounts follow locale conventions; the unit symbol never changes. */
export function fmtAmount(v, unit, dp = 2) {
  let s;
  try {
    s = new Intl.NumberFormat(locale(), { minimumFractionDigits: dp, maximumFractionDigits: dp }).format(v);
  } catch {
    s = Number(v).toFixed(dp);
  }
  return unit ? `${s} ${unit}` : s;
}
