// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Мелкие клиентские подсистемы: адрес сокета, ICE-конфиг, горячие клавиши и
 * звуки эфира. Общее у них одно — каждая обязана пережить отказ окружения. Ни
 * упавший `/api/config`, ни политика автоплея, ни фокус в поле ввода не должны
 * ронять звонок или воровать набор текста.
 */

// socket.io-client тянуть незачем: проверяем разбор адреса, а не транспорт.
vi.mock('socket.io-client', () => ({ io: vi.fn() }));

// ── socket: гостевой токен из адреса ──────────────────────────────────────

describe('гостевой токен из адреса', () => {
  async function tokenAt(pathname: string) {
    vi.resetModules();
    window.history.replaceState({}, '', pathname);
    const { guestTokenFromLocation } = await import('./socket');
    return guestTokenFromLocation();
  }

  it('берётся со страницы инвайта', async () => {
    expect(await tokenAt('/invite/g1.abc.123.sig')).toBe('g1.abc.123.sig');
  });

  it('декодируется — токен ездит в пути и может быть закодирован', async () => {
    expect(await tokenAt('/invite/a%2Bb')).toBe('a+b');
  });

  it('вне инвайт-страницы токена нет', async () => {
    expect(await tokenAt('/')).toBeNull();
    expect(await tokenAt('/channels/obshchii')).toBeNull();
    expect(await tokenAt('/invite/')).toBeNull();
  });

  it('хвост после токена не попадает в него', async () => {
    expect(await tokenAt('/invite/abc/лишнее')).toBe('abc');
  });
});

// ── config: ICE и признак медиасервера ────────────────────────────────────

describe('конфиг с бэка', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    window.history.replaceState({}, '', '/');
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const ok = (body: unknown) => ({ ok: true, json: async () => body });

  it('отдаёт ICE-серверы и признак медиасервера', async () => {
    fetchMock.mockResolvedValue(
      ok({ iceServers: [{ urls: ['turn:relay.example'] }], sfu: { available: true } }),
    );
    const { getIceServers, isSfuAvailable } = await import('./config');
    expect(await getIceServers()).toEqual([{ urls: ['turn:relay.example'] }]);
    expect(await isSfuAvailable()).toBe(true);
  });

  it('спрашивает бэк один раз на сессию — обе половины из одного ответа', async () => {
    fetchMock.mockResolvedValue(ok({ iceServers: [], sfu: { available: false } }));
    const { getIceServers, isSfuAvailable } = await import('./config');
    await getIceServers();
    await isSfuAvailable();
    await getIceServers();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('упавший бэк не отменяет звонок — остаётся публичный STUN', async () => {
    fetchMock.mockRejectedValue(new Error('сеть'));
    const { getIceServers, isSfuAvailable } = await import('./config');
    const ice = await getIceServers();
    expect(ice[0].urls[0]).toContain('stun:');
    // А медиасервер при этом считаем отсутствующим — фолбэк на p2p рабочий.
    expect(await isSfuAvailable()).toBe(false);
  });

  it('не-200 — тот же фолбэк, а не пустой список', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    const { getIceServers } = await import('./config');
    expect((await getIceServers()).length).toBeGreaterThan(0);
  });

  it('пустой список ICE от бэка заменяется фолбэком', async () => {
    fetchMock.mockResolvedValue(ok({ iceServers: [], sfu: { available: false } }));
    const { getIceServers } = await import('./config');
    expect((await getIceServers())[0].urls[0]).toContain('stun:');
  });

  it('гость предъявляет инвайт-токен — без него конфиг ответил бы 401', async () => {
    window.history.replaceState({}, '', '/invite/гостевой-токен');
    fetchMock.mockResolvedValue(ok({ iceServers: [{ urls: ['stun:x'] }] }));
    const { getIceServers } = await import('./config');
    await getIceServers();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: { authorization: 'Bearer гостевой-токен' },
    });
  });

  /**
   * Учётки TURN теперь временные, и кэш «на сессию» вместе с ними перестал
   * быть верным навсегда. Вкладка, открытая со вчера, обязана сходить за новой
   * парой — иначе она будет звонить с просроченной, и не с ошибкой, а тишиной.
   */
  it('пара при смерти — за конфигом идут заново', async () => {
    const soon = Math.floor(Date.now() / 1000) + 60;
    fetchMock.mockResolvedValue(ok({ iceServers: [{ urls: ['turn:x'] }], iceExpiresAt: soon }));
    const { getIceServers } = await import('./config');
    await getIceServers();
    await getIceServers();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('пара свежая — лишнего запроса нет', async () => {
    const later = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    fetchMock.mockResolvedValue(ok({ iceServers: [{ urls: ['turn:x'] }], iceExpiresAt: later }));
    const { getIceServers } = await import('./config');
    await getIceServers();
    await getIceServers();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * Тот же кэш, но про другое поле: медиасервер, поднятый после того как
   * вкладку открыли, оставался выключенным в интерфейсе до перезагрузки —
   * пропуска на него api выдавал, а переключатель говорил «нет».
   */
  it('медиасервер, поднявшийся позже, доезжает без перезагрузки страницы', async () => {
    const started = Date.now();
    fetchMock.mockResolvedValueOnce(
      ok({ iceServers: [{ urls: ['stun:x'] }], sfu: { available: false } }),
    );
    const { isSfuAvailable } = await import('./config');
    expect(await isSfuAvailable()).toBe(false);

    vi.spyOn(Date, 'now').mockReturnValue(started + 11 * 60 * 1000);
    fetchMock.mockResolvedValueOnce(
      ok({ iceServers: [{ urls: ['stun:x'] }], sfu: { available: true } }),
    );
    expect(await isSfuAvailable()).toBe(true);
  });

  it('обычный участник ходит с кукой и без Bearer', async () => {
    fetchMock.mockResolvedValue(ok({ iceServers: [{ urls: ['stun:x'] }] }));
    const { getIceServers } = await import('./config');
    await getIceServers();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'include' });
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('headers');
  });
});

// ── горячие клавиши ───────────────────────────────────────────────────────

describe('горячие клавиши', () => {
  it('комбинация не зависит от раскладки — берём code, а не символ', async () => {
    const { eventToCombo } = await import('./hotkeys');
    const e = new KeyboardEvent('keydown', { code: 'KeyM', ctrlKey: true, shiftKey: true });
    expect(eventToCombo(e)).toBe('Ctrl+Shift+KeyM');
  });

  it('модификаторы всегда в одном порядке — иначе одна и та же комбинация не совпала бы', async () => {
    const { eventToCombo } = await import('./hotkeys');
    const e = new KeyboardEvent('keydown', {
      code: 'KeyM',
      metaKey: true,
      altKey: true,
      shiftKey: true,
      ctrlKey: true,
    });
    expect(eventToCombo(e)).toBe('Ctrl+Alt+Shift+Meta+KeyM');
  });

  it('голый модификатор комбинацией не считается — ждём основную клавишу', async () => {
    const { eventToCombo } = await import('./hotkeys');
    for (const code of ['ShiftLeft', 'ControlRight', 'AltLeft', 'MetaRight']) {
      expect(eventToCombo(new KeyboardEvent('keydown', { code })), code).toBeNull();
    }
  });

  it('подпись читаема человеком, а не кодом клавиши', async () => {
    const { comboLabel } = await import('./hotkeys');
    expect(comboLabel('Ctrl+Shift+KeyM')).toBe('Ctrl + Shift + M');
    expect(comboLabel('Digit5')).toBe('5');
    expect(comboLabel('Numpad3')).toBe('Num 3');
    expect(comboLabel('Meta+Space')).toBe('⌘ + Space');
    expect(comboLabel('Escape')).toBe('Esc');
    expect(comboLabel('ArrowUp')).toBe('↑');
    // Неизвестное показываем как есть, а не прячем.
    expect(comboLabel('F13')).toBe('F13');
  });
});

// ── звуки эфира ───────────────────────────────────────────────────────────

describe('звуки эфира', () => {
  class FakeAudio {
    static made: FakeAudio[] = [];
    volume = 1;
    currentTime = 0;
    preload = '';
    src = '';
    paused = false;
    played = false;
    private ended: (() => void) | null = null;
    constructor(src?: string) {
      if (src) this.src = src;
      FakeAudio.made.push(this);
    }
    addEventListener(event: string, fn: () => void) {
      if (event === 'ended') this.ended = fn;
    }
    async play() {
      this.played = true;
    }
    pause() {
      this.paused = true;
    }
    finish() {
      this.ended?.();
    }
  }

  async function sfx() {
    vi.resetModules();
    FakeAudio.made = [];
    vi.stubGlobal('Audio', FakeAudio);
    const { getSfx } = await import('./sfx');
    return getSfx();
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('проигрывает звук с общей громкостью, а не на полную', async () => {
    const api = await sfx();
    expect(api.play('join')).not.toBeNull();
    const el = FakeAudio.made[FakeAudio.made.length - 1];
    expect(el.played).toBe(true);
    expect(el.src).toContain('/sfx/join.mp3');
    expect(el.volume).toBeLessThan(1);
  });

  it('глушилка молчит, но остаётся переключаемой', async () => {
    const api = await sfx();
    expect(api.isMuted()).toBe(false);
    expect(api.toggle()).toBe(true);
    expect(api.play('join')).toBeNull();
    api.setMuted(false);
    expect(api.play('join')).not.toBeNull();
  });

  it('выключенные динамики глушат всё, независимо от собственной глушилки', async () => {
    const api = await sfx();
    api.setAllMuted(true);
    expect(api.play('peerJoin')).toBeNull();
    api.setAllMuted(false);
    expect(api.play('peerJoin')).not.toBeNull();
  });

  it('окончание звука зовёт обработчик', async () => {
    const api = await sfx();
    const handle = api.play('leave')!;
    const done = vi.fn();
    handle.onended = done;
    FakeAudio.made[FakeAudio.made.length - 1].finish();
    expect(done).toHaveBeenCalled();
  });

  it('stop останавливает и перематывает', async () => {
    const api = await sfx();
    api.play('connLost');
    const el = FakeAudio.made[FakeAudio.made.length - 1];
    api.stop('connLost');
    expect(el.paused).toBe(true);
    expect(el.currentTime).toBe(0);
    // Повторный stop уже нечего останавливать.
    expect(() => api.stop('connLost')).not.toThrow();
  });

  it('затухание доводит громкость до нуля и гасит элемент', async () => {
    vi.useFakeTimers();
    const api = await sfx();
    api.play('connLost');
    const el = FakeAudio.made[FakeAudio.made.length - 1];
    api.fadeOut('connLost', 0.2);
    vi.advanceTimersByTime(1000);
    expect(el.volume).toBe(0);
    expect(el.paused).toBe(true);
    expect(() => api.fadeOut('reconnect')).not.toThrow();
    vi.useRealTimers();
  });

  it('смена устройства вывода не роняет звонок там, где её не умеют', async () => {
    const api = await sfx();
    api.play('join');
    expect(() => api.setSinkId('устройство-2')).not.toThrow();
  });

  it('вне браузера — безопасная заглушка, а не падение при импорте', async () => {
    vi.resetModules();
    vi.stubGlobal('Audio', undefined);
    const { getSfx } = await import('./sfx');
    const api = getSfx();
    expect(api.play('join')).toBeNull();
    expect(api.toggle()).toBe(true);
    expect(api.isMuted()).toBe(true);
    api.setMuted(false);
    expect(api.isMuted()).toBe(false);
    expect(() => {
      api.stop('join');
      api.fadeOut('join');
      api.setAllMuted(true);
      api.setSinkId('x');
    }).not.toThrow();
  });

  it('пул один на приложение', async () => {
    const api = await sfx();
    const { getSfx } = await import('./sfx');
    expect(getSfx()).toBe(api);
  });
});
