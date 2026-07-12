'use client';

import { useAudioUnlockStore } from '@/stores/audio-unlock';
import { resumeVoiceAudio } from '@/lib/voice';

/**
 * Кнопка разблокировки звука. Браузер мог заблокировать автоплей до первого
 * жеста — по нажатию доигрываем все видео И возобновляем AudioContext микшера:
 * весь голос собеседников идёт через Web Audio, и без этого жеста он остаётся
 * в тишине, даже когда видео уже играет. Показ включает VideoTile (show()).
 */
export function AudioUnlock() {
  const shown = useAudioUnlockStore((s) => s.shown);
  const dismiss = useAudioUnlockStore((s) => s.dismiss);
  if (!shown) return null;

  return (
    <button
      className="fixed left-1/2 top-[60px] z-[1003] -translate-x-1/2 cursor-pointer rounded-lg border-0 bg-bg-active px-[18px] py-[11px] text-[13px] font-bold text-text-header shadow-[0_8px_30px_rgba(0,0,0,0.6)] transition-colors hover:bg-bg-hover"
      onClick={() => {
        document.querySelectorAll('video').forEach((v) => {
          void v.play().catch(() => {});
        });
        resumeVoiceAudio();
        dismiss();
      }}
    >
      🔇 Браузер заглушил звук — нажмите, чтобы включить
    </button>
  );
}
