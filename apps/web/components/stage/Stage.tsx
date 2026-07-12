'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useUiStore } from '@/stores/ui';
import { cn } from '@/lib/utils';
import { Lobby } from '@/components/stage/Lobby';
import { VideoGrid } from '@/components/stage/VideoGrid';
import { ChatPanel } from '@/components/chat/ChatPanel';

/**
 * Сцена (index.html:1559 #stage): показывает лобби / видео-сетку / чат в
 * зависимости от вида. Только лобби прозрачно — под ним атмосфера фона
 * (спотлайт под курсором, раздел 08). Видео/чат стоят на непрозрачной
 * поверхности `bg-main`: иначе полупрозрачные элементы сцены (композер чата,
 * плашки звонка) просвечивают атмосферным свечением из-под курсора — грязно
 * и отвлекает от контента.
 */
export function Stage() {
  const view = useUiStore((s) => s.view);
  return (
    <div className={cn('relative flex min-h-0 flex-1 flex-col', view !== 'lobby' && 'bg-bg-main')}>
      {/* mode="wait": старый вид гаснет, затем появляется новый — без наложения
          (иначе две сцены встали бы стопкой и дёрнули layout). */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={view}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          className="flex min-h-0 flex-1 flex-col"
        >
          {view === 'lobby' && <Lobby />}
          {view === 'voice' && <VideoGrid />}
          {view === 'text' && <ChatPanel />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
