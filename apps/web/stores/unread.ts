import { create } from 'zustand';

/**
 * Непрочитанное по текстовым каналам.
 *
 *  • `activity` — время последнего сообщения канала. Наполняется живым пингом
 *    `chat-activity` (слаг + время, без содержимого) и снимком `lastTs` из
 *    реестра каналов, который сервер шлёт на connect, — поэтому непрочитанное
 *    переживает перезагрузку страницы, а не начинается каждый раз с чистого листа.
 *  • `lastRead` — до какого времени канал дочитан. Живёт в localStorage и
 *    подхватывается из других вкладок (событие `storage`).
 *  • `divider` — где стояла отметка чтения в момент, когда ты в канал вошёл или
 *    отвернулся от окна. По ней ChatPanel рисует линию «новые»; она НЕ обязана
 *    совпадать с `lastRead`, иначе линия исчезала бы ровно тогда, когда нужна.
 *  • `atBottom` — лента прокручена к низу. Отскроллен вверх — входящие не
 *    считаются прочитанными (см. `watching()` в SocketProvider).
 *
 * Канал не прочитан, когда activity[slug] > lastRead[slug].
 *
 * ВАЖНО: время здесь везде серверное. Отметку чтения ставим не `Date.now()`
 * браузера, а текущей активностью канала (`readNow`) — иначе расхождение часов
 * клиента и сервера ломает индикатор в обе стороны: при отстающих часах точка не
 * гаснет после открытия канала, при спешащих — не загорается вовсе.
 */
export const LAST_READ_KEY = 'relay-chat-read';

type Marks = Record<string, number>;

function parseMarks(raw: string | null): Marks {
  try {
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Marks = {};
    for (const [slug, ts] of Object.entries(parsed)) {
      if (typeof ts === 'number' && Number.isFinite(ts)) out[slug] = ts;
    }
    return out;
  } catch {
    return {};
  }
}

function loadLastRead(): Marks {
  if (typeof localStorage === 'undefined') return {};
  try {
    return parseMarks(localStorage.getItem(LAST_READ_KEY));
  } catch {
    return {};
  }
}

function saveLastRead(map: Marks) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(LAST_READ_KEY, JSON.stringify(map));
  } catch {
    // приватный режим/квота — переживём, отметка просто не запомнится
  }
}

interface UnreadState {
  activity: Marks;
  lastRead: Marks;
  divider: Marks;
  atBottom: boolean;
  /** Пришёл пинг активности канала. */
  noteActivity: (slug: string, ts: number) => void;
  /** Снимок активности из реестра каналов (connect/реконнект). */
  seedActivity: (entries: { slug: string; ts: number }[]) => void;
  /** Дочитать канал до текущей активности — гасит точку. */
  readNow: (slug: string) => void;
  /** Вход в канал: фиксируем линию «новые» на прежней отметке и гасим точку. */
  openChannel: (slug: string) => void;
  /** Отвернулись от канала (свернули окно, ушли в сетку голоса, отскроллили
   *  вверх): линия «новые» встаёт на текущей отметке — всё, что придёт дальше,
   *  окажется под ней. */
  pauseAt: (slug: string) => void;
  setAtBottom: (atBottom: boolean) => void;
  /** Отметки чтения из соседней вкладки (событие `storage`). */
  adoptLastRead: (raw: string | null) => void;
  /** Время, до которого канал был прочитан на момент входа (линия «новые»). */
  dividerAt: (slug: string) => number;
}

export const useUnreadStore = create<UnreadState>((set, get) => ({
  activity: {},
  lastRead: loadLastRead(),
  divider: {},
  atBottom: true,

  noteActivity: (slug, ts) =>
    set((s) => {
      if (!slug || !Number.isFinite(ts) || (s.activity[slug] ?? 0) >= ts) return s;
      return { activity: { ...s.activity, [slug]: ts } };
    }),

  seedActivity: (entries) =>
    set((s) => {
      const activity = { ...s.activity };
      let changed = false;
      for (const { slug, ts } of entries) {
        if (!slug || !Number.isFinite(ts) || (activity[slug] ?? 0) >= ts) continue;
        activity[slug] = ts;
        changed = true;
      }
      return changed ? { activity } : s;
    }),

  readNow: (slug) =>
    set((s) => {
      const seen = s.activity[slug] ?? 0;
      if (!slug || (s.lastRead[slug] ?? 0) >= seen) return s;
      const lastRead = { ...s.lastRead, [slug]: seen };
      saveLastRead(lastRead);
      return { lastRead };
    }),

  openChannel: (slug) =>
    set((s) => {
      if (!slug) return s;
      const mark = s.lastRead[slug] ?? 0;
      const seen = s.activity[slug] ?? 0;
      // Линию «новые» ставим ДО того, как погасим точку, — на прежней отметке.
      const divider = { ...s.divider, [slug]: mark };
      if (mark >= seen) return { divider };
      const lastRead = { ...s.lastRead, [slug]: seen };
      saveLastRead(lastRead);
      return { divider, lastRead };
    }),

  pauseAt: (slug) =>
    set((s) => {
      if (!slug) return s;
      const mark = s.lastRead[slug] ?? 0;
      if ((s.divider[slug] ?? 0) === mark) return s;
      return { divider: { ...s.divider, [slug]: mark } };
    }),

  setAtBottom: (atBottom) => set((s) => (s.atBottom === atBottom ? s : { atBottom })),

  adoptLastRead: (raw) =>
    set((s) => {
      const incoming = parseMarks(raw);
      const lastRead = { ...s.lastRead };
      let changed = false;
      for (const [slug, ts] of Object.entries(incoming)) {
        if ((lastRead[slug] ?? 0) >= ts) continue;
        lastRead[slug] = ts;
        changed = true;
      }
      // Пришло из localStorage — обратно не пишем, иначе вкладки зациклятся.
      return changed ? { lastRead } : s;
    }),

  dividerAt: (slug) => get().divider[slug] ?? 0,
}));

/** Канал не прочитан: активность новее отметки чтения. Селектор для сайдбара. */
export function isChannelUnread(s: UnreadState, slug: string): boolean {
  return (s.activity[slug] ?? 0) > (s.lastRead[slug] ?? 0);
}
