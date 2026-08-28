'use client';

import { useEffect, useRef } from 'react';

/**
 * Атмосфера фона relay (раздел 08 референса). Угольная точечная сетка + два
 * холодных дрейфующих световых пятна, поверх — интерактивный спотлайт под
 * курсором и проступающая сетка более ярких точек в его радиусе.
 *
 * Слой fixed под всем контентом (z-index:-1); непрозрачные панели каркаса его
 * перекрывают, так что виден он там, где фон открыт: вход, лобби и полотно
 * сцены. prefers-reduced-motion гасит дрейф правилом в globals.css.
 *
 * Курсор двигает слои transform'ом — и это единственное, что мы вообще меняем
 * на mousemove. Раньше положение спотлайта приезжало в CSS-переменные, из
 * которых собирались полноэкранный градиент и полноэкранная маска: обе
 * пересчитывались целиком на каждое движение мыши. Готовую картинку, которую
 * возят transform'ом, браузер не перерисовывает вовсе — он двигает её тем же
 * механизмом, что и прокрутку.
 *
 * React в этом не участвует: ни состояния, ни ре-рендера — только запись в
 * style по ref внутри rAF.
 */
export function Background() {
  const root = useRef<HTMLDivElement>(null);
  const spot = useRef<HTMLDivElement>(null);
  const mesh = useRef<HTMLDivElement>(null);
  const meshDots = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    const s = spot.current;
    const m = mesh.current;
    const dots = meshDots.current;
    if (!el || !s || !m || !dots) return;
    // Только указательные устройства с наведением (десктоп/веб) — на тач спотлайт
    // не нужен и mousemove не приходит.
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

    // Шаг сетки и радиус окошка берём из CSS: там они заданы для самих слоёв, и
    // второй их экземпляр в коде рано или поздно разошёлся бы с первым.
    const css = getComputedStyle(el);
    const num = (name: string, fallback: number) =>
      parseFloat(css.getPropertyValue(name)) || fallback;
    const step = num('--atmos-dot', 26);
    const half = num('--atmos-mesh', 150);

    let frame = 0;
    let x = 0;
    let y = 0;

    const paint = () => {
      frame = 0;
      const move = `translate3d(${x}px, ${y}px, 0)`;
      s.style.transform = move;
      m.style.transform = move;
      // Сетка внутри окошка стоит на месте, пока окошко по ней ездит: яркие
      // точки — это те же точки фона, только зажжённые, и разъехаться с
      // тусклыми им нельзя. Компенсируем сдвиг окошка обратным, но по остатку
      // от шага: рисунок повторяется, и попасть достаточно в ту же клетку.
      const back = (v: number) => (((v % step) + step) % step) - step;
      dots.style.transform = `translate3d(${back(half - x)}px, ${back(half - y)}px, 0)`;
      el.classList.add('is-active');
    };

    const onMove = (e: MouseEvent) => {
      x = e.clientX;
      y = e.clientY;
      // Не чаще кадра: mousemove приходит и по нескольку раз на кадр, а вторая
      // запись в тот же style за один кадр ничего не показывает.
      if (!frame) frame = requestAnimationFrame(paint);
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
    <div ref={root} className="atmos" aria-hidden="true">
      <div className="atmos__dots" />
      <div className="atmos__glow atmos__glow--a" />
      <div className="atmos__glow atmos__glow--b" />
      <div ref={spot} className="atmos__spot" />
      <div ref={mesh} className="atmos__mesh">
        <div ref={meshDots} className="atmos__mesh-dots" />
      </div>
    </div>
  );
}
