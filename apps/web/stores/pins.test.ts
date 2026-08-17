// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatPinResult, ChatPinsResult, ChatWindowResult } from '@relay/shared';

/**
 * Закреплённое: число в шапке, список по запросу и переход к самой реплике.
 *
 * Проверяется не «дошло ли событие», а то, что видит человек: пометка в ленте
 * появляется от сервера, а не от нажатия; отказ по потолку он читает словами;
 * список чужого канала не оседает в открытом.
 */

const answers = vi.hoisted(() => ({ queue: [] as unknown[] }));
vi.mock('@/lib/channels', () => ({
  ask: vi.fn(async () => answers.queue.shift() ?? null),
}));
const toasts = vi.hoisted(() => ({ shown: [] as string[] }));
vi.mock('sonner', () => ({ toast: (text: string) => toasts.shown.push(text) }));

import { useChatStore } from './chat';
import { usePinsStore } from './pins';
import { useSearchStore } from './search';
import { useUiStore } from './ui';

function msg(id: string, text = 'важное'): ChatMessage {
  return { id, name: 'А', text, ts: 1 };
}

function pins(list: ChatMessage[], slug = 'obshchii'): ChatPinsResult {
  return { ok: true, slug, pins: list };
}

beforeEach(() => {
  answers.queue = [];
  toasts.shown = [];
  usePinsStore.getState().reset();
  useChatStore.getState().reset();
  useSearchStore.setState({ open: false });
  useUiStore.setState({ textRoom: 'obshchii', textLabel: 'общий', view: 'text' });
});

describe('список закреплённого', () => {
  it('спрашивается на открытие панели, а не заранее', async () => {
    answers.queue = [pins([msg('1')])];
    usePinsStore.getState().setOpen(true);
    await vi.waitFor(() => expect(usePinsStore.getState().asked).toBe(true));

    const s = usePinsStore.getState();
    expect(s.list.map((m) => m.id)).toEqual(['1']);
    // Число берётся из того же ответа: список и счётчик, разъехавшиеся на
    // единицу, — это когда не верят обоим.
    expect(s.count).toBe(1);
  });

  it('открытые закреплённые закрывают поиск: место у них одно', async () => {
    useSearchStore.setState({ open: true });
    answers.queue = [pins([])];
    usePinsStore.getState().setOpen(true);
    expect(useSearchStore.getState().open).toBe(false);
  });

  it('молчание сервера — не «ничего не закреплено»', async () => {
    answers.queue = [null];
    await usePinsStore.getState().load();
    const s = usePinsStore.getState();
    expect([s.failed, s.asked, s.list]).toEqual([true, true, []]);
  });

  it('ответ на обогнанный запрос не оседает поверх свежего', async () => {
    answers.queue = [pins([msg('старое')]), pins([msg('свежее')])];
    const first = usePinsStore.getState().load();
    const second = usePinsStore.getState().load();
    await Promise.all([first, second]);
    expect(usePinsStore.getState().list.map((m) => m.id)).toEqual(['свежее']);
  });

  it('ушли из канала, пока шёл ответ, — список не показываем', async () => {
    answers.queue = [pins([msg('1')])];
    const pending = usePinsStore.getState().load();
    useUiStore.setState({ textRoom: 'kuhnya' });
    await pending;
    expect(usePinsStore.getState().list).toEqual([]);
  });

  it('смена канала гасит и число, и список', async () => {
    usePinsStore.setState({ count: 3, list: [msg('1')], asked: true });
    usePinsStore.getState().enterChannel();
    const s = usePinsStore.getState();
    expect([s.count, s.list, s.asked]).toEqual([0, [], false]);
  });
});

describe('закрепить и открепить', () => {
  it('нажатие ленту не трогает — пометку ставит сервер', async () => {
    useChatStore.getState().setHistory([msg('1')], false);
    answers.queue = [{ ok: true, pinned: true, count: 1 } satisfies ChatPinResult];

    expect(await usePinsStore.getState().toggle('1', true)).toBe(true);
    // Своё нарисованное «закреплено» показало бы закреплённым и то, что
    // сервер мог не принять, — например когда канал уже полон.
    expect(useChatStore.getState().messages[0].pinned).toBeUndefined();

    usePinsStore.getState().applyPinned('1', true, 1);
    expect(useChatStore.getState().messages[0].pinned).toBe(true);
    expect(usePinsStore.getState().count).toBe(1);
  });

  it('открепление снимает пометку целиком, а не выключает её', async () => {
    useChatStore.getState().setHistory([{ ...msg('1'), pinned: true }], false);
    usePinsStore.getState().applyPinned('1', false, 0);
    expect('pinned' in useChatStore.getState().messages[0]).toBe(false);
  });

  it('потолок объясняют словами, а не молчанием', async () => {
    answers.queue = [{ ok: false, error: 'limit' } satisfies ChatPinResult];
    expect(await usePinsStore.getState().toggle('1', true)).toBe(false);
    expect(toasts.shown).toHaveLength(1);
    expect(toasts.shown[0]).toMatch(/50/);
  });

  it('прочие отказы тоже не проглатываются', async () => {
    answers.queue = [{ ok: false, error: 'forbidden' } satisfies ChatPinResult, null];
    expect(await usePinsStore.getState().toggle('1', true)).toBe(false);
    expect(await usePinsStore.getState().toggle('1', false)).toBe(false);
    expect(toasts.shown).toHaveLength(2);
  });
});

describe('переход к закреплённому', () => {
  it('реплика уже в ленте — просто ведём к ней, не дёргая сервер', async () => {
    useChatStore.getState().setHistory([msg('1'), msg('2')], false);
    await usePinsStore.getState().openPin('2');

    expect(useChatStore.getState().jump).toBe('2');
    // Окно вокруг того, что и так на экране, перекладывало бы ленту под руками.
    expect(answers.queue).toHaveLength(0);
  });

  it('реплика выше подгруженного — открываем её окружение', async () => {
    useChatStore.getState().setHistory([msg('свежее')], false);
    answers.queue = [
      {
        ok: true,
        messages: [msg('до'), msg('оно'), msg('после')],
        more: true,
        moreAfter: true,
      } satisfies ChatWindowResult,
    ];

    await usePinsStore.getState().openPin('оно');
    const chat = useChatStore.getState();
    expect(chat.messages.map((m) => m.id)).toEqual(['до', 'оно', 'после']);
    expect([chat.moreAfter, chat.jump]).toEqual([true, 'оно']);
  });

  it('закреплённое удалили — объясняем, а не показываем конец канала', async () => {
    answers.queue = [{ ok: true, messages: [], more: false, moreAfter: false }];
    await usePinsStore.getState().openPin('пропало');
    expect(useChatStore.getState().messages).toEqual([]);
    expect(toasts.shown).toHaveLength(1);
  });
});
