import { create } from 'zustand';

/**
 * Горячие клавиши голосового канала. По умолчанию НИЧЕГО не назначено —
 * действия срабатывают, только если пользователь сам задал им клавишу в
 * настройках (и только пока он в голосовом канале). Пустая привязка = действие
 * выключено. Раскладку-независимо храним `event.code` (см. lib/hotkeys).
 */
export type HotkeyAction = 'muteMic' | 'deafen' | 'leaveVoice';

export const HOTKEY_ACTIONS: { id: HotkeyAction; label: string; hint: string }[] = [
  { id: 'muteMic', label: 'Выключить микрофон', hint: 'Мут и анмут своего микрофона.' },
  {
    id: 'deafen',
    label: 'Выключить звук',
    hint: 'Заглушить весь звук канала (микрофон выключится тоже).',
  },
  { id: 'leaveVoice', label: 'Выйти из канала', hint: 'Покинуть текущий голосовой канал.' },
];

type Binds = Partial<Record<HotkeyAction, string>>;
const KEY = 'relay-hotkeys';

function load(): Binds {
  try {
    if (typeof localStorage === 'undefined') return {};
    const parsed = JSON.parse(localStorage.getItem(KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function save(binds: Binds) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(KEY, JSON.stringify(binds));
  } catch {
    // приватный режим/квота — переживём, привязки просто не запомнятся
  }
}

interface HotkeysState {
  binds: Binds;
  /** Назначить (combo) или снять (null) горячую клавишу действию. */
  setBind: (action: HotkeyAction, combo: string | null) => void;
}

export const useHotkeysStore = create<HotkeysState>((set) => ({
  binds: load(),
  setBind: (action, combo) =>
    set((s) => {
      const binds = { ...s.binds };
      // Одна комбинация — одно действие: снимаем её с прочих, чтобы не двоила.
      if (combo) {
        for (const a of Object.keys(binds) as HotkeyAction[]) {
          if (binds[a] === combo) delete binds[a];
        }
        binds[action] = combo;
      } else {
        delete binds[action];
      }
      save(binds);
      return { binds };
    }),
}));
