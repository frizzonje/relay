'use client';

import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { tabPanel } from '@/lib/motion';

/**
 * Шапка правой колонки диалога со вкладками — настроек и панели владельца:
 * имя открытой вкладки и крестик. Имя сменяется той же анимацией, что и
 * содержимое вкладки, поэтому ключ анимации — вкладка, а не текст.
 */
export function PaneHeader({
  title,
  titleKey,
  closeLabel,
  onClose,
}: {
  title: ReactNode;
  /** Что сменилось: по нему прежнее имя гаснет, а новое приезжает. */
  titleKey: string;
  closeLabel: string;
  onClose: () => void;
}) {
  return (
    <div className="flex h-[52px] shrink-0 items-center justify-between border-b border-line px-5 max-md:px-4">
      <h2 className="overflow-hidden text-[15px] font-semibold text-text-header">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={titleKey}
            variants={tabPanel}
            initial="hidden"
            animate="show"
            exit="exit"
            className="block"
          >
            {title}
          </motion.span>
        </AnimatePresence>
      </h2>
      <button
        type="button"
        onClick={onClose}
        aria-label={closeLabel}
        className="grid h-7 w-7 place-items-center rounded-[7px] text-lg leading-none text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text-header"
      >
        ×
      </button>
    </div>
  );
}
