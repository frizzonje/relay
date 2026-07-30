import { DEFAULT_LOCALE, type Locale } from './config';
import en from './messages/en.json';
import ru from './messages/ru.json';

/**
 * A dictionary entry is either a plain string or a set of plural forms keyed by
 * CLDR category. Categories are resolved at runtime through Intl.PluralRules,
 * so a language with three forms (ru: one/few/many) or six (ar) needs no code
 * change — only the extra keys in its own JSON.
 */
export type Message = string | Partial<Record<Intl.LDMLPluralRule, string>>;

export type Messages = Record<string, Message>;

/** Every key that exists — en.json is the reference, so it defines the type. */
export type MessageKey = keyof typeof en;

/** Values interpolated into `{placeholders}`. `count` also drives plural choice. */
export type Vars = Record<string, string | number>;

const DICTIONARIES: Record<Locale, Messages> = {
  en: en as Messages,
  ru: ru as Messages,
};

export function messagesFor(locale: Locale): Messages {
  return DICTIONARIES[locale] ?? DICTIONARIES[DEFAULT_LOCALE];
}

/**
 * Picks the plural form for `count` in `locale`. Falls back to `other` (the one
 * category every language has) and then to any form present, so a half-finished
 * translation degrades to a wrong-but-readable string instead of a blank.
 */
function selectPlural(
  locale: Locale,
  forms: Partial<Record<Intl.LDMLPluralRule, string>>,
  count: number,
): string | undefined {
  const category = new Intl.PluralRules(locale).select(count);
  return forms[category] ?? forms.other ?? Object.values(forms)[0];
}

/** Replaces `{name}` with vars.name; unknown placeholders are left verbatim. */
function interpolate(template: string, vars: Vars | undefined): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

function resolve(messages: Messages, key: string, vars: Vars | undefined, locale: Locale) {
  const entry = messages[key];
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    const count = typeof vars?.count === 'number' ? vars.count : 0;
    return selectPlural(locale, entry, count);
  }
  return undefined;
}

/**
 * Core lookup: locale dictionary → English → the key itself. Returning the key
 * keeps the UI usable (and makes the gap obvious) when a translation is missing.
 */
export function translate(locale: Locale, key: MessageKey | string, vars?: Vars): string {
  const own = resolve(messagesFor(locale), key, vars, locale);
  if (own !== undefined) return interpolate(own, vars);

  const fallback = resolve(messagesFor(DEFAULT_LOCALE), key, vars, DEFAULT_LOCALE);
  if (fallback !== undefined) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[i18n] no "${key}" in ${locale} — falling back to ${DEFAULT_LOCALE}`);
    }
    return interpolate(fallback, vars);
  }

  if (process.env.NODE_ENV !== 'production') {
    console.warn(`[i18n] unknown key "${key}"`);
  }
  return key;
}
