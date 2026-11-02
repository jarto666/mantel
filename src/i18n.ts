import { de } from "./locales/de";
import { es } from "./locales/es";
import { fr } from "./locales/fr";
import { ru } from "./locales/ru";

/** Forms of a counted phrase, by `Intl.PluralRules` category; `other` is the fallback. */
export type Plural = { one?: string; few?: string; many?: string; other: string };
export type Catalog = Record<string, string | Plural>;

/**
 * Interface languages. The code is written in English and English strings are the lookup
 * keys, so a missing translation shows the English text rather than a key.
 */
const CATALOGS: Record<string, Catalog> = { en: {}, de, es, fr, ru };
const LOCALES: Record<string, string> = { en: "en-US", fr: "fr-FR", de: "de-DE", es: "es-ES", ru: "ru-RU" };
const STEAM: Record<string, string> = { fr: "french", de: "german", es: "spanish", ru: "russian" };

/** Settings value "" follows Windows. Labels are in their own language, as consoles do. */
export const LANGUAGES: { id: string; label: string }[] = [
  { id: "", label: "System" },
  { id: "de", label: "Deutsch" },
  { id: "en", label: "English" },
  { id: "es", label: "Español" },
  { id: "fr", label: "Français" },
  { id: "ru", label: "Русский" },
];

let lang = "en";
let catalog: Catalog = {};
let plurals = new Intl.PluralRules("en-US");

function systemLanguage(): string {
  const l = navigator.language.slice(0, 2).toLowerCase();
  return l in CATALOGS ? l : "en";
}

/** Switches the interface to a language id, or "" for Windows' own. Returns the one in use. */
export function setLanguage(id: string): string {
  lang = id in CATALOGS && id ? id : systemLanguage();
  catalog = CATALOGS[lang];
  plurals = new Intl.PluralRules(locale());
  document.documentElement.lang = lang;
  return lang;
}

export const language = () => lang;

/** BCP 47 tag for dates and numbers. */
export const locale = () => LOCALES[lang] ?? "en-US";

/** The language Steam's store pages answer in. */
export const steamLanguage = () => STEAM[lang] ?? "english";

/** A backend error: the ones with a fixed text have translations, the rest stay as they are. */
export const errorText = (e: unknown) => t(String(e));

/**
 * The interface string in the current language. `{name}` placeholders take `vars`:
 * `t("Added {name}", { name })`. Counts pick their own key: `n === 1 ? t("1 game") : t("{n} games", { n })`,
 * and a language with more forms (Russian) gives that key a `Plural`, chosen by `vars.n` or
 * else the first number among the vars.
 */
export function t(text: string, vars?: Record<string, string | number>): string {
  const entry = catalog[text] ?? text;
  let s: string;
  if (typeof entry === "string") s = entry;
  else {
    const count = vars?.n ?? Object.values(vars ?? {}).find((v) => typeof v === "number");
    s = (typeof count === "number" && entry[plurals.select(count) as keyof Plural]) || entry.other;
  }
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}
