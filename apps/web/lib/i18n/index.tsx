'use client';

import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from 'react';
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  isLocale,
  matchLocale,
  type Locale,
} from './config';
import { translate, type MessageKey, type Vars } from './translate';

export type { Locale } from './config';
export type { MessageKey } from './translate';
export { LOCALES, LOCALE_LABELS } from './config';

/** `t('chat.send')`, `t('chat.unread', { count: 3 })`. */
export type Translate = (key: MessageKey, vars?: Vars) => string;

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

/**
 * The locale is decided on the server (cookie → Accept-Language) and handed
 * down, so server HTML and the first client render agree — no flash of the
 * wrong language and no hydration mismatch.
 */
export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  syncCurrentLocale(locale);
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

export function useT(): Translate {
  const locale = useLocale();
  return useCallback((key: MessageKey, vars?: Vars) => translate(locale, key, vars), [locale]);
}

/**
 * `t` for messages that carry a React node inside them — an animated counter, a
 * badge, a link. The node fills a `{slot}` placeholder, so the translation keeps
 * one sentence with the element wherever that language wants it, instead of
 * being chopped into "before" and "after" halves that fix the word order.
 */
export function useRichT(): (
  key: MessageKey,
  slots: Record<string, ReactNode>,
  vars?: Vars,
) => ReactNode {
  const locale = useLocale();
  return useCallback(
    (key: MessageKey, slots: Record<string, ReactNode>, vars?: Vars) => {
      const text = translate(locale, key, vars);
      // Split keeps the delimiters, so odd indices are the placeholder names.
      const parts = text.split(/\{(\w+)\}/g);
      return parts.map((part, i) =>
        i % 2 === 1 ? (
          <Fragment key={i}>{slots[part] ?? `{${part}}`}</Fragment>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      );
    },
    [locale],
  );
}

/**
 * Locale-aware Intl formatters, memoised per render. Dates, times and numbers
 * are formatted by Intl rather than by hand, so a new language needs no extra
 * dictionary entries for them.
 */
export function useFormatters() {
  const locale = useLocale();
  return useMemo(
    () => ({
      locale,
      time: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }),
      date: new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }),
      number: new Intl.NumberFormat(locale),
    }),
    [locale],
  );
}

/**
 * Switches the language: persists the choice in the cookie the server reads and
 * reloads. A reload rather than a state swap because the locale also decides
 * server-rendered pieces (`<html lang>`, document title) — this keeps the one
 * source of truth instead of two that can drift.
 */
export function setLocale(locale: Locale): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax`;
  syncCurrentLocale(locale);
  window.location.reload();
}

// ——— non-React access ————————————————————————————————————————————————

/**
 * Current locale outside React. Toasts, socket handlers and store actions build
 * user-visible text far from any component; they read this. Kept in sync by the
 * provider on every render.
 *
 * Client-only by contract: on the server a module-level value would be shared
 * between concurrent requests, so server code must go through `getLocale()`
 * (lib/i18n/server.ts) instead.
 */
let currentLocale: Locale = DEFAULT_LOCALE;

function syncCurrentLocale(locale: Locale): void {
  // Guarded: this component also renders on the server during SSR, where a
  // module-level value would leak between concurrent requests.
  if (typeof window !== 'undefined') currentLocale = locale;
}

/** Locale guess for code that runs before the provider mounts (e.g. the theme-style init). */
export function detectBrowserLocale(): Locale {
  if (typeof navigator === 'undefined') return DEFAULT_LOCALE;
  return matchLocale(navigator.languages?.length ? navigator.languages : [navigator.language]);
}

/** Reads the cookie directly — for the rare client path that runs outside React. */
export function readLocaleCookie(): Locale | null {
  if (typeof document === 'undefined') return null;
  const hit = document.cookie.match(new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]*)`));
  const value = hit?.[1] && decodeURIComponent(hit[1]);
  return isLocale(value) ? value : null;
}

/** Current locale for non-React call sites (Intl formatters). Client-only — see currentLocale. */
export function getClientLocale(): Locale {
  return currentLocale;
}

/** `t` for non-React call sites (toasts, store actions). Client-only — see currentLocale. */
export function tx(key: MessageKey, vars?: Vars): string {
  return translate(currentLocale, key, vars);
}
