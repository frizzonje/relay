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

  it.each(LOCALES)('%s has no empty strings', (locale) => {
    for (const [key, entry] of Object.entries(load(locale))) {
      const texts = typeof entry === 'string' ? [entry] : Object.values(entry);
      for (const text of texts) expect([key, text.trim()]).not.toEqual([key, '']);
    }
  });
});
