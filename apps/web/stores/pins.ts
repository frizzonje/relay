import { create } from 'zustand';
import { toast } from 'sonner';
import {
  PIN_LIMIT,
  type ChatMessage,
  type ChatPinResult,
  type ChatPinsResult,
  type ChatWindowResult,
} from '@relay/shared';
import { ask } from '@/lib/channels';
import { tx } from '@/lib/i18n';
import { useChatStore } from '@/stores/chat';
import { useSearchStore } from '@/stores/search';
import { useUiStore } from '@/stores/ui';

/**
 * Закреплённое открытого канала.
 *
 * Число и список живут врозь, и это не мелочь. Число приезжает вместе со
 * страницей истории — шапке оно нужно всегда и стоит одного счёта в базе.
 * Список спрашивается, когда его открывают: закреплённых бывает полсотни, и
 * возить их каждому входящему ради панели, которую откроют однажды, — плата за
 * то, чего никто не просил.
 *
 * Закрепляет модератор сервера, а видят все: это шапка канала, а не пометка
 * для себя.
 */

interface PinsState {
  /** Сколько закреплено в открытом канале — то, что показывает шапка. */
  count: number;
  /** Панель открыта. Список подтягивается на открытие, а не заранее. */
  open: boolean;
  list: ChatMessage[];
  loading: boolean;
  /** Спрашивали ли: иначе пустой список неотличим от «ещё не спросили». */
  asked: boolean;
  /** Ответа не дождались — это не «ничего не закреплено», и говорить надо разное. */
  failed: boolean;
  setOpen: (open: boolean) => void;
  setCount: (count: number) => void;
  /** Смена канала: чужие закрепления в открытом канале — чужая шапка. */
  reset: () => void;
  /**
   * Вошли в другой канал. Панель при этом не закрывается — её открывали, чтобы
   * смотреть закреплённое, и закрывать её за человека при каждом переходе
   * значило бы решать за него, что он передумал.
   */
  enterChannel: () => void;
  load: () => Promise<void>;
  /** Закрепить или открепить. `false` — сервер отказал, причину человек увидел. */
  toggle: (id: string, on: boolean) => Promise<boolean>;
  /** Пришло `chat-pinned`: пометка в ленте, число в шапке и открытый список. */
  applyPinned: (id: string, pinned: boolean, count: number) => void;
  /** Показать закреплённое в ленте — там, где оно было сказано. */
  openPin: (id: string) => Promise<void>;
}

/** Панель на мобиле занимает весь экран — после перехода её надо убрать. */
function narrow(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(max-width: 767px)').matches;
}

/**
 * Номер последнего запроса списка: панель успевают закрыть и открыть снова, и
 * ответ на прошлый вопрос не должен осесть поверх свежего.
 */
let seq = 0;

export const usePinsStore = create<PinsState>((set, get) => ({
  count: 0,
  open: false,
  list: [],
  loading: false,
  asked: false,
  failed: false,

  setOpen: (open) => {
    // Поиск и закреплённые занимают одно место у правого края ленты. Открыть
    // второе поверх первого — значит спрятать под ним то, что человек читал.
    if (open) useSearchStore.getState().setOpen(false);
    set({ open });
    if (open) void get().load();
  },

  setCount: (count) => set({ count }),

  reset: () =>
    set({ count: 0, open: false, list: [], loading: false, asked: false, failed: false }),

  enterChannel: () => {
    set({ count: 0, list: [], asked: false, failed: false });
    if (get().open) void get().load();
  },

  load: async () => {
    const slug = useUiStore.getState().textRoom;
    if (!slug) return;
    const mine = (seq += 1);
    set({ loading: true, failed: false });
    const res = await ask<ChatPinsResult>('chat-pins', { slug });
    if (mine !== seq) return;
    // Список чужого канала сервер и не пришлёт — он сверяет слаг, — но пока
    // ответ шёл, человек мог уйти: тогда он уже не про то, что на экране.
    if (useUiStore.getState().textRoom !== slug) return;
    const ok = res?.ok === true;
    set({
      loading: false,
      asked: true,
      failed: !ok,
      list: ok ? res.pins : [],
      // Число берём из того же ответа: список и счётчик, разъехавшиеся на
      // единицу, — это ровно тот случай, когда не верят обоим.
      ...(ok ? { count: res.pins.length } : {}),
    });
  },

  toggle: async (id, on) => {
    const res = await ask<ChatPinResult>('chat-pin', { id, on });
    if (res?.ok) return true;
    // Потолок — единственный отказ, с которым человеку есть что делать:
    // открепить лишнее. Остальные значат «реплики уже нет» или «канал не твой»,
    // и разбирать их по отдельности незачем.
    toast(
      res?.ok === false && res.error === 'limit'
        ? tx('pins.limit', { count: PIN_LIMIT })
        : tx('pins.failed'),
    );
    return false;
  },

  applyPinned: (id, pinned, count) => {
    useChatStore.getState().applyPinned(id, pinned);
    set({ count });
    // Открытый список перечитываем у сервера, а не досочиняем из ленты:
    // закрепить могли то, чего в подгруженном куске нет вовсе, а порядок в
    // списке — по времени закрепления, которого клиент не знает.
    if (get().open) void get().load();
  },

  openPin: async (id) => {
    // Реплика уже в ленте — просто ведём к ней. Спрашивать у сервера окно
    // вокруг того, что и так на экране, значило бы перекладывать ленту под
    // человеком ради перехода на два экрана вверх.
    if (useChatStore.getState().messages.some((m) => m.id === id)) {
      useChatStore.getState().setJump(id);
      if (narrow()) set({ open: false });
      return;
    }
    const slug = useUiStore.getState().textRoom;
    const win = await ask<ChatWindowResult>('chat-around', { id });
    if (useUiStore.getState().textRoom !== slug) return;
    if (!win || !win.messages.length) {
      // Реплику удалили, пока панель была открыта. Молча показать конец канала
      // хуже всего: человек решил бы, что промахнулся сам.
      toast(tx('pins.gone'));
      return;
    }
    useChatStore.getState().setWindow(win.messages, win.more, win.moreAfter);
    useChatStore.getState().setJump(id);
    if (narrow()) set({ open: false });
  },
}));
