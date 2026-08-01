'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import { clearFocus } from '@/lib/voice';
import { useVoiceStore } from '@/stores/voice';
import { VideoTile } from '@/components/stage/VideoTile';
import { useT } from '@/lib/i18n';

// Плитки 16:9, зазор между ними — как gap-3 в разметке (0.75rem).
const TILE_AR = 16 / 9;
const GAP = 12;
// Ниже этого плитка перестаёт быть видео и становится маркой: лучше показать
// её нормальной и дать прокрутку, чем набить экран марками.
const MIN_TILE = 168;
// Полоса под подсказкой «вы тут один» — её плитка не занимает.
const HINT_SPACE = 40;

/**
 * Разложить `count` плиток 16:9 в прямоугольник `w`×`h` так, чтобы плитка вышла
 * как можно крупнее и при этом ВСЯ сетка влезла по обеим сторонам. Перебираем
 * число колонок (их не больше числа плиток) и берём лучшее.
 *
 * Одной ширины тут мало: `auto-fit` по минимуму в 300px учитывает только её, и
 * на невысоком окне две плитки в столбик просто не помещались по высоте —
 * получалась вертикальная прокрутка внутри сцены (полоса справа) и обрезанная
 * нижняя плитка.
 */
function bestColumns(count: number, w: number, h: number): { cols: number; size: number } {
  let best = { cols: 1, size: 0 };
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const byWidth = (w - GAP * (cols - 1)) / cols;
    const byHeight = ((h - GAP * (rows - 1)) / rows) * TILE_AR;
    // Ширина плитки, при которой она влезает и по ширине, и по высоте.
    const size = Math.floor(Math.min(byWidth, byHeight));
    if (size > best.size) best = { cols, size };
  }
  return best;
}

/**
 * Сетка видеоплиток голосового канала. Размер плиток считается под живой размер
 * сцены (см. bestColumns) — сетка всегда влезает целиком, без прокрутки. В
 * театр-режиме (focusedId) одна плитка растягивается на всю сцену, остальные
 * скрыты. Клик по пустому месту и Esc сворачивают фокус.
 */
export function VideoGrid() {
  const t = useT();
  const tiles = useVoiceStore((s) => s.tiles);
  const focusedId = useVoiceStore((s) => s.focusedId);
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearFocus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Живой размер поля под плитки. contentRect уже без паддингов — считаем по нему.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const apply = (w: number, h: number) =>
      // Округляем: иначе каждый субпиксель ресайза — новый пересчёт сетки.
      setBox((prev) =>
        Math.round(prev.w) === Math.round(w) && Math.round(prev.h) === Math.round(h)
          ? prev
          : { w, h },
      );
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      apply(width, height);
    });
    ro.observe(el);
    // Первый замер — руками, не дожидаясь наблюдателя: до его колбэка успел бы
    // пройти кадр с пустой сценой. Считаем ровно то же, что даёт contentRect
    // (клиентская область минус паддинги), иначе первая раскладка будет крупнее
    // места и плитки наедут друг на друга.
    const cs = getComputedStyle(el);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    apply(el.clientWidth - padX, el.clientHeight - padY);
    return () => ro.disconnect();
  }, []);

  // Состояния (раздел 07 референса): пустой канал (вы один) и слабое соединение
  // (у части собеседников связь переустанавливается — tile.state в lib/voice.ts).
  const peers = tiles.filter((t) => !t.isLocal);
  const reconnecting = peers.filter((t) => t.state === 'tile.state.reconnecting').length;
  const alone = peers.length === 0;

  // Колонки и ширина плитки под текущий размер сцены. До первого замера (SSR,
  // первый кадр) сетку не рисуем вовсе: замер идёт в useLayoutEffect, то есть
  // ДО показа кадра — пустой сетки никто не увидит, зато плитки не успевают
  // мигнуть во всю ширину и «переехать» анимацией layout на своё место.
  const layout = (() => {
    if (!tiles.length || !box.w || !box.h) return null;
    // Подсказке «вы тут один» оставляем полосу внизу — иначе она ляжет на плитку.
    const free = alone && !focusedId ? Math.max(box.h - HINT_SPACE, 0) : box.h;
    const { cols, size } = bestColumns(tiles.length, box.w, free);
    if (size >= MIN_TILE) return { template: `repeat(${cols}, ${size}px)`, scroll: false };
    // Плитки упёрлись в минимум: держим минимум, а колонок берём столько, сколько
    // влезает по ШИРИНЕ (иначе строка вылезет вбок), и отдаём остаток вертикальной
    // прокрутке — вбок сетка не ездит никогда.
    const fit = Math.max(1, Math.floor((box.w + GAP) / (MIN_TILE + GAP)));
    return { template: `repeat(${fit}, ${MIN_TILE}px)`, scroll: true };
  })();

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Слабое соединение — баннер поверх сетки, статичный (без анимации, чтобы
          не отвлекать во время реального сбоя) */}
      {reconnecting > 0 && (
        <div className="z-10 flex items-center justify-center gap-2 border-b border-danger/30 bg-danger/15 px-4 py-2 text-[13px] font-medium text-danger">
          <span className="h-1.5 w-1.5 rounded-full bg-danger" />
          {t('grid.reconnecting', { count: reconnecting, total: peers.length })}
        </div>
      )}

      <div
        ref={boxRef}
        onClick={(e) => {
          // Клик мимо плиток — свернуть театр-режим
          if (e.target === e.currentTarget) clearFocus();
        }}
        style={focusedId || !layout ? undefined : { gridTemplateColumns: layout.template }}
        className={cn(
          'grid min-h-0 flex-1 gap-3 p-4',
          focusedId
            ? 'grid-cols-1 grid-rows-1 content-stretch overflow-hidden'
            : 'place-content-center',
          // Прокрутка — только когда плитки уже упёрлись в минимум (окно совсем
          // маленькое или народу много). В обычной жизни сетка влезает целиком.
          !focusedId && (layout?.scroll ? 'overflow-y-auto' : 'overflow-hidden'),
        )}
      >
        <AnimatePresence>
          {(!!layout || !!focusedId) &&
            tiles.map((tile) => {
              const hidden = !!focusedId && tile.id !== focusedId;
              return (
                <VideoTile
                  key={tile.id}
                  tile={tile}
                  focused={focusedId === tile.id}
                  hidden={hidden}
                />
              );
            })}
        </AnimatePresence>
      </div>

      {/* Пустой канал: вы один — тихая подсказка внизу, не перекрывает свою плитку */}
      {alone && !focusedId && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <div className="rounded-full border border-dashed border-line bg-bg-panel/70 px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-text-faint backdrop-blur">
            {t('grid.alone')}
          </div>
        </div>
      )}
    </div>
  );
}
