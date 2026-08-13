import { GRID, identiconOf } from '@/lib/identicon';

/**
 * Лицо личности — рисунок, выведенный из отпечатка ключа (см. lib/identicon,
 * там же почему он вообще нужен). Здесь только показ: ни состояния, ни случая,
 * ни сети — один и тот же отпечаток обязан дать одну и ту же картинку в ленте,
 * в составе канала и на экране первого входа.
 *
 * По умолчанию картинка декоративна и от скринридера спрятана: рядом с ней
 * всегда стоит ник, а читать вслух пятнадцать закрашенных квадратиков — шум.
 * `title` включает её обратно, когда identicon стоит один (кнопка, аватар без
 * подписи) и заменить его текстом нечем.
 */
export function Identicon({
  fingerprint,
  size = 32,
  title,
  className,
}: {
  fingerprint: string;
  /** Сторона в пикселях. Рисунок векторный — берёт любую. */
  size?: number;
  className?: string;
  title?: string;
}) {
  const { cells, color } = identiconOf(fingerprint);
  // Поле вокруг сетки — часть картинки, а не отступ снаружи: так identicon
  // остаётся одним элементом и не разъезжается в разной вёрстке.
  const PAD = 1;
  const box = GRID + PAD * 2;

  return (
    <svg
      viewBox={`0 0 ${box} ${box}`}
      width={size}
      height={size}
      className={className}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      // Клетки — прямоугольники по целым координатам: сглаживание тут только
      // размывает границу между соседними.
      shapeRendering="crispEdges"
    >
      {title && <title>{title}</title>}
      <rect
        width={box}
        height={box}
        rx={box / 5}
        fill="var(--color-bg-deep)"
        shapeRendering="auto"
      />
      {cells.map((on, i) =>
        on ? (
          <rect
            key={i}
            x={PAD + (i % GRID)}
            y={PAD + Math.floor(i / GRID)}
            width={1}
            height={1}
            fill={color}
          />
        ) : null,
      )}
    </svg>
  );
}
