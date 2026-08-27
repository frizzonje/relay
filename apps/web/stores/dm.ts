import { create } from 'zustand';
import type { DmActivityRelay, DmConversation } from '@relay/shared';
import { useUnreadStore } from './unread';

/**
 * Список переписок (раздел ЛС). Реплики внутри беседы — обычный чат: они идут
 * через `chat-history`/`chat` в useChatStore, этот стор их не хранит. Здесь
 * только то, что нужно списку — с кем беседа, что в ней было последним и когда,
 * — и `activity`, отдельная от `conversations` карта «слаг → время последней
 * реплики»: именно по ней `unreadIn` решает, гасить точку или нет, а сама
 * запись в `conversations` в этот момент может ещё не существовать (см. ниже).
 *
 * Непрочитанное не изобретаем заново: `unreadIn` сверяет свою `activity` с
 * отметками чтения из stores/unread — тем же `lastRead`, что и у текстовых
 * каналов (сервер шлёт их по слагу, не различая канал и ЛС).
 */
interface DmState {
  conversations: DmConversation[];
  /** Непрочитанное по беседам: адрес → время последней реплики. */
  activity: Record<string, number>;
  loading: boolean;
  setConversations: (list: DmConversation[]) => void;
  /** Пришла реплика: поднять беседу наверх, обновить превью и активность. */
  applyActivity: (relay: DmActivityRelay) => void;
  /** Переписку открыли — добавить, если её ещё нет в списке. */
  remember: (conversation: DmConversation) => void;
  setLoading: (value: boolean) => void;
  reset: () => void;
}

const initial: Pick<DmState, 'conversations' | 'activity' | 'loading'> = {
  conversations: [],
  activity: {},
  loading: false,
};

export const useDmStore = create<DmState>((set) => ({
  ...initial,

  // Снимок с сервера (`dm-list`) — заменяем список целиком и следом за ним
  // карту активности: без этого свежий снимок с уже прочитанными беседами
  // выглядел бы непрочитанным до первой живой реплики.
  setConversations: (list) => {
    const activity: Record<string, number> = {};
    for (const c of list) {
      if (c.lastTs) activity[c.slug] = c.lastTs;
    }
    set({ conversations: [...list].sort((a, b) => b.lastTs - a.lastTs), activity });
  },

  applyActivity: (relay) =>
    set((s) => {
      const known = s.activity[relay.slug] ?? 0;
      if (relay.ts <= known) return s;
      const updated: DmConversation = {
        slug: relay.slug,
        peer: relay.peer,
        lastTs: relay.ts,
        preview: relay.preview,
        previewMine: relay.previewMine,
      };
      const rest = s.conversations.filter((c) => c.slug !== relay.slug);
      return {
        activity: { ...s.activity, [relay.slug]: relay.ts },
        conversations: [updated, ...rest],
      };
    }),

  remember: (conversation) =>
    set((s) => {
      if (s.conversations.some((c) => c.slug === conversation.slug)) return s;
      // Открытая беседа не всегда пуста — за ней может стоять история с уже
      // ненулевым `lastTs` (переоткрыли со свежего устройства, список
      // подчистили). Не сидируя activity тем же способом, что и
      // setConversations, unreadIn молчал бы про непрочитанное до первой живой
      // реплики — тот самый лживый бейдж, ради которого стор и завели.
      const activity = conversation.lastTs
        ? { ...s.activity, [conversation.slug]: conversation.lastTs }
        : s.activity;
      // Сортируем по месту, а не кладём наверх: список уже упорядочен по
      // lastTs (setConversations/applyActivity держат это), и переписка без
      // свежей активности не должна перепрыгивать более новые беседы.
      const conversations = [...s.conversations, conversation].sort((a, b) => b.lastTs - a.lastTs);
      return { conversations, activity };
    }),

  setLoading: (value) => set({ loading: value }),

  reset: () => set(initial),
}));

/**
 * То же, что `unreadIn`, но подпиской на оба стора — для разметки.
 *
 * Разовое чтение `getState()` не перерисовало бы ни строку списка, ни лицо в
 * рейке ни на входящую реплику, ни на отметку чтения. Открытая беседа
 * непрочитанной не считается: точка гаснет сразу, не дожидаясь, пока сервер
 * подтвердит отметку.
 */
export function useUnreadIn(slug: string, active = false): boolean {
  const activityTs = useDmStore((s) => s.activity[slug] ?? 0);
  const lastRead = useUnreadStore((s) => s.lastRead[slug] ?? 0);
  return !active && activityTs > lastRead;
}

/** Есть ли непрочитанное в этой беседе (сверяется с отметками чтения). */
export function unreadIn(slug: string): boolean {
  const ts = useDmStore.getState().activity[slug] ?? 0;
  const lastRead = useUnreadStore.getState().lastRead[slug] ?? 0;
  return ts > lastRead;
}
