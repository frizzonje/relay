import type { CSSProperties } from 'react';

/**
 * Знак relay — «mesh-триада»: треугольник из трёх узлов, соединённых рёбрами
 * (верхний узел крупнее и светлее = «активный», буквально p2p-mesh друзей).
 * Раздел 01 референса.
 *
 * `animate` — draw-in анимация при маунте (рёбра «прочерчиваются»,
 * узлы «всплывают» пружиной), зациклена туда-обратно (alternate infinite).
 * Доиграв, немного «держит паузу» в собранном виде и лишь потом тихо
 * разбирается назад — без резкого рывка на каждом витке.
 *
 * Узлы-основания заливаются цветом фона поверхности (`nodeBg`), чтобы «прорезать»
 * рёбра — по умолчанию корневой фон приложения.
 */
export function Logo({
  size = 48,
  animate = false,
  nodeBg = '#08090b',
  className,
  style,
}: {
  size?: number;
  animate?: boolean;
  nodeBg?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const edge = (delay: number): CSSProperties =>
    animate
      ? { ['--len' as string]: 30, strokeDasharray: 30, animation: `drawEdge 2.6s ease ${delay}s infinite alternate both` }
      : {};
  const node = (delay: number): CSSProperties =>
    animate
      ? {
          transformBox: 'fill-box',
          transformOrigin: 'center',
          animation: `nodeIn 2.6s cubic-bezier(.2,1.4,.4,1) ${delay}s infinite alternate both`,
        }
      : {};

  return (
    <span
      className={className}
      style={{ position: 'relative', display: 'inline-flex', width: size, height: size, ...style }}
      aria-hidden="true"
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 48 48"
        fill="none"
        style={{ position: 'relative' }}
      >
        <line x1="24" y1="13" x2="12.5" y2="34" stroke="#7a828d" strokeWidth="1.5" strokeLinecap="round" style={edge(0.1)} />
        <line x1="24" y1="13" x2="35.5" y2="34" stroke="#7a828d" strokeWidth="1.5" strokeLinecap="round" style={edge(0.35)} />
        <line x1="12.5" y1="34" x2="35.5" y2="34" stroke="#7a828d" strokeWidth="1.5" strokeLinecap="round" style={edge(0.6)} />
        <circle cx="12.5" cy="34" r="5" fill={nodeBg} stroke="#9aa0a8" strokeWidth="1.5" style={node(1.15)} />
        <circle cx="35.5" cy="34" r="5" fill={nodeBg} stroke="#9aa0a8" strokeWidth="1.5" style={node(1.3)} />
        <circle cx="24" cy="13" r="6" fill="#e7e9ec" style={node(1)} />
      </svg>
    </span>
  );
}
