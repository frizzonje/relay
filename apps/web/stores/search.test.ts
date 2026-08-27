// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSearchResult, ChatWindowResult, SearchHit } from '@relay/shared';

/**
 * Поиск как последовательность запросов, а не как один вызов.
 *
 * Человек печатает быстрее, чем сервер отвечает, уходит в другой канал, не
 * дождавшись ответа, и открывает то, что за это время удалили. Проверяется
 * здесь именно это — что показанное всегда отвечает последнему заданному
 * вопросу, а не тому, чей ответ приехал последним.
 */

const answers = vi.hoisted(() => ({ queue: [] as unknown[] }));
vi.mock('@/lib/channels', () => ({
  ask: vi.fn(async () => answers.queue.shift() ?? null),
}));
const toasts = vi.hoisted(() => ({ shown: [] as string[] }));
vi.mock('sonner', () => ({ toast: (text: string) => toasts.shown.push(text) }));

import { useChannelsStore } from './channels';
import { useDmStore } from './dm';
import { useChatStore } from './chat';
import { useSearchStore } from './search';
import { useUiStore } from './ui';

function hit(id: string, slug = 'obshchii'): SearchHit {
  return { slug, message: { id, name: 'A', text: 'дача', ts: 1 } };
}

function found(hits: SearchHit[], more = false): ChatSearchResult {
  return { ok: true, hits, more, terms: ['дача'] };
}

beforeEach(() => {
  answers.queue = [];
  toasts.shown = [];
  useSearchStore.setState({
    open: false,
    query: '',
    scope: 'channel',
    terms: [],
    hits: [],
    more: false,
    loading: false,
    asked: false,
    failed: false,
  });
  useChatStore.getState().reset();
  useDmStore.setState({ conversations: [] });
  useChannelsStore.setState({
    channels: [
      { id: 'c0', serverId: 's', type: 'text', name: 'общий', slug: 'obshchii', removable: false },
    ],
  });
  useUiStore.setState({ textRoom: 'obshchii', textLabel: 'общий', view: 'text' });
});

describe('запрос и ответ', () => {
  it('находки и слова подсветки приходят вместе', async () => {
    answers.queue = [found([hit('1')], true)];
    useSearchStore.getState().setQuery('дача');
    await useSearchStore.getState().run();

    const s = useSearchStore.getState();
    expect(s.hits).toHaveLength(1);
    expect(s.terms).toEqual(['дача']);
    expect([s.more, s.asked, s.loading]).toEqual([true, true, false]);
  });

  it('ответ на обогнанный запрос не показывается', async () => {
    answers.queue = [found([hit('старое')]), found([hit('новое')])];
    useSearchStore.getState().setQuery('да');
    const first = useSearchStore.getState().run();
    useSearchStore.getState().setQuery('дача');
    const second = useSearchStore.getState().run();
    await Promise.all([first, second]);

    // Иначе на экране оседал бы результат по половине слова — тот, что
    // отправляли раньше, а получили позже.
    expect(useSearchStore.getState().hits.map((h) => h.message.id)).toEqual(['новое']);
  });

  it('пустое поле гасит и результаты — вопроса больше нет', async () => {
    answers.queue = [found([hit('1')])];
    useSearchStore.getState().setQuery('дача');
    await useSearchStore.getState().run();

    useSearchStore.getState().setQuery('   ');
    await useSearchStore.getState().run();
    const s = useSearchStore.getState();
    expect([s.hits, s.asked]).toEqual([[], false]);
  });

  it('молчание сервера — не «ничего не нашлось»', async () => {
    answers.queue = [null];
    useSearchStore.getState().setQuery('дача');
    await useSearchStore.getState().run();
    expect(useSearchStore.getState().failed).toBe(true);
  });

  it('«ещё» дописывает к показанному, а не заменяет его', async () => {
    answers.queue = [found([hit('1')], true), found([hit('2')], false)];
    useSearchStore.getState().setQuery('дача');
    await useSearchStore.getState().run();
    await useSearchStore.getState().loadMore();

    const s = useSearchStore.getState();
    expect(s.hits.map((h) => h.message.id)).toEqual(['1', '2']);
    expect(s.more).toBe(false);
  });
});

describe('переход к найденному', () => {
  const window_ = (ids: string[]): ChatWindowResult => ({
    ok: true,
    messages: ids.map((id) => ({ id, name: 'A', text: 'дача', ts: 1 })),
    more: true,
    moreAfter: true,
  });

  it('открывает канал находки и ставит ленту в её окружение', async () => {
    useChannelsStore.setState({
      channels: [
        { id: 'c1', serverId: 's', type: 'text', name: 'кухня', slug: 'kuhnya', removable: true },
      ],
    });
    answers.queue = [window_(['до', 'оно', 'после'])];

    await useSearchStore.getState().openHit(hit('оно', 'kuhnya'));

    expect(useUiStore.getState().textRoom).toBe('kuhnya');
    const chat = useChatStore.getState();
    expect(chat.messages.map((m) => m.id)).toEqual(['до', 'оно', 'после']);
    expect([chat.moreAfter, chat.jump]).toEqual([true, 'оно']);
  });

  it('удалённое сообщение объясняют, а не подсовывают конец канала', async () => {
    answers.queue = [{ ok: true, messages: [], more: false, moreAfter: false }];
    await useSearchStore.getState().openHit(hit('пропало'));

    expect(useChatStore.getState().messages).toEqual([]);
    expect(toasts.shown).toHaveLength(1);
  });

  it('находка из беседы ведёт в беседу, а не молчит', async () => {
    // Адреса беседы в реестре каналов нет и не будет — это критерий приёмки
    // плана ЛС, а не случайность. Пока переход искал место находки только там,
    // клик по находке в переписке не делал ровно ничего.
    const slug = 'dm-0123456789abcdef01234567';
    useDmStore.setState({
      conversations: [
        {
          slug,
          peer: { fingerprint: '6668-7aad-f862-bd77', nick: 'Марта' },
          lastTs: 1,
          preview: 'дача',
          previewMine: false,
        },
      ],
    });
    answers.queue = [window_(['до', 'оно', 'после'])];

    await useSearchStore.getState().openHit(hit('оно', slug));

    const ui = useUiStore.getState();
    expect([ui.view, ui.dmRoom, ui.textRoom]).toEqual(['dm', slug, null]);
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['до', 'оно', 'после']);
    expect(useChatStore.getState().jump).toBe('оно');
  });

  it('беседы уже нет в списке — никуда не идём', async () => {
    useDmStore.setState({ conversations: [] });
    await useSearchStore.getState().openHit(hit('1', 'dm-0123456789abcdef01234567'));
    expect(useUiStore.getState().textRoom).toBe('obshchii');
  });

  it('канала уже нет — никуда не идём', async () => {
    useChannelsStore.setState({ channels: [] });
    await useSearchStore.getState().openHit(hit('1', 'снесённый'));
    expect(useUiStore.getState().textRoom).toBe('obshchii');
  });
});
