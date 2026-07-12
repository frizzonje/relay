'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { listItem, springLayout } from '@/lib/motion';
import { Icon } from '@/components/ui/icon';
import { AnimatedCount } from '@/components/ui/AnimatedCount';
import { useUiStore } from '@/stores/ui';
import { useVoiceStore } from '@/stores/voice';
import { avatarStyle } from '@/lib/avatar';

/**
 * Правая колонка «В канале» (раздел 02 референса, 232px). Смысл имеет только в
 * голосовом канале, поэтому в лобби/тексте скрыта. Состав = плитки голосового
 * менеджера (своя + собеседники). У каждого — аватар с зелёным online-индикатором,
 * имя и строка статуса: «говорит» (зелёным, по speakingIds) либо «в эфире»;
 * у своей заглушённой плитки — перечёркнутый микрофон.
 */
export function Members() {
  const view = useUiStore((s) => s.view);
  const tiles = useVoiceStore((s) => s.tiles);
  const speakingIds = useVoiceStore((s) => s.speakingIds);
  const micOn = useVoiceStore((s) => s.micOn);
  const myId = useVoiceStore((s) => s.myId);
  if (view !== 'voice') return null;

  return (
    <aside className="panel panel-sidebar flex w-[232px] shrink-0 flex-col overflow-hidden border-l border-line max-md:grow max-md:border-l-0">
      <h3 className="flex h-[52px] shrink-0 items-center gap-1 border-b border-line px-4 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-text-faint shadow-[0_1px_2px_rgba(0,0,0,0.2)]">
        В канале — <AnimatedCount value={tiles.length} />
      </h3>
      <div className="flex-1 overflow-y-auto px-2 py-3">
        <AnimatePresence initial={false}>
          {tiles.map((t) => {
            const speaking = speakingIds.includes(t.id);
            // Мут знаем достоверно только для своей плитки (микрофон в сторе).
            const selfMuted = (t.isLocal || t.id === myId) && !micOn;
            return (
              <motion.div
                key={t.id}
                layout
                variants={listItem}
                initial="hidden"
                animate="show"
                exit="exit"
                transition={springLayout}
                className="flex items-center gap-2.5 rounded-[8px] px-2 py-1.5 transition-colors hover:bg-bg-hover"
              >
              <div
                className={cn(
                  'relative h-8 w-8 shrink-0 rounded-full',
                  "after:absolute after:-bottom-0.5 after:-right-0.5 after:h-[11px] after:w-[11px] after:rounded-full after:border-2 after:border-bg-sidebar after:bg-ok after:content-['']",
                  speaking && 'ring-2 ring-ok',
                )}
                style={avatarStyle(t.name)}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-medium text-text">{t.name}</div>
                <div
                  className={cn(
                    'truncate font-mono text-[11px]',
                    speaking ? 'text-ok' : 'text-text-faint',
                  )}
                >
                  {selfMuted ? 'без звука' : speaking ? 'говорит' : 'в эфире'}
                </div>
              </div>
                {selfMuted && (
                  <Icon
                    name="mic-off"
                    className="shrink-0 text-[15px] text-danger/85"
                    title="Микрофон выключен"
                  />
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </aside>
  );
}
