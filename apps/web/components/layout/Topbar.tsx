'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { Icon } from '@/components/ui/icon';
import { tabPanel } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { usePinsStore } from '@/stores/pins';
import { useSearchStore } from '@/stores/search';
import { useUiStore } from '@/stores/ui';
import { useT } from '@/lib/i18n';

/**
 * Шапка сцены: название открытого канала (голос/текст) или подсказка в лобби.
 * Только десктоп: на узком экране то же самое — и со стрелкой назад — показывает
 * MobileNav, а две шапки подряд съедали бы треть экрана телефона.
 *
 * Справа — закреплённое и поиск, и только в текстовом канале: в голосовом
 * искать нечего, а кнопка, которая там ничего не делает, — это обещание,
 * которого нет.
 */
export function Topbar() {
  const t = useT();
  const view = useUiStore((s) => s.view);
  const voiceLabel = useUiStore((s) => s.voiceLabel);
  const textLabel = useUiStore((s) => s.textLabel);
  const pins = usePinsStore((s) => s.count);
  const pinsOpen = usePinsStore((s) => s.open);

  return (
    <div className="panel flex h-[52px] shrink-0 items-center gap-2.5 overflow-hidden border-b border-line px-4 shadow-[0_1px_2px_rgba(0,0,0,0.2)] max-md:hidden">
      {/* Имя канала меняется вместе со сценой — и переезжает так же, как её
          содержимое: подмена текста на месте выглядела бы опечаткой. */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={
            view === 'text'
              ? `text:${textLabel}`
              : view === 'voice'
                ? `voice:${voiceLabel}`
                : 'lobby'
          }
          variants={tabPanel}
          initial="hidden"
          animate="show"
          exit="exit"
          className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap font-bold text-text-header"
        >
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
        </motion.span>
      </AnimatePresence>

      {view === 'text' && (
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {/* Закреплённых нет — нет и кнопки: пустой список за ней означал бы,
              что человек сходил проверить и ничего не нашёл. Тому, кто может
              закрепить, вход всё равно нужен из меню сообщения, а не отсюда. */}
          {pins > 0 && (
            <button
              type="button"
              onClick={() => usePinsStore.getState().setOpen(!pinsOpen)}
              aria-label={t('pins.open')}
              aria-pressed={pinsOpen}
              title={t('pins.count', { count: pins })}
              className={cn(
                'flex h-8 items-center gap-1 rounded-full px-2 text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text-header',
                pinsOpen && 'bg-bg-active text-text-header',
              )}
            >
              <Icon name="pin" className="text-[17px]" />
              <span className="text-[12px] font-semibold tabular-nums">{pins}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => useSearchStore.getState().setOpen(true)}
            aria-label={t('search.open')}
            title={t('search.open.hint')}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text-header"
          >
            <Icon name="search" className="text-[18px]" />
          </button>
        </div>
      )}
    </div>
  );
}
