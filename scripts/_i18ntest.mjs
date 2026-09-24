import { readFileSync } from "node:fs";
const ROOT = "D:/imd/pool4-dashboard/";
globalThis.fetch = async (url) => {
  const u = String(url);
  const p = u.startsWith("/") ? u.slice(1) : u;
  try { return new Response(readFileSync(ROOT + p, "utf8"), { status: 200 }); }
  catch (e) { console.log("FETCH FAIL", u, e.message); return new Response("nf", { status: 404 }); }
};
Object.defineProperty(globalThis, "navigator", { value: { language: "zh-CN" }, configurable: true });
globalThis.location = { search: "", href: "http://localhost/" };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.document = { documentElement: { setAttribute: () => {} }, querySelector: () => null, title: "" };
const { initI18n, t, setLang, getLang } = await import("../lib/i18n.js");
console.log("initI18n...");
const lang = await initI18n();
console.log("lang =", lang, "| getLang() =", getLang());
console.log("t(meta.title) =", t("meta.title"));
console.log("t(hero.atLine) =", t("hero.atLine").slice(0, 50));
console.log("t(hero.stopped, {count:1}) =", t("hero.stopped", { count: 1 }));
await setLang("en");
console.log("after setLang(en): lang =", getLang());
console.log("  t(meta.title) =", t("meta.title"));
console.log("  t(hero.stopped, {count:1}) =", t("hero.stopped", { count: 1 }));
console.log("  t(hero.stopped, {count:10}) =", t("hero.stopped", { count: 10 }));
console.log("  t(subtitle.stopped, {count:1}) =", t("subtitle.stopped", { count: 1 }));
console.log("  missing key ->", t("does.not.exist"));
