import { forwardRef } from 'react';
import { cn } from '@/lib/utils';

type GlassDepth = 1 | 2 | 3;

export interface GlassProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Уровень глубины: 1 — панели, 2 — модалки, 3 — поповеры/тосты (план §3.2). */
  depth?: GlassDepth;
  /** Добавить «жидкий» SVG-шум очень низкой непрозрачности. */
  noise?: boolean;
}

/**
 * Базовая стеклянная поверхность. Утилита `.glass` (+ `.glass-1/2/3`) живёт в
 * globals.css; компонент — типобезопасная обёртка с уровнями глубины и шумом.
 */
export const Glass = forwardRef<HTMLDivElement, GlassProps>(
  ({ depth = 1, noise = false, className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('glass', `glass-${depth}`, noise && 'glass-noise', className)}
      {...props}
    />
  ),
);
Glass.displayName = 'Glass';
