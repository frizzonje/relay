import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS, defaults, settingSpec } from '@relay/shared';
import { ownerText, setting, useConfigStore } from './config';

/**
 * Настройки инсталляции глазами браузера.
 *
 * Проверяется здесь не «стор кладёт то, что дали» — это видно и так, — а два
 * обещания, которые ломаются молча. Первое: вкладка, которой снимок не доехал,
 * ведёт себя как до появления панели (умолчания каталога равны вчерашнему
 * поведению relay). Второе: сервер шлёт ровно то, чем клиент пользуется, — ни
 * больше, чтобы чужой браузер не получал список стоп-слов, ни меньше, чтобы
 * настройка не оказалась вечно равной умолчанию.
 */

beforeEach(() => useConfigStore.setState({ settings: defaults() }));

describe('снимок', () => {
  it('до первого ответа сервера действуют умолчания каталога', () => {
    // Не заглушка «пока грузится»: умолчание каталога — это и есть сегодняшнее
    // поведение, поэтому отдельного состояния «ещё не знаем» тут не нужно.
    expect(setting<number>('messages.maxLength')).toBe(settingSpec('messages.maxLength')!.fallback);
    expect(setting<boolean>('people.showFingerprints')).toBe(true);
  });

  it('приехавший снимок ложится поверх умолчаний, а не вместо них', () => {
    // Сервер прошлой версии не знает о параметре, заведённом в этом клиенте.
    // Пропавший ключ обязан вернуться к умолчанию каталога, а не к `undefined`:
    // иначе экран, читающий его, покажет пустоту вместо числа.
    useConfigStore.getState().apply({ 'messages.maxLength': 900 });
    expect(setting<number>('messages.maxLength')).toBe(900);
    expect(setting<boolean>('people.showFingerprints')).toBe(true);
  });

  it('пустой ответ ничего не портит', () => {
    useConfigStore.getState().apply({ 'messages.maxLength': 900 });
    useConfigStore.getState().apply(undefined);
    expect(setting<number>('messages.maxLength')).toBe(900);
  });

  it('неизвестный ключ — исключение, а не пустота', () => {
    // Ровно как на сервере: опечатка иначе выключила бы проверку молча.
    expect(() => setting('messages.нетТакого')).toThrow();
  });
});

describe('текст владельца', () => {
  it('нетронутое умолчание показывается переводом, а не английской строкой', () => {
    // Умолчания каталога написаны на языке базы (en.json). Подставить их вместо
    // перевода значило бы ответить русскоязычному человеку по-английски на
    // инсталляции, где панель не открывали ни разу.
    expect(ownerText('direct.privacyNotice', 'Беседы видит владелец')).toBe(
      'Беседы видит владелец',
    );
  });

  it('написанное владельцем показывается как есть', () => {
    useConfigStore.getState().apply({ 'direct.privacyNotice': 'У нас читают всё' });
    expect(ownerText('direct.privacyNotice', 'Беседы видит владелец')).toBe('У нас читают всё');
  });
});

/**
 * Пометка `client` в каталоге и то, что клиент читает на самом деле, — две
 * стороны одного обещания, и разъезжаются они молча в обе стороны.
 *
 * Лишняя пометка — утечка: значение уезжает каждой вкладке, включая гостя по
 * ссылке. Недостающая — вечное умолчание: `useSetting` вернёт значение из
 * каталога, экран не сломается, и владелец будет двигать в панели поле, от
 * которого ничего не меняется. Второй случай хуже, потому что тише.
 */
describe('пометка «нужно клиенту» совпадает с тем, что клиент читает', () => {
  const root = join(__dirname, '..');
  const skip = new Set(['node_modules', '.next', 'coverage', 'test-results']);

  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      if (skip.has(name)) return [];
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });

  /** Ключи каталога, помянутые в исходниках веба строкой. */
  const mentioned = (): Set<string> => {
    const known = new Set(SETTINGS.map((s) => s.key));
    const found = new Set<string>();
    for (const path of sources(root)) {
      const text = readFileSync(path, 'utf8');
      // Ключи i18n выглядят так же (`voice.mic`), поэтому отбираем не по форме,
      // а по совпадению с каталогом — единственный надёжный признак.
      for (const m of text.matchAll(/'([a-z]+\.[a-zA-Z]+)'/g)) {
        if (known.has(m[1])) found.add(m[1]);
      }
    }
    return found;
  };

  it('всё, что клиент читает, помечено — иначе оно навсегда равно умолчанию', () => {
    const unmarked = [...mentioned()].filter((key) => !settingSpec(key)?.client);
    expect(unmarked).toEqual([]);
  });

  it('всё помеченное клиент действительно читает — иначе это лишняя раздача', () => {
    const used = mentioned();
    const idle = SETTINGS.filter((s) => s.client && !used.has(s.key)).map((s) => s.key);
    expect(idle).toEqual([]);
  });

  it('стоп-слова и пороги блокировки клиенту не уезжают', () => {
    // Названы поимённо: это те значения, ради которых снимок вообще отделён от
    // `public()`. Пометка на любом из них — не опечатка, а решение, и принимать
    // его надо, глядя на упавший тест.
    for (const key of [
      'moderation.bannedWords',
      'access.unlockAttempts',
      'access.unlockLockoutMinutes',
      'access.loginRatePerMinute',
      'moderation.messageRatePerMinute',
      'files.installQuotaBytes',
    ]) {
      expect(settingSpec(key)?.client ?? false).toBe(false);
    }
  });
});
