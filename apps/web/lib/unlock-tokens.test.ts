// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dropUnlockToken,
  hasUnlockToken,
  loadUnlockTokens,
  saveUnlockToken,
  unlockTokenIds,
} from '@/lib/unlock-tokens';

/**
 * Пропуска в закрытые серверы. Они существуют затем, чтобы разблокировка
 * пережила реконнект: список уезжает в handshake (см. lib/socket), и сервер
 * открывает каналы ещё до первой рассылки реестра.
 *
 * Прежде эту роль играл сохранённый пароль, который переигрывали уже ПОСЛЕ
 * подключения, — и он опаздывал: `join` в голосовой канал уходил раньше ответа
 * на `server-unlock`, и сервер его отбивал. Отсюда требование к хранилищу:
 * пропуск обязан читаться синхронно, до всякого обмена с сервером.
 */
describe('пропуска в закрытые серверы', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('сохранённый пропуск читается сразу и переживает перезагрузку', () => {
    saveUnlockToken('srv', 'u1.token');
    expect(hasUnlockToken('srv')).toBe(true);
    expect(loadUnlockTokens()).toEqual(['u1.token']);
  });

  it('пропуска разных серверов не мешают друг другу', () => {
    saveUnlockToken('a', 'токен-a');
    saveUnlockToken('b', 'токен-b');
    expect(loadUnlockTokens().sort()).toEqual(['токен-a', 'токен-b']);
    expect(unlockTokenIds().sort()).toEqual(['a', 'b']);

    dropUnlockToken('a');
    expect(hasUnlockToken('a')).toBe(false);
    expect(loadUnlockTokens()).toEqual(['токен-b']);
  });

  it('повторная выдача заменяет прежний пропуск, а не копит', () => {
    saveUnlockToken('srv', 'старый');
    saveUnlockToken('srv', 'новый');
    expect(loadUnlockTokens()).toEqual(['новый']);
  });

  it('без единого пропуска список пуст — в handshake ехать нечему', () => {
    expect(loadUnlockTokens()).toEqual([]);
    expect(hasUnlockToken('srv')).toBe(false);
  });

  it('битое хранилище не роняет вход', () => {
    localStorage.setItem('relay-unlock', 'не json');
    expect(loadUnlockTokens()).toEqual([]);
    // И поверх мусора всё ещё можно записать.
    saveUnlockToken('srv', 'токен');
    expect(loadUnlockTokens()).toEqual(['токен']);
  });

  it('чужая форма данных игнорируется, а не подсовывается сокету', () => {
    localStorage.setItem('relay-unlock', JSON.stringify({ srv: 42, other: 'токен' }));
    expect(loadUnlockTokens()).toEqual(['токен']);
  });

  it('недоступное хранилище (приватный режим) — просто нет пропусков', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    expect(() => saveUnlockToken('srv', 'токен')).not.toThrow();
    expect(loadUnlockTokens()).toEqual([]);
  });
});
