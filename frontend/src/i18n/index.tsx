import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { dictionaries, locales, type Dict, type Locale } from "./translations";

export type { Locale } from "./translations";
export { locales, localeLabels } from "./translations";

const STORAGE_KEY = "console-selinux-locale";

function lookup(dict: Dict, path: string): string | undefined {
  let cur: Dict | string | undefined = dict;
  for (const part of path.split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = cur[part];
  }
  return typeof cur === "string" ? cur : undefined;
}

// A template containing "singular | plural" is resolved to whichever half
// matches `vars.count` (English/Spanish/French all need this: unlike the
// French "(s)" shortcut used for a few short standalone counts, some
// strings genuinely read differently in the singular, e.g. "1 agent" vs
// "3 agents" once wrapped in a longer sentence).
function resolvePlural(template: string, count: number): string {
  if (!template.includes("|")) return template;
  const [singular, plural] = template.split("|").map((s) => s.trim());
  return count === 1 ? singular : plural;
}

function detectDefaultLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && (locales as string[]).includes(stored)) return stored as Locale;
  } catch {
    // localStorage can throw (private browsing, blocked site data, ...);
    // fall through to browser-language detection below.
  }
  const nav = typeof navigator !== "undefined" ? navigator.language.slice(0, 2).toLowerCase() : "";
  return (locales as string[]).includes(nav) ? (nav as Locale) : "fr";
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => detectDefaultLocale());

  const setLocale = (l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // Per-viewer convenience only — fine if it doesn't persist.
    }
  };

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const t = useMemo(() => {
    return (key: string, vars?: Record<string, string | number>): string => {
      let template = lookup(dictionaries[locale], key) ?? lookup(dictionaries.en, key) ?? key;
      if (vars && "count" in vars) {
        template = resolvePlural(template, Number(vars.count));
      }
      if (!vars) return template;
      // split/join instead of replaceAll: keeps the current tsconfig lib
      // target (no ES2021) happy without bumping it project-wide.
      return Object.entries(vars).reduce(
        (acc, [k, v]) => acc.split(`{${k}}`).join(String(v)),
        template,
      );
    };
  }, [locale]);

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useTranslation(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useTranslation must be used within an I18nProvider");
  return ctx;
}
