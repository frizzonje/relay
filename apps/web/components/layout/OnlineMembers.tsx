'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { listItem, springLayout } from '@/lib/motion';
import { AnimatedCount } from '@/components/ui/AnimatedCount';
import { useUiStore } from '@/stores/ui';
import { useChatStore } from '@/stores/chat';
import { avatarStyle } from '@/lib/avatar';

/**
 * Правая колонка текстового канала (раздел 05 референса, 232px): «В сети» —
 * просто присутствующие в канале, без микрофон-статусов. Ростер приходит с
 * сервера событием `chat-roster` и лежит в chat-сторе. Видна только в тексте.
 */
export function OnlineMembers() {
  const view = useUiStore((s) => s.view);
  const callsign = useUiStore((s) => s.callsign);
  const roster = useChatStore((s) => s.roster);
  if (view !== 'text') return null;

  const me = callsign.trim() || 'Аноним';

  return (
    <aside className="panel panel-sidebar flex w-[232px] shrink-0 flex-col overflow-hidden border-l border-line max-md:grow max-md:border-l-0">
      <h3 className="flex h-[52px] shrink-0 items-center gap-1 border-b border-line px-4 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-text-faint shadow-[0_1px_2px_rgba(0,0,0,0.2)]">
        В сети — <AnimatedCount value={roster.length} />
      </h3>
      <div className="flex-1 overflow-y-auto px-2 py-3">
        <AnimatePresence initial={false}>
          {roster.map((name) => (
            <motion.div
              key={name}
              layout
              variants={listItem}
              initial="hidden"
              animate="show"
              exit="exit"
              transition={springLayout}
              className="flex items-center gap-2.5 rounded-[8px] px-2 py-1.5 transition-colors hover:bg-bg-hover"
            >
              <div
                className="relative h-8 w-8 shrink-0 rounded-full after:absolute after:-bottom-0.5 after:-right-0.5 after:h-[11px] after:w-[11px] after:rounded-full after:border-2 after:border-bg-sidebar after:bg-ok after:content-['']"
                style={avatarStyle(name)}
              />
              <div
                className={cn(
                  'min-w-0 flex-1 truncate text-[14px]',
                  name === me ? 'font-semibold text-text-header' : 'text-text',
                )}
              >
                {name === me ? `${name} (вы)` : name}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </aside>
  );
}
