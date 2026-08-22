'use client';

import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useUiStore } from '@/stores/ui';
import { STAGE_FADE_MS } from '@/lib/motion';
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
 *
 * Здесь меняется ВИД сцены (лобби ↔ звонок ↔ текст). Смена текстового канала
 * на соседний вида не меняет и гасит не всю сцену, а одну ленту — композер с
 * недописанным и шапка при этом стоят на месте (см. ChatPanel).
 */
export function Stage() {
  const view = useUiStore((s) => s.view);
  const pending = useUiStore((s) => s.pendingScene);
  const commitScene = useUiStore((s) => s.commitScene);
  const setStageLive = useUiStore((s) => s.setStageLive);

  // Пока сцена на экране, переходы ждут её ухода (см. goScene). Уходя, отпускаем
  // задержанный переход: гасить больше нечего, а держать его — значит запереть
  // навигацию до следующего появления сцены.
  useEffect(() => {
    setStageLive(true);
    return () => {
      setStageLive(false);
      useUiStore.getState().commitScene();
    };
  }, [setStageLive]);

  // Страховка от вкладки в фоне: там браузер не рисует кадров, анимация не
  // доигрывает и «догасла» не приходит вовсе. Без этого переход, начатый в
  // фоне (звонок оборвался, канал удалили), повис бы до возвращения человека.
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(commitScene, STAGE_FADE_MS * 4);
    return () => clearTimeout(timer);
  }, [pending, commitScene]);

  // Вид меняется — гасим сцену целиком. Внутри одного вида (соседний текстовый
  // канал) ключ прежний: там своя, более мелкая анимация.
  const nextView = pending?.view ?? view;
  const changingView = nextView !== view;

  return (
    <div className={cn('relative flex min-h-0 flex-1 flex-col', view !== 'lobby' && 'bg-bg-main')}>
      {/* mode="wait": старый вид гаснет, затем появляется новый — без наложения
          (иначе две сцены встали бы стопкой и дёрнули layout). */}
      {/* Догасла старая сцена — только теперь показываем новую и переставляем
          раскладку вокруг (см. pendingScene). Пока переход в пути, содержимое
          новой сцены не рисуем: framer монтирует тот узел, что мы дали ему в
          прошлый раз, и внутри него оказалась бы уже подменённая начинка. */}
      <AnimatePresence mode="wait" initial={false} onExitComplete={commitScene}>
        <motion.div
          key={nextView}
          // Какая сцена на экране — этим же именем она и ключуется. Атрибут для
          // e2e: он должен находить сцену, а не угадывать её по классам вёрстки.
          data-scene={nextView}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: STAGE_FADE_MS / 1000 }}
          className="flex min-h-0 flex-1 flex-col"
        >
          {!changingView && view === 'lobby' && <Lobby />}
          {!changingView && view === 'voice' && <VideoGrid />}
          {!changingView && view === 'text' && <ChatPanel />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
