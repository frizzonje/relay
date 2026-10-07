'use client';

import { Icon } from '@/components/ui/icon';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useCallGate, useRingStore } from '@/stores/ring';

/**
 * Круглая кнопка голосового звонка в шапке беседы — на широком экране
 * (`DmThread`) и на телефоне (`MobileNav`, цель 44px под палец).
 *
 * Инсталляция может звонки погасить (`useCallGate`), и гасится кнопка БЕЗ HTML
 * `disabled`: атрибут выбросил бы её из обхода с клавиатуры вместе с
 * единственным объяснением, почему она ничего не делает. Отсюда
 * `aria-disabled`, причина в тултипе и в `aria-label`.
 */
export function CallIconButton({
  fingerprint,
  nick,
  touch = false,
}: {
  fingerprint: string;
  nick: string;
  /** Цель под палец: 44px и отклик на нажатие, а не на наведение. */
  touch?: boolean;
}) {
  const t = useT();
  const gate = useCallGate();
  const label = t('toolbar.call');
  return (
    <button
      type="button"
      aria-disabled={gate.allowed ? undefined : true}
      title={gate.allowed ? label : t(gate.reasonKey)}
      aria-label={gate.allowed ? label : `${label} — ${t(gate.reasonKey)}`}
      onClick={
        gate.allowed
          ? () => void useRingStore.getState().start({ fingerprint, nick }, false)
          : undefined
      }
      className={cn(
        'grid shrink-0 place-items-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-line-strong',
        touch ? 'h-11 w-11' : 'h-8 w-8',
        !gate.allowed
          ? 'cursor-not-allowed text-text-faint'
          : touch
            ? 'text-ok active:bg-ok/10'
            : 'text-ok hover:bg-ok/10',
      )}
    >
      <Icon name="phone" className={touch ? 'text-[19px]' : 'text-[16px]'} strokeWidth={1.8} />
    </button>
  );
}
