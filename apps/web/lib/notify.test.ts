// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Уведомление о входящем. У звука проверяем два правила, из-за которых он либо
 * не нужен, либо невыносим: канал звенит, только если его включили поимённо, и
 * подряд идущие реплики стоят одного сигнала, а не очереди. У вспышки —
 * обратное: она не спрашивает разрешения и считает каждое сообщение.
 */

const play = vi.fn();
vi.mock('@/lib/sfx', () => ({ getSfx: () => ({ play }) }));

/**
 * Свежая пара «модуль звука + стор». Модуль помнит время прошлого тика в
 * замыкании, сбросить это можно только вместе с самим модулем — а раз реестр
 * сброшен, то и стор надо брать оттуда же, иначе они окажутся разными.
 */
async function boot() {
  vi.resetModules();
  const { useNotifyStore } = await import('@/stores/notify');
  const { notifyMessage, notifyMention, notifySent, previewMessageSound } =
    await import('./notify');
  return { useNotifyStore, notifyMessage, notifyMention, notifySent, previewMessageSound };
}

beforeEach(() => {
  play.mockClear();
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('звук входящего сообщения', () => {
  it('молчит, пока каналу не разрешили звук', async () => {
    const { useNotifyStore, notifyMessage } = await boot();
    notifyMessage('obshchii');
    expect(play).not.toHaveBeenCalled();

    useNotifyStore.getState().toggleChannel('obshchii');
    notifyMessage('obshchii');
    expect(play).toHaveBeenCalledWith('receive');
  });

  it('чужой канал не звенит за компанию', async () => {
    const { useNotifyStore, notifyMessage } = await boot();
    useNotifyStore.getState().toggleChannel('obshchii');
    notifyMessage('flud');
    notifyMessage('');
    expect(play).not.toHaveBeenCalled();
  });

  it('очередь реплик стоит одного тика, пока не выйдет пауза', async () => {
    const { useNotifyStore, notifyMessage } = await boot();
    useNotifyStore.getState().toggleChannel('obshchii');

    notifyMessage('obshchii');
    notifyMessage('obshchii');
    notifyMessage('obshchii');
    expect(play).toHaveBeenCalledTimes(1);

    vi.setSystemTime(2000);
    notifyMessage('obshchii');
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('проба при включении звучит мимо канала и паузы', async () => {
    const { useNotifyStore, notifyMessage, previewMessageSound } = await boot();
    useNotifyStore.getState().toggleChannel('obshchii');
    notifyMessage('obshchii');
    previewMessageSound();
    expect(play).toHaveBeenCalledTimes(2);
  });
});

describe('вспышка в сайдбаре', () => {
  it('идёт в заглушённом канале — молчит звук, а не строка', async () => {
    const { useNotifyStore, notifyMessage } = await boot();
    notifyMessage('flud');
    expect(useNotifyStore.getState().pings.flud).toBe(1);
    expect(play).not.toHaveBeenCalled();
  });

  it('считает каждое сообщение, а не серию: паузы звука на ней нет', async () => {
    const { useNotifyStore, notifyMessage } = await boot();
    useNotifyStore.getState().toggleChannel('obshchii');
    notifyMessage('obshchii');
    notifyMessage('obshchii');
    notifyMessage('obshchii');
    expect(useNotifyStore.getState().pings.obshchii).toBe(3);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('считается по каналам врозь, пустой слаг не в счёт', async () => {
    const { useNotifyStore, notifyMessage } = await boot();
    notifyMessage('obshchii');
    notifyMessage('flud');
    notifyMessage('flud');
    notifyMessage('');
    expect(useNotifyStore.getState().pings).toEqual({ obshchii: 1, flud: 2 });
  });

  it('проба звука строкой не мигает — включили звук, а не получили сообщение', async () => {
    const { useNotifyStore, previewMessageSound } = await boot();
    previewMessageSound();
    expect(useNotifyStore.getState().pings).toEqual({});
  });
});

/**
 * Три чатовых сигнала — разные файлы, и это не косметика: они различаются
 * громкостью (см. заголовок lib/sfx.ts). Перепутать их местами значит либо
 * оглушать человека его же нажатием на Enter, либо утопить обращение по имени
 * в общем шуме. Тест держит именно распределение, а не сам факт звука.
 */
describe('какой из трёх сигналов звучит', () => {
  it('своя отправка — самый тихий, мимо настроек канала', async () => {
    const { notifySent } = await boot();
    // Канал никто не включал: подтверждение своему действию его не спрашивает.
    notifySent();
    expect(play).toHaveBeenCalledWith('send');
  });

  it('обращение по имени звучит громче обычной реплики', async () => {
    const { notifyMention } = await boot();
    notifyMention('obshchii');
    expect(play).toHaveBeenCalledWith('message');
    expect(play).not.toHaveBeenCalledWith('receive');
  });

  it('проба звука канала играет ровно то, что канал и играет', async () => {
    // Иначе настройку проверяли бы одним звуком, а слышали потом другой.
    const { previewMessageSound } = await boot();
    previewMessageSound();
    expect(play).toHaveBeenCalledWith('receive');
  });
});
