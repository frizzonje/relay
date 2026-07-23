import { create } from 'zustand';

/**
 * Непрочитанное по текстовым каналам. Сервер шлёт лёгкий пинг `chat-activity`
 * (слаг + время последнего сообщения, без содержимого) всем клиентам — по нему
 * сайдбар зажигает точку на каналах, которые сейчас не открыты.
 *
 *  • `activity` — время последнего сообщения в канале. Живёт только в сессии:
 *    на свежей загрузке пусто, поэтому «непрочитано» не загорается на всём
 *    подряд — только на том, что реально пришло, пока ты сидишь в приложении.
 *  • `lastRead` — до какого времени ты канал дочитал. Переживает перезагрузку
 *    (localStorage), чтобы разделитель «новые сообщения» встал там, где бросил.
 *
 * Канал не прочитан, когда activity[slug] > lastRead[slug].
 */
const LAST_READ_KEY = 'relay-chat-read';

function loadLastRead(): Record<string, number> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const parsed = JSON.parse(localStorage.getItem(LAST_READ_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveLastRead(map: Record<string, number>) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(LAST_READ_KEY, JSON.stringify(map));
  } catch {
    // приватный режим/квота — переживём, разделитель просто не запомнится
  }
}

interface UnreadState {
  activity: Record<string, number>;
  lastRead: Record<string, number>;
  /** Пришёл пинг активности канала. */
  noteActivity: (slug: string, ts: number) => void;
  /** Отметить канал прочитанным до времени ts (не двигаем назад). */
  markRead: (slug: string, ts: number) => void;
  /** Время, до которого канал был прочитан (для разделителя «новые»). */
  readMark: (slug: string) => number;
}

export const useUnreadStore = create<UnreadState>((set, get) => ({
  activity: {},
  lastRead: loadLastRead(),
  noteActivity: (slug, ts) =>
    set((s) => {
      if ((s.activity[slug] ?? 0) >= ts) return s;
      return { activity: { ...s.activity, [slug]: ts } };
    }),
  markRead: (slug, ts) =>
    set((s) => {
      if ((s.lastRead[slug] ?? 0) >= ts) return s;
      const lastRead = { ...s.lastRead, [slug]: ts };
      saveLastRead(lastRead);
      return { lastRead };
    }),
  readMark: (slug) => get().lastRead[slug] ?? 0,
}));

/** Канал не прочитан: активность новее отметки чтения. Селектор для сайдбара. */
export function isChannelUnread(s: UnreadState, slug: string): boolean {
  return (s.activity[slug] ?? 0) > (s.lastRead[slug] ?? 0);
}
