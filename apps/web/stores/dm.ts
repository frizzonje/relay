import { create } from 'zustand';
import { getSocket } from '@/lib/socket';
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
  /** Список спросили и не получили: это НЕ то же самое, что «переписок нет». */
  failed: boolean;
  setConversations: (list: DmConversation[]) => void;
  /**
   * Спросить список у сервера. Живёт в сторе, а не в проводке сокета: список
   * держит он, и переспросить должен уметь не только `connect`, но и сам экран
   * — иначе человеку, у которого список не доехал, нечем повторить.
   */
  reload: () => void;
  /** Пришла реплика: поднять беседу наверх, обновить превью и активность. */
  applyActivity: (relay: DmActivityRelay) => void;
  /** Переписку открыли — добавить, если её ещё нет в списке. */
  remember: (conversation: DmConversation) => void;
  reset: () => void;
}

const initial: Pick<DmState, 'conversations' | 'activity' | 'loading' | 'failed'> = {
  conversations: [],
  activity: {},
  loading: false,
  failed: false,
};

/**
 * Номер последнего запроса списка и срок, после которого ответа уже не ждём.
 * У `socket.emit` с подтверждением своего срока нет вовсе: молчащий сервер
 * оставлял бы экран в «загружаем» навсегда, и это ровно то состояние, в котором
 * список раньше уверенно писал «переписок пока нет».
 */
let listSeq = 0;
const LIST_TIMEOUT_MS = 6000;

/**
 * Через сколько переспросить, если список не доехал, — и сколько раз.
 *
 * Первая неудача не значит ничего. Ответа может не быть по двум причинам, и
 * обе временные: сокет умер на полуслове (у socket.io подтверждение мёртвого
 * сокета не приходит НИКОГДА — повторов у ack нет, и терять его окончательно
 * тут больше некому), либо сервер отказал лимитером — `perimeter.allow` в
 * `dm.handlers` это токен-бакет, и его отказ приезжает тем же `forbidden`, что
 * и настоящий запрет. Отличить их отсюда нельзя, а стоят они разного: на
 * настоящем запрете три лишних вопроса не стоят ничего, на оборванном сокете
 * отсутствие повтора стоит целого раздела.
 *
 * Раздел без списка — это не только пустой список: из него же берутся лица в
 * рейке тулбара. Поэтому одна потерянная реплика протокола гасила ЛС целиком и
 * до конца обрыва — ровно это и видели 8 сентября, пока сокет одного человека
 * пересоздавался трижды за тринадцать минут.
 *
 * Растущие паузы, а не «ещё раз сразу»: сокет, который сейчас переподключается,
 * ответит не раньше, чем поднимется, и три вопроса в одну секунду ему ничем не
 * помогут. Всего на попытки уходит меньше сорока секунд — дальше слово снова у
 * человека («Ещё раз») и у реконнекта, который сам зовёт `reload`.
 */
const LIST_RETRY_DELAYS_MS = [1000, 4000, 10_000];

export const useDmStore = create<DmState>((set, get) => {
  /**
   * Одна попытка спросить список. `tries` — сколько их уже было позади: по нему
   * же берётся пауза до следующей, и он же кончает череду.
   */
  const attempt = (tries: number): void => {
    const mine = (listSeq += 1);
    set({ loading: true, failed: false });
    const giveUp = setTimeout(() => {
      if (mine !== listSeq) return;
      again(mine, tries);
    }, LIST_TIMEOUT_MS);
    getSocket().emit('dm-list', (res) => {
      // Ответ на обогнанный запрос (переподключились, пока ждали) не трогает
      // ничего: свежий уже в пути, и его снимок новее этого.
      if (mine !== listSeq) return;
      clearTimeout(giveUp);
      if (!res.ok) {
        again(mine, tries);
        return;
      }
      set({ loading: false, failed: false });
      get().setConversations(res.conversations);
    });
  };

  /**
   * Неудача: переспросить или наконец признать отказ. `mine` сверяется ещё раз
   * уже перед самой попыткой — за время паузы список могли спросить заново
   * (реконнект, кнопка, раскрытый раздел), и второй вопрос вдогонку первому
   * только гонял бы `loading` туда-сюда.
   */
  const again = (mine: number, tries: number): void => {
    const pause = LIST_RETRY_DELAYS_MS[tries];
    if (pause === undefined) {
      set({ loading: false, failed: true });
      return;
    }
    setTimeout(() => {
      if (mine !== listSeq) return;
      attempt(tries + 1);
    }, pause);
  };

  return {
    ...initial,

    reload: () => attempt(0),

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
        const conversations = [...s.conversations, conversation].sort(
          (a, b) => b.lastTs - a.lastTs,
        );
        return { conversations, activity };
      }),

    // Сброс отменяет и незаконченные повторы: `listSeq` сдвигается, и уже
    // заведённые таймеры узна́ют себя обогнанными. Иначе повтор от прошлой
    // жизни стора дорисовал бы список тому, кто уже вышел.
    reset: () => {
      listSeq += 1;
      set(initial);
    },
  };
});

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
/**
 * Сколько бесед ждут ответа. Тем же сравнением, что `useUnreadIn`, и намеренно
 * без исключения открытой: пока в неё смотрят, отметка чтения едет следом, и
 * непрочитанной она не считается сама собой. Одно понятие о непрочитанном на
 * все четыре места, где оно нарисовано (список, рейка, полоса, бейдж), — иначе
 * они разъезжаются, и человек видит точку там, где счётчик её не считает.
 */
export function useUnreadCount(): number {
  const conversations = useDmStore((s) => s.conversations);
  const activity = useDmStore((s) => s.activity);
  const lastRead = useUnreadStore((s) => s.lastRead);
  return conversations.reduce(
    (n, c) => n + ((activity[c.slug] ?? 0) > (lastRead[c.slug] ?? 0) ? 1 : 0),
    0,
  );
}

export function unreadIn(slug: string): boolean {
  const ts = useDmStore.getState().activity[slug] ?? 0;
  const lastRead = useUnreadStore.getState().lastRead[slug] ?? 0;
  return ts > lastRead;
}
