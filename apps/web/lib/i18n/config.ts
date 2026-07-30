// Locale registry. Adding a language means: add its tag here, add a label,
// drop a `messages/<tag>.json` next to en.json — nothing else. The parity test
// (messages.test.ts) then guards the new file against missing keys.

export const LOCALES = ['en', 'ru'] as const;

export type Locale = (typeof LOCALES)[number];

/**
 * Source language of the project: en.json is the reference dictionary, every
 * other locale falls back to it key by key.
 */
export const DEFAULT_LOCALE: Locale = 'en';

/** Names shown in the language picker — each in its own language, never translated. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  ru: 'Русский',
};

/**
 * Where the choice lives. A cookie rather than localStorage: the server needs
 * to know the locale while rendering (`<html lang>`, page titles, the first
 * paint of every client component), and only a cookie travels with the request.
 */
export const LOCALE_COOKIE = 'relay-lang';

/** One year — the picker is a preference, not a session. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * Best supported locale for a browser's `Accept-Language` (or `navigator.languages`).
 * Matches by primary subtag, so `ru-RU`, `ru-BY` and `ru` all land on `ru`;
 * anything unknown falls through to DEFAULT_LOCALE.
 */
export function matchLocale(accepted: readonly string[]): Locale {
  for (const tag of accepted) {
    const primary = tag.trim().toLowerCase().split('-')[0];
    const hit = LOCALES.find((l) => l === primary);
    if (hit) return hit;
  }
  return DEFAULT_LOCALE;
}

/**
 * Parses an `Accept-Language` header into tags ordered by quality:
 * `ru-RU,ru;q=0.9,en;q=0.8` → ['ru-RU', 'ru', 'en'].
 */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      const weight = q ? Number.parseFloat(q.trim().slice(2)) : 1;
      return { tag: tag.trim(), weight: Number.isFinite(weight) ? weight : 0 };
    })
    .filter((entry) => entry.tag && entry.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .map((entry) => entry.tag);
}
