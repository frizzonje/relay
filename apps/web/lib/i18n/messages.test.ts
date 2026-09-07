import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, LOCALES, type Locale } from './config';

/**
 * The promise behind "adding a language is just one more JSON": these tests
 * fail the build when a dictionary drifts from the reference one — a missing
 * key, a dropped `{placeholder}`, or a plural form the language actually needs.
 * Read the files from disk (rather than importing) so a locale that exists on
 * disk but was never registered in config.ts is caught too.
 */
const DIR = join(dirname(fileURLToPath(import.meta.url)), 'messages');

type Entry = string | Record<string, string>;

function load(locale: string): Record<string, Entry> {
  return JSON.parse(readFileSync(join(DIR, `${locale}.json`), 'utf8'));
}

const reference = load(DEFAULT_LOCALE);
const others = LOCALES.filter((l) => l !== DEFAULT_LOCALE);

/** Placeholder names used in a message, across all plural forms. */
function placeholders(entry: Entry): Set<string> {
  const texts = typeof entry === 'string' ? [entry] : Object.values(entry);
  const names = new Set<string>();
  for (const text of texts) {
    for (const [, name] of text.matchAll(/\{(\w+)\}/g)) names.add(name);
  }
  return names;
}

describe('message dictionaries', () => {
  it('registers every file on disk as a locale', () => {
    const onDisk = readdirSync(DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
    expect(onDisk).toEqual([...LOCALES].sort());
  });

  it.each(others)('%s has exactly the keys of the reference locale', (locale) => {
    const keys = Object.keys(load(locale)).sort();
    expect(keys).toEqual(Object.keys(reference).sort());
  });

  it.each(others)('%s keeps the same placeholders as the reference', (locale) => {
    const dict = load(locale);
    for (const [key, refEntry] of Object.entries(reference)) {
      const entry = dict[key];
      if (entry === undefined) continue; // reported by the key-parity test
      expect([key, [...placeholders(entry)].sort()]).toEqual([
        key,
        [...placeholders(refEntry)].sort(),
      ]);
    }
  });

  it.each(LOCALES)('%s covers every plural category its language needs', (locale: Locale) => {
    const dict = load(locale);
    const required = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
    for (const [key, refEntry] of Object.entries(reference)) {
      if (typeof refEntry === 'string') continue; // not a plural message
      const entry = dict[key];
      if (entry === undefined) continue;
      expect([key, typeof entry]).toEqual([key, 'object']);
      const forms = Object.keys(entry as Record<string, string>).sort();
      expect([key, forms]).toEqual([key, [...required].sort()]);
    }
  });

  /**
   * The owner panel names its tabs from two dictionaries at once: the catalogue
   * groups (`settings.group.*`) and the tabs that carry no settings
   * (`admin.tab.*`). Two of them holding the same word is not a translation
   * nicety — the panel then shows two tabs called the same thing, and the only
   * way to tell them apart is to press one. That is exactly what happened to
   * "Обслуживание": the maintenance-mode group and the Upkeep tab shared it,
   * while English kept them apart as "Maintenance" and "Upkeep".
   */
  it.each(LOCALES)('%s gives every panel tab its own name', (locale) => {
    const dict = load(locale);
    const seen = new Map<string, string>();
    for (const [key, entry] of Object.entries(dict)) {
      if (!key.startsWith('admin.tab.') && !key.startsWith('settings.group.')) continue;
      const name = String(entry);
      expect([name, seen.get(name) ?? key]).toEqual([name, key]);
      seen.set(name, key);
    }
  });

  it.each(LOCALES)('%s has no empty strings', (locale) => {
    for (const [key, entry] of Object.entries(load(locale))) {
      const texts = typeof entry === 'string' ? [entry] : Object.values(entry);
      for (const text of texts) expect([key, text.trim()]).not.toEqual([key, '']);
    }
  });

  /**
   * `call.delivery` is the honest limitation of the 1:1 call plan, printed on
   * the outgoing-call screen: it must name exactly the surfaces a call really
   * reaches. Relay has no push gateway, and the mobile app (the iOS client)
   * subscribes to no call event at all — see
   * clients/ios/Relay/Core/SocketClient.swift — so a person on a phone looks
   * reachable (presence follows the socket, and their socket is alive) while
   * the phone never rings. Naming the mobile app here is a promise the code
   * does not keep, and this is the one line the owner reads while checking the
   * plan against a live call.
   *
   * "Mobile web" stays allowed on purpose: saying that a backgrounded mobile
   * browser misses the call is true, and it is the same warning the second
   * line (`call.delivery.mobile`) gives about your own phone.
   *
   * The table is complete by type (`Record<Locale, …>`), not by conscience: a
   * new language cannot join the build until someone says how that promise
   * would read in it. Cyrillic endings are spelled out as a character class:
   * JavaScript's `\w` is ASCII-only, so `\w*` would never match "десктопное".
   */
  const NO_MOBILE_APP: Record<Locale, RegExp> = {
    en: /mobile app|desktop\/mobile/i,
    ru: /мобильн[а-яё]*\s+(приложени|клиент)|десктопн[а-яё]*\s+или\s+мобильн/i,
  };

  it.each(LOCALES)('%s does not promise a mobile app in call.delivery', (locale: Locale) => {
    expect(String(load(locale)['call.delivery'])).not.toMatch(NO_MOBILE_APP[locale]);
  });
});
