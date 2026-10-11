'use client';

import type { ReactNode } from 'react';
import { Icon } from '@/components/ui/icon';
import { cn } from '@/lib/utils';

/**
 * Родной `<select>` в нашем оформлении, с шевроном поверх правого края.
 *
 * Один на приложение: таких полей было три копии (личные настройки и два в
 * панели владельца), и при замене иконок одна из них молча потеряла
 * позиционирование шеврона — он уехал под поле.
 */
export function Select({
  value,
  onChange,
  label,
  compact,
  className,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Название для диктора, если видимой подписи рядом нет. */
  label?: string;
  /** Узкое поле рядом с другим (единицы измерения), а не на всю ширину. */
  compact?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('relative', className)}>
      <select
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'appearance-none rounded-[10px] border border-line bg-bg-elev py-2 text-[14px] text-text outline-none transition focus:border-line-strong',
          compact ? 'pl-3 pr-9' : 'w-full pl-3.5 pr-10',
        )}
      >
        {children}
      </select>
      <Icon
        name="chevron-down"
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[16px] text-text-muted"
      />
    </div>
  );
}
