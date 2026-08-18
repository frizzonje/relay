import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverVersion } from './version';

/**
 * Версия — то, по чему человек в About судит, обновился ли сервер. Пустая
 * строка здесь честнее любого выдуманного числа: по номеру начнут сверять
 * поведение, и выдуманный увёл бы в сторону вернее, чем отсутствующий.
 */
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('версия сервера', () => {
  it('приезжает из окружения сборки', () => {
    vi.stubEnv('RELAY_VERSION', '1.0.0');
    expect(serverVersion()).toBe('1.0.0');
  });

  it('не задана — пусто, а не выдуманный номер: так собирают из исходников', () => {
    vi.stubEnv('RELAY_VERSION', '');
    expect(serverVersion()).toBe('');
  });

  it('пробелы от build-arg не превращаются в версию', () => {
    vi.stubEnv('RELAY_VERSION', '  1.0.0  ');
    expect(serverVersion()).toBe('1.0.0');
    vi.stubEnv('RELAY_VERSION', '   ');
    expect(serverVersion()).toBe('');
  });
});
