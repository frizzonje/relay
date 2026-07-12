'use client';

import { Icon } from '@/components/ui/icon';
import { useUiStore } from '@/stores/ui';

/**
 * Шапка сцены: название открытого канала (голос/текст) или подсказка в лобби.
 */
export function Topbar() {
  const view = useUiStore((s) => s.view);
  const voiceLabel = useUiStore((s) => s.voiceLabel);
  const textLabel = useUiStore((s) => s.textLabel);

  return (
    <div className="panel flex h-[52px] shrink-0 items-center gap-2.5 overflow-hidden border-b border-line px-4 shadow-[0_1px_2px_rgba(0,0,0,0.2)]">
      <span className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap font-bold text-text-header">
        {view === 'voice' ? (
          <>
            <Icon name="volume-2" className="text-xl text-text-muted" />
            {voiceLabel}
          </>
        ) : view === 'text' ? (
          <>
            <span className="text-text-faint">#</span>
            {textLabel}
          </>
        ) : (
          'Выберите канал'
        )}
      </span>
    </div>
  );
}
