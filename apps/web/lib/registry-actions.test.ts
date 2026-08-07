// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Действия над реестрами серверов и каналов. Оптимистично здесь не рисуется
 * ничего — вся ценность в обработке ОТКАЗА: сервер отвечает кодом, и человек
 * обязан увидеть, почему строка осталась на месте, а не гадать. Отдельно —
 * случай «ответа не было вовсе»: без тайм-аута диалог висел бы навсегда.
 */

const emit = vi.hoisted(() => vi.fn());
vi.mock('@/lib/socket', () => ({ getSocket: () => ({ emit }) }));

const toast = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast }));

const activeServerId = vi.hoisted(() => ({ value: 'srv-1' }));
vi.mock('@/stores/servers', () => ({
  useServersStore: { getState: () => ({ activeServerId: activeServerId.value }) },
}));

import { MAIN_SERVER_ID } from './constants';
import {
  ask,
  channelStats,
  createChannel,
  deleteChannel,
  renameChannel,
  setChannelMode,
} from './channels';
import {
  createServer,
  deleteServer,
  forgetServerPassword,
  rememberServerPassword,
  serverStats,
  storedServerPasswords,
  unlockServer,
} from './servers';

/** Ответить на последний emit так, как ответил бы сервер. */
function reply(value: unknown) {
  const call = emit.mock.calls[emit.mock.calls.length - 1];
  (call[2] as (v: unknown) => void)(value);
}

beforeEach(() => {
  vi.useFakeTimers();
  emit.mockClear();
  toast.mockClear();
  activeServerId.value = 'srv-1';
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('создание канала', () => {
  it('уходит в активный сервер с обрезанным именем', () => {
    createChannel('text', '  болталка  ');
    expect(emit).toHaveBeenCalledWith('channel-create', {
      serverId: 'srv-1',
      type: 'text',
      name: 'болталка',
    });
  });

  it('режим передаётся только когда задан', () => {
    createChannel('voice', 'эфир', 'sfu');
    expect(emit.mock.calls[0][1]).toMatchObject({ mode: 'sfu' });
    emit.mockClear();
    createChannel('voice', 'эфир');
    expect(emit.mock.calls[0][1]).not.toHaveProperty('mode');
  });

  it('пустое имя не отправляется вовсе', () => {
    createChannel('text', '   ');
    expect(emit).not.toHaveBeenCalled();
  });

  it('в главный сервер не пускает и объясняет, а не глотает', () => {
    activeServerId.value = MAIN_SERVER_ID;
    createChannel('text', 'лишний');
    expect(emit).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalled();
  });
});

describe('отказы сервера объясняются человеку', () => {
  it('канал занят — в тосте есть число людей', async () => {
    const p = deleteChannel('ch-1');
    reply({ ok: false, error: 'occupied', occupants: 3 });
    expect(await p).toBe(false);
    expect(String(toast.mock.calls[0][0])).toMatch(/3/);
  });

  it('каждый код отказа даёт свой текст — не один «что-то пошло не так»', async () => {
    const texts = new Set<string>();
    for (const error of ['occupied', 'forbidden', 'not-owner', 'not-found']) {
      toast.mockClear();
      const p = deleteChannel('ch-1');
      reply({ ok: false, error });
      await p;
      texts.add(String(toast.mock.calls[0][0]));
    }
    expect(texts.size).toBe(4);
  });

  it('успех не показывает тост', async () => {
    const p = deleteChannel('ch-1');
    reply({ ok: true });
    expect(await p).toBe(true);
    expect(toast).not.toHaveBeenCalled();
  });

  it('пустой id даже не спрашивает сервер', async () => {
    expect(await deleteChannel('')).toBe(false);
    expect(await renameChannel('', 'имя')).toBe(false);
    expect(await renameChannel('ch-1', '  ')).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('переименование', () => {
  it('имя режется до 32 символов ещё на клиенте', async () => {
    const p = renameChannel('ch-1', 'и'.repeat(100));
    expect((emit.mock.calls[0][1] as { name: string }).name).toHaveLength(32);
    reply({ ok: true });
    expect(await p).toBe(true);
  });

  it('плохое имя объясняется отдельно от «не твой канал»', async () => {
    const p = renameChannel('ch-1', 'имя');
    reply({ ok: false, error: 'bad-name' });
    await p;
    const badName = String(toast.mock.calls[0][0]);
    toast.mockClear();
    const q = renameChannel('ch-1', 'имя');
    reply({ ok: false, error: 'not-owner' });
    await q;
    expect(String(toast.mock.calls[0][0])).not.toBe(badName);
  });
});

describe('срезы для диалогов подтверждения', () => {
  it('канал: цифры приходят как есть, отказ — null', async () => {
    const p = channelStats('ch-1');
    reply({ ok: true, occupants: 2, messages: 17 });
    expect(await p).toEqual({ occupants: 2, messages: 17 });

    const q = channelStats('ch-1');
    reply({ ok: false });
    expect(await q).toBeNull();
  });

  it('сервер: то же самое плюс люди в эфирах', async () => {
    const p = serverStats('srv-1');
    reply({ ok: true, channels: 3, messages: 42, occupants: 1 });
    expect(await p).toEqual({ channels: 3, messages: 42, occupants: 1 });
    expect(await serverStats('')).toBeNull();
  });
});

describe('молчание сервера', () => {
  it('без ответа диалог не висит вечно — через тайм-аут приходит null', async () => {
    const p = ask('channel-delete', { id: 'ch-1' });
    vi.advanceTimersByTime(6000);
    expect(await p).toBeNull();
  });

  it('поздний ответ после тайм-аута ничего не ломает', async () => {
    const p = ask('channel-delete', { id: 'ch-1' });
    vi.advanceTimersByTime(6000);
    expect(await p).toBeNull();
    expect(() => reply({ ok: true })).not.toThrow();
  });

  it('молчание объясняется своим текстом, а не выдумывает причину отказа', async () => {
    const p = deleteChannel('ch-1');
    vi.advanceTimersByTime(6000);
    expect(await p).toBe(false);
    expect(toast).toHaveBeenCalled();
  });
});

describe('смена транспорта канала', () => {
  it('уходит на сервер как есть, пустой id — нет', () => {
    setChannelMode('ch-1', 'sfu');
    expect(emit).toHaveBeenCalledWith('channel-mode', { id: 'ch-1', mode: 'sfu' });
    emit.mockClear();
    setChannelMode('', 'p2p');
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('создание сервера', () => {
  it('имя обрезается, пустой пароль не превращается в закрытый сервер', () => {
    createServer({ id: 'srv-2', name: '  и'.repeat(40), password: '' });
    expect(emit.mock.calls[0][1]).toMatchObject({ id: 'srv-2', password: undefined });
    expect((emit.mock.calls[0][1] as { name: string }).name.length).toBeLessThanOrEqual(32);
  });

  it('без id или имени не отправляется', () => {
    createServer({ id: '', name: 'мой' });
    createServer({ id: 'srv-2', name: '   ' });
    expect(emit).not.toHaveBeenCalled();
  });

  it('отказ удаления сервера объясняется своими словами', async () => {
    const texts = new Set<string>();
    for (const error of ['not-owner', 'occupied', 'forbidden', 'not-found']) {
      toast.mockClear();
      const p = deleteServer('srv-1');
      reply({ ok: false, error });
      await p;
      texts.add(String(toast.mock.calls[0][0]));
    }
    expect(texts.size).toBe(4);
    expect(await deleteServer('')).toBe(false);
  });
});

describe('пароли закрытых серверов', () => {
  it('запоминаются, перечисляются и забываются', () => {
    rememberServerPassword('srv-1', 'пароль-1');
    rememberServerPassword('srv-2', 'пароль-2');
    expect(storedServerPasswords().sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'srv-1', password: 'пароль-1' },
      { id: 'srv-2', password: 'пароль-2' },
    ]);
    forgetServerPassword('srv-1');
    expect(storedServerPasswords()).toEqual([{ id: 'srv-2', password: 'пароль-2' }]);
  });

  it('чужие ключи localStorage в список не попадают', () => {
    localStorage.setItem('relay-theme', 'light');
    localStorage.setItem('relay-hosts', '[]');
    rememberServerPassword('srv-1', 'пароль');
    expect(storedServerPasswords()).toEqual([{ id: 'srv-1', password: 'пароль' }]);
  });

  it('разблокировка запоминает пароль оптимистично и шлёт его серверу', () => {
    unlockServer('srv-1', 'пароль');
    expect(localStorage.getItem('relay-server-pw:srv-1')).toBe('пароль');
    expect(emit).toHaveBeenCalledWith('server-unlock', { id: 'srv-1', password: 'пароль' });
    emit.mockClear();
    unlockServer('', 'пароль');
    expect(emit).not.toHaveBeenCalled();
  });

  it('недоступное хранилище не роняет разблокировку', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('приватный режим');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('приватный режим');
    });
    expect(() => unlockServer('srv-1', 'пароль')).not.toThrow();
    expect(() => forgetServerPassword('srv-1')).not.toThrow();
    expect(emit).toHaveBeenCalled();
  });

  it('нечитаемое хранилище даёт пустой список, а не исключение на connect', () => {
    vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
      throw new Error('приватный режим');
    });
    expect(storedServerPasswords()).toEqual([]);
  });
});
