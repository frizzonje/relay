// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Настройки человека против настроек этой машины — и что происходит, когда обе
 * стороны решили по-своему.
 *
 * Проверяется здесь ровно то, ради чего переезд и затевался: настройка,
 * сделанная на одном устройстве, доезжает до другого, а сделанная без личности
 * не пропадает, когда личность наконец появляется.
 */

const socket = vi.hoisted(() => ({
  connected: true,
  emit: vi.fn(),
}));
vi.mock('@/lib/socket', () => ({ getSocket: () => socket }));

import { PREF_STORAGE, adoptPrefs, onPref, readPref, setPref } from './prefs';

beforeEach(() => {
  localStorage.clear();
  socket.connected = true;
  socket.emit.mockClear();
});

describe('настройка человека', () => {
  it('запоминается локально и уезжает на сервер', () => {
    setPref('sound', ['общий']);
    expect(readPref('sound', [])).toEqual(['общий']);
    expect(socket.emit).toHaveBeenCalledWith('prefs-set', { key: 'sound', value: ['общий'] });
  });

  it('без связи остаётся здесь — и это работающее приложение, а не отказ', () => {
    socket.connected = false;
    setPref('sound', ['общий']);
    expect(readPref('sound', [])).toEqual(['общий']);
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('испорченное хранилище читается как «ничего не настроено»', () => {
    localStorage.setItem(PREF_STORAGE.sound, '{не json');
    expect(readPref('sound', ['по умолчанию'])).toEqual(['по умолчанию']);
  });
});

describe('настройки с сервера', () => {
  it('правка с другого устройства ложится в кэш и будит подписчиков', () => {
    const seen: unknown[] = [];
    const off = onPref('sound', (value) => seen.push(value));

    adoptPrefs({ sound: ['флуд'] });

    expect(seen).toEqual([['флуд']]);
    expect(readPref('sound', [])).toEqual(['флуд']);
    // Пришло с сервера — обратно не отправляем, иначе два устройства устроили
    // бы друг другу вечную переписку.
    expect(socket.emit).not.toHaveBeenCalled();
    off();
  });

  it('снимок забирает наверх то, что настроено до появления личности', () => {
    localStorage.setItem(PREF_STORAGE.volume, JSON.stringify({ a1b2: { voice: 2 } }));

    adoptPrefs({ sound: ['общий'] }, { full: true });

    // Сервер про громкости не знал — значит человек выкручивал их в этом
    // браузере ещё без ключа. Такое не теряем.
    expect(socket.emit).toHaveBeenCalledWith('prefs-set', {
      key: 'volume',
      value: { a1b2: { voice: 2 } },
    });
  });

  it('за известный серверу ключ клиент не спорит', () => {
    localStorage.setItem(PREF_STORAGE.sound, JSON.stringify(['старое']));

    adoptPrefs({ sound: ['с телефона'] }, { full: true });

    // Иначе вкладка, провалявшаяся сутки открытой, возвращала бы звук каналам,
    // которые человек вчера заглушил с другого устройства.
    expect(readPref('sound', [])).toEqual(['с телефона']);
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('снимок без ничего и с пустым кэшем не порождает разговора', () => {
    adoptPrefs({}, { full: true });
    expect(socket.emit).not.toHaveBeenCalled();
  });
});
