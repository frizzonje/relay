'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { Icon } from '@/components/ui/icon';
import { tabPanel } from '@/lib/motion';
import { FeedActions } from '@/components/layout/FeedActions';
import { useUiStore } from '@/stores/ui';
import { useT } from '@/lib/i18n';

/**
 * Шапка сцены: название открытого канала (голос/текст), собеседник (беседа)
 * или подсказка в лобби. Только десктоп: на узком экране то же самое — и со
 * стрелкой назад — показывает MobileNav, а две шапки подряд съедали бы треть
 * экрана телефона.
 *
 * Справа — закреплённое и поиск, в текстовом канале и в беседе: у беседы
 * закреплённых не бывает (см. задачу 7 — сервер отказывает и список пуст), и
 * кнопка сама не рисуется, раз счётчик всегда ноль; поиск же работает и там —
 * задача 7 нарочно оставила его внутри беседы, и прятать его отсюда значило бы
 * прятать работающую кнопку. В голосовом искать нечего вовсе: кнопка, которая
 * там ничего не делает, — это обещание, которого нет.
 */
export function Topbar() {
  const t = useT();
  const view = useUiStore((s) => s.view);
  const voiceLabel = useUiStore((s) => s.voiceLabel);
  const textLabel = useUiStore((s) => s.textLabel);

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
                : view === 'dm'
                  ? `dm:${textLabel}`
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
          ) : view === 'dm' ? (
            <>
              <Icon name="message-square" className="text-lg text-text-muted" />
              {textLabel}
            </>
          ) : (
            t('topbar.noChannel')
          )}
        </motion.span>
      </AnimatePresence>

      {(view === 'text' || view === 'dm') && (
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <FeedActions />
        </div>
      )}
    </div>
  );
}
