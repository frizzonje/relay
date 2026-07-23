'use client';

import { useEffect, useState, type CSSProperties } from 'react';

/**
 * Знак relay — «mesh-триада»: треугольник из трёх узлов, соединённых рёбрами
 * (верхний узел крупнее и светлее = «активный», буквально p2p-mesh друзей).
 * Раздел 01 референса.
 *
 * `animate` включает анимацию. `variant` выбирает её характер:
 *  - 'draw'      — рёбра прочерчиваются, узлы всплывают пружиной (базовая)
 *  - 'pulse'     — узлы бьются по очереди с расходящимися кольцами (присутствие)
 *  - 'onair'     — активный узел пускает волны-пинги (в эфире)
 *  - 'handshake' — рёбра по кругу «схватываются», узлы вспыхивают (рукопожатие)
 *  - 'random'    — (по умолчанию) на каждом маунте выбирается случайный вариант,
 *                  чтобы знак не проигрывал одну и ту же анимацию каждый раз.
 *
 * Узлы-основания заливаются цветом фона поверхности (`nodeBg`), чтобы «прорезать»
 * рёбра — по умолчанию корневой фон приложения.
 */
type Variant = 'draw' | 'pulse' | 'onair' | 'handshake';
type VariantProp = Variant | 'random';

const POOL: Variant[] = ['draw', 'pulse', 'onair', 'handshake'];

export function Logo({
  size = 48,
  animate = false,
  variant = 'random',
  nodeBg = '#08090b',
  className,
  style,
}: {
  size?: number;
  animate?: boolean;
  variant?: VariantProp;
  nodeBg?: string;
  className?: string;
  style?: CSSProperties;
}) {
  // Для фиксированного варианта — рендерим его сразу (SSR совпадает с клиентом).
  // Для 'random' стартуем с 'draw', а на маунте (только на клиенте) выбираем
  // случайный вариант — так каждый показ знака отличается, без hydration-mismatch.
  const isRandom = variant === 'random';
  const [v, setV] = useState<Variant>(isRandom ? 'draw' : variant);
  useEffect(() => {
    if (isRandom) setV(POOL[Math.floor(Math.random() * POOL.length)]);
    else setV(variant);
  }, [isRandom, variant]);

  const a = animate;

  const drawEdge = (delay: number): CSSProperties =>
    a ? { ['--len' as string]: 30, strokeDasharray: 30, animation: `drawEdge 2.6s ease ${delay}s infinite alternate both` } : {};
  const drawNode = (delay: number): CSSProperties =>
    a
      ? { transformBox: 'fill-box', transformOrigin: 'center', animation: `nodeIn 2.6s cubic-bezier(.2,1.4,.4,1) ${delay}s infinite alternate both` }
      : {};

  const hbRing = (delay: number): CSSProperties =>
    a ? { transformBox: 'fill-box', transformOrigin: 'center', animation: `logoHbRing 2s ease ${delay}s infinite` } : { opacity: 0 };
  const hbPulse = (delay: number): CSSProperties =>
    a ? { transformBox: 'fill-box', transformOrigin: 'center', animation: `logoHbPulse 2s ease ${delay}s infinite` } : {};

  const ping = (delay: number): CSSProperties =>
    a ? { transformBox: 'fill-box', transformOrigin: 'center', animation: `logoPing 2.4s ease ${delay}s infinite` } : { opacity: 0 };
  const topGlow: CSSProperties = a
    ? { transformBox: 'fill-box', transformOrigin: 'center', animation: `logoTopGlow 2.4s ease infinite` }
    : {};

  const hsEdge = (delay: number): CSSProperties =>
    a
      ? { ['--len' as string]: 24, strokeDasharray: 24, strokeDashoffset: 24, animation: `logoHsEdge 3s ease ${delay}s infinite` }
      : {};
  const hsNode = (delay: number): CSSProperties =>
    a ? { transformBox: 'fill-box', transformOrigin: 'center', animation: `logoHsNode 3s ease ${delay}s infinite` } : {};

  return (
    <span
      className={className}
      style={{ position: 'relative', display: 'inline-flex', width: size, height: size, ...style }}
      aria-hidden="true"
    >
      {/* overflow: visible — чтобы свечение/пинги onair и handshake не обрезались по краю viewBox */}
      <svg width={size} height={size} viewBox="0 0 48 48" fill="none" style={{ position: 'relative', overflow: 'visible' }}>
        {/* рёбра-основания — статичны, кроме draw (там сами прочерчиваются) */}
        <line x1="24" y1="13" x2="12.5" y2="34" stroke="#7a828d" strokeWidth="1.5" strokeLinecap="round" style={v === 'draw' ? drawEdge(0.1) : {}} />
        <line x1="24" y1="13" x2="35.5" y2="34" stroke="#7a828d" strokeWidth="1.5" strokeLinecap="round" style={v === 'draw' ? drawEdge(0.35) : {}} />
        <line x1="12.5" y1="34" x2="35.5" y2="34" stroke="#7a828d" strokeWidth="1.5" strokeLinecap="round" style={v === 'draw' ? drawEdge(0.6) : {}} />

        {v === 'pulse' && (
          <>
            <circle cx="24" cy="13" r="6" fill="none" stroke="rgba(231,233,236,.6)" strokeWidth="1.5" style={hbRing(0)} />
            <circle cx="12.5" cy="34" r="5" fill="none" stroke="rgba(154,160,168,.55)" strokeWidth="1.5" style={hbRing(0.16)} />
            <circle cx="35.5" cy="34" r="5" fill="none" stroke="rgba(154,160,168,.55)" strokeWidth="1.5" style={hbRing(0.32)} />
          </>
        )}

        {v === 'onair' && (
          <>
            <circle cx="24" cy="13" r="6" fill="none" stroke="rgba(231,233,236,.7)" strokeWidth="1.5" style={ping(0)} />
            <circle cx="24" cy="13" r="6" fill="none" stroke="rgba(231,233,236,.7)" strokeWidth="1.5" style={ping(1.2)} />
          </>
        )}

        {v === 'handshake' && (
          <>
            <line x1="24" y1="13" x2="12.5" y2="34" stroke="#f2f3f5" strokeWidth="1.5" strokeLinecap="round" style={hsEdge(0)} />
            <line x1="35.5" y1="34" x2="24" y2="13" stroke="#f2f3f5" strokeWidth="1.5" strokeLinecap="round" style={hsEdge(0.55)} />
            <line x1="12.5" y1="34" x2="35.5" y2="34" stroke="#f2f3f5" strokeWidth="1.5" strokeLinecap="round" style={hsEdge(1.1)} />
          </>
        )}

        <circle
          cx="12.5"
          cy="34"
          r="5"
          fill={nodeBg}
          stroke="#9aa0a8"
          strokeWidth="1.5"
          style={v === 'draw' ? drawNode(1.15) : v === 'pulse' ? hbPulse(0.16) : v === 'handshake' ? hsNode(0.35) : {}}
        />
        <circle
          cx="35.5"
          cy="34"
          r="5"
          fill={nodeBg}
          stroke="#9aa0a8"
          strokeWidth="1.5"
          style={v === 'draw' ? drawNode(1.3) : v === 'pulse' ? hbPulse(0.32) : v === 'handshake' ? hsNode(0.9) : {}}
        />
        <circle
          cx="24"
          cy="13"
          r="6"
          fill="#e7e9ec"
          style={
            v === 'draw'
              ? drawNode(1)
              : v === 'pulse'
                ? hbPulse(0)
                : v === 'onair'
                  ? topGlow
                  : v === 'handshake'
                    ? hsNode(0)
                    : {}
          }
        />
      </svg>
    </span>
  );
}
