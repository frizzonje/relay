'use client';

import { Icon } from '@/components/ui/icon';
import { useSearchStore } from '@/stores/search';
import { useUiStore } from '@/stores/ui';
import { useT } from '@/lib/i18n';

/**
 * Шапка сцены: название открытого канала (голос/текст) или подсказка в лобби.
 * Только десктоп: на узком экране то же самое — и со стрелкой назад — показывает
 * MobileNav, а две шапки подряд съедали бы треть экрана телефона.
 *
 * Справа — поиск, и только в текстовом канале: в голосовом искать нечего, а
 * кнопка, которая там ничего не делает, — это обещание, которого нет.
 */
export function Topbar() {
  const t = useT();
  const view = useUiStore((s) => s.view);
  const voiceLabel = useUiStore((s) => s.voiceLabel);
  const textLabel = useUiStore((s) => s.textLabel);

  return (
    <div className="panel flex h-[52px] shrink-0 items-center gap-2.5 overflow-hidden border-b border-line px-4 shadow-[0_1px_2px_rgba(0,0,0,0.2)] max-md:hidden">
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
          t('topbar.noChannel')
        )}
      </span>

      {view === 'text' && (
        <button
          type="button"
          onClick={() => useSearchStore.getState().setOpen(true)}
          aria-label={t('search.open')}
          title={t('search.open.hint')}
          className="ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-full text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text-header"
        >
          <Icon name="search" className="text-[18px]" />
        </button>
      )}
    </div>
  );
}
