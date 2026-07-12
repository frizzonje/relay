'use client';

import { useEffect, useRef } from 'react';

/**
 * Атмосфера фона relay (раздел 08 референса). Угольная точечная сетка + два
 * холодных дрейфующих световых пятна, поверх — интерактивный спотлайт под
 * курсором и проступающая mesh-сетка более ярких точек в его радиусе.
 *
 * Спотлайт обновляется через CSS-переменные --mx/--my, которые пишутся прямо в
 * DOM по ref на каждый mousemove (throttle через rAF) — БЕЗ ре-рендера React.
 * Слой fixed под всем контентом (z-index:-1); непрозрачные панели shell-а его
 * перекрывают, так что спотлайт виден только там, где фон открыт (вход/лобби).
 * prefers-reduced-motion гасит дрейф правилом в globals.css.
 */
export function Background() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Только указательные устройства с наведением (десктоп/веб) — на тач спотлайт
    // не нужен и mousemove не приходит.
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

    let frame = 0;
    const onMove = (e: MouseEvent) => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        el.style.setProperty('--mx', `${(e.clientX / window.innerWidth) * 100}%`);
        el.style.setProperty('--my', `${(e.clientY / window.innerHeight) * 100}%`);
        el.classList.add('is-active');
      });
    };
    const onLeave = () => el.classList.remove('is-active');

    window.addEventListener('mousemove', onMove);
    document.addEventListener('mouseleave', onLeave);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseleave', onLeave);
    };
  }, []);

  return (
    <div ref={ref} className="atmos" aria-hidden="true">
      <div className="atmos__dots" />
      <div className="atmos__glow atmos__glow--a" />
      <div className="atmos__glow atmos__glow--b" />
      <div className="atmos__spot" />
      <div className="atmos__mesh" />
    </div>
  );
}
