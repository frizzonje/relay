'use client';

import { AnimatePresence, motion } from 'framer-motion';

/**
 * Число, которое «щёлкает» при изменении — старое значение уходит вверх, новое
 * приезжает снизу. Для счётчиков составов («В сети — N», «В канале — N») и т.п.
 * tabular-nums держит ширину, чтобы соседний текст не дёргался.
 */
export function AnimatedCount({ value }: { value: number }) {
  return (
    <span className="relative inline-grid overflow-hidden tabular-nums">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={value}
          initial={{ y: '-100%', opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: '100%', opacity: 0 }}
          transition={{ duration: 0.2, ease: [0.2, 0.8, 0.3, 1] }}
          className="col-start-1 row-start-1"
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
