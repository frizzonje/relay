import { create } from 'zustand';

/**
 * Уведомления о входящих сообщениях: звук и вспышка в сайдбаре.
 *
 * Звук — по текстовым каналам, поштучно.
 *
 * Хранится не «кого заглушили», а наоборот: список каналов, которым звук
 * РАЗРЕШЁН. Молчание — состояние по умолчанию, и оно должно оставаться таковым
 * для всего, о чём мы ещё не слышали: свежесозданного канала, канала на чужом
 * хосте, канала, появившегося после обновления клиента. Список «заглушённых» дал
 * бы обратное — каждый новый канал начинал бы звенеть сам собой.
 *
 * Выбор живёт в localStorage (`relay-channel-sound`) и переживает перезагрузку.
 * Ключ — слаг канала: он же приходит в `chat-activity`, по нему считается
 * непрочитанное (stores/unread), и переименование канала звук не сбрасывает.
 *
 * Вспышка (`pings`) настройки не имеет и заглушке не подчиняется: она беззвучна,
 * ничего не перебивает и нужна ровно там, куда ты сейчас не смотришь. Заглушить
 * можно звук, не глаза. Счётчик не сохраняется — это событие, а не выбор.
 */
export const CHANNEL_SOUND_KEY = 'relay-channel-sound';

function load(): string[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const parsed = JSON.parse(localStorage.getItem(CHANNEL_SOUND_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function save(slugs: string[]) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(CHANNEL_SOUND_KEY, JSON.stringify(slugs));
  } catch {
    // приватный режим/квота — переживём, выбор просто не запомнится
  }
}

interface NotifyState {
  /** Слаги каналов, которым разрешён звук. Всё остальное молчит. */
  loud: string[];
  /**
   * Сколько раз в канал приходило новое с начала сеанса. Значение само по себе
   * ничего не значит — важно, что оно изменилось: по этому сайдбар проигрывает
   * вспышку. Считаем именно события, а не время последнего сообщения: две
   * реплики подряд должны дать две вспышки.
   */
  pings: Record<string, number>;
  /** Включить/выключить звук канала. Возвращает новое состояние канала. */
  toggleChannel: (slug: string) => boolean;
  /** В канал пришло новое сообщение — мигнуть строкой. */
  notePing: (slug: string) => void;
}

export const useNotifyStore = create<NotifyState>((set, get) => ({
  loud: load(),
  pings: {},
  toggleChannel: (slug) => {
    if (!slug) return false;
    const on = !get().loud.includes(slug);
    const loud = on ? [...get().loud, slug] : get().loud.filter((s) => s !== slug);
    save(loud);
    set({ loud });
    return on;
  },
  notePing: (slug) =>
    set((s) => (slug ? { pings: { ...s.pings, [slug]: (s.pings[slug] ?? 0) + 1 } } : s)),
}));

/** Разрешён ли звук этому каналу. Селектор для сайдбара и меню канала. */
export function isChannelLoud(s: NotifyState, slug: string): boolean {
  return s.loud.includes(slug);
}
