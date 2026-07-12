'use client';

import { useEffect } from 'react';
import { AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import { clearFocus } from '@/lib/voice';
import { useVoiceStore } from '@/stores/voice';
import { VideoTile } from '@/components/stage/VideoTile';

/**
 * Сетка видеоплиток голосового канала. Авто-сетка по 300px; в театр-режиме
 * (focusedId) одна плитка растягивается на всю сцену, остальные скрыты.
 * Клик по пустому месту и Esc сворачивают фокус.
 */
export function VideoGrid() {
  const tiles = useVoiceStore((s) => s.tiles);
  const focusedId = useVoiceStore((s) => s.focusedId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearFocus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Состояния (раздел 07 референса): пустой канал (вы один) и слабое соединение
  // (у части собеседников связь переустанавливается — tile.state в lib/voice.ts).
  const peers = tiles.filter((t) => !t.isLocal);
  const reconnecting = peers.filter((t) => t.state.includes('переподключение')).length;
  const alone = peers.length === 0;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Слабое соединение — баннер поверх сетки, статичный (без анимации, чтобы
          не отвлекать во время реального сбоя) */}
      {reconnecting > 0 && (
        <div className="z-10 flex items-center justify-center gap-2 border-b border-danger/30 bg-danger/15 px-4 py-2 text-[13px] font-medium text-danger">
          <span className="h-1.5 w-1.5 rounded-full bg-danger" />
          переподключение · {reconnecting} из {peers.length} недоступны
        </div>
      )}

      <div
        onClick={(e) => {
          // Клик мимо плиток — свернуть театр-режим
          if (e.target === e.currentTarget) clearFocus();
        }}
        className={cn(
          'grid flex-1 gap-3 p-4',
          focusedId
            ? 'grid-cols-1 grid-rows-1 content-stretch overflow-hidden'
            : 'content-center overflow-y-auto [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]',
        )}
      >
        <AnimatePresence>
          {tiles.map((tile) => {
            const hidden = !!focusedId && tile.id !== focusedId;
            return (
              <VideoTile key={tile.id} tile={tile} focused={focusedId === tile.id} hidden={hidden} />
            );
          })}
        </AnimatePresence>
      </div>

      {/* Пустой канал: вы один — тихая подсказка внизу, не перекрывает свою плитку */}
      {alone && !focusedId && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <div className="rounded-full border border-dashed border-line bg-bg-panel/70 px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-text-faint backdrop-blur">
            вы один в канале — позовите остальных
          </div>
        </div>
      )}
    </div>
  );
}
