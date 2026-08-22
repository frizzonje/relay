import { create } from 'zustand';
import { toast } from 'sonner';
import type { ChatSearchResult, ChatWindowResult, SearchHit, SearchScope } from '@relay/shared';
import { ask } from '@/lib/channels';
import { tx } from '@/lib/i18n';
import { useChannelsStore } from '@/stores/channels';
import { useChatStore } from '@/stores/chat';
import { targetRoom, useUiStore } from '@/stores/ui';

/**
 * Поиск по истории: что спросили, что нашлось и куда после этого попадают.
 *
 * Найденное — не отдельный экран сам по себе, а дорога обратно в разговор:
 * человек ищет не строку, а место, где это говорили. Поэтому у стора две
 * половины — результаты и переход, и вторая важнее первой.
 */

interface SearchState {
  open: boolean;
  query: string;
  scope: SearchScope;
  /**
   * Слова, по которым нашлось показанное, — с сервера. Не то же самое, что
   * набранное в поле прямо сейчас: подсвечивать надо по тому, что искали, а не
   * по тому, что успели дописать.
   */
  terms: string[];
  hits: SearchHit[];
  more: boolean;
  loading: boolean;
  /** Спрашивали ли уже: иначе пустой список неотличим от «ещё не искали». */
  asked: boolean;
  /** Ответа не дождались. Это не «ничего не нашлось», и говорить надо разное. */
  failed: boolean;
  setOpen: (open: boolean) => void;
  setQuery: (query: string) => void;
  setScope: (scope: SearchScope) => void;
  run: () => Promise<void>;
  loadMore: () => Promise<void>;
  /** Открыть найденное в ленте — в его канале и в его окружении. */
  openHit: (hit: SearchHit) => Promise<void>;
}

/**
 * Номер последнего отправленного запроса. Человек печатает быстрее, чем
 * отвечает сервер, и ответы возвращаются не в том порядке, в каком уходили:
 * без этого счётчика на экране оседал бы результат по половине слова.
 */
let seq = 0;

/** Панель на мобиле занимает весь экран — после перехода её надо убрать. */
function narrow(): boolean {
  // Проверка на саму функцию, а не только на `window`: сервер рендера и тесты
  // живут без неё, и падать на ширине экрана посреди перехода — плохой размен.
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(max-width: 767px)').matches;
}

export const useSearchStore = create<SearchState>((set, get) => ({
  open: false,
  query: '',
  scope: 'channel',
  terms: [],
  hits: [],
  more: false,
  loading: false,
  asked: false,
  failed: false,
  setOpen: (open) => set({ open }),
  setQuery: (query) => set({ query }),
  setScope: (scope) => set({ scope }),

  run: async () => {
    const query = get().query.trim();
    if (!query) {
      // Поле опустело — гасим и результаты: показывать находки по стёртому
      // запросу значит отвечать на вопрос, которого больше нет.
      seq += 1;
      set({ hits: [], terms: [], more: false, asked: false, failed: false, loading: false });
      return;
    }
    const mine = (seq += 1);
    set({ loading: true, failed: false });
    const res = await ask<ChatSearchResult>('chat-search', { query, scope: get().scope });
    if (mine !== seq) return;
    set({
      loading: false,
      asked: true,
      failed: !res,
      hits: res?.hits ?? [],
      terms: res?.terms ?? [],
      more: res?.more === true,
    });
  },

  loadMore: async () => {
    const { hits, more, loading, query, scope } = get();
    const last = hits[hits.length - 1]?.message;
    if (!more || loading || !last?.id) return;
    const mine = (seq += 1);
    set({ loading: true });
    const res = await ask<ChatSearchResult>('chat-search', {
      query: query.trim(),
      scope,
      beforeTs: last.ts,
      beforeId: last.id,
    });
    if (mine !== seq) return;
    set({
      loading: false,
      failed: !res,
      hits: res ? [...get().hits, ...res.hits] : get().hits,
      more: res?.more === true,
    });
  },

  openHit: async (hit) => {
    const id = hit.message.id;
    const channel = useChannelsStore
      .getState()
      .channels.find((c) => c.type === 'text' && c.slug === hit.slug);
    if (!id || !channel) return;

    // В свой канал заходим сперва: окно спрашивают у того канала, в котором
    // сокет сидит, а сам вход заодно проверяет права. Вход отложен на время,
    // пока уходит прежняя лента (см. pendingScene), — дожидаемся его, иначе
    // окно спросим у канала, из которого человек уже ушёл.
    if (targetRoom(useUiStore.getState()) !== hit.slug) {
      useUiStore.getState().openText(hit.slug, channel.name);
    }
    await useUiStore.getState().sceneSettled();

    const win = await ask<ChatWindowResult>('chat-around', { id });
    // Пока ждали ответ, человек ушёл в другой канал — чужое окно ему не надо.
    if (useUiStore.getState().textRoom !== hit.slug) return;
    if (!win || !win.messages.length) {
      // Реплику удалили, пока читали результаты. Молча показать конец канала
      // было бы хуже всего: человек решил бы, что промахнулся сам.
      toast(tx('search.gone'));
      return;
    }
    useChatStore.getState().setWindow(win.messages, win.more, win.moreAfter);
    useChatStore.getState().setJump(id);
    if (narrow()) set({ open: false });
  },
}));
