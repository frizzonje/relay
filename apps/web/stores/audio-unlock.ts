import { create } from 'zustand';

/**
 * Разблокировка автоплей-звука. Браузер может заблокировать воспроизведение
 * медиа до первого пользовательского жеста — тогда видео/аудио собеседников
 * остаётся в тишине. Плитка видео (VideoTile) при заблокированном автоплее
 * зовёт `show()`, кнопка (components/layout/AudioUnlock) по клику возобновляет
 * воспроизведение и AudioContext микшера, затем зовёт `dismiss()`.
 */
interface AudioUnlockState {
  shown: boolean;
  show: () => void;
  dismiss: () => void;
}

export const useAudioUnlockStore = create<AudioUnlockState>((set) => ({
  shown: false,
  show: () => set({ shown: true }),
  dismiss: () => set({ shown: false }),
}));
