'use client';

import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { ChatMessage } from '@relay/shared';
import { Icon } from '@/components/ui/icon';
import { Identicon } from '@/components/ui/Identicon';
import { useT } from '@/lib/i18n';

/**
 * Панель справа поверх ленты — закреплённые и поиск. Поверх, а не рядом:
 * раздвигать колонки на время поиска значило бы перекладывать разговор
 * туда-сюда под руками у человека. На телефоне она занимает экран целиком.
 */
export function ChatDrawer({
  open,
  label,
  children,
}: {
  open: boolean;
  /** Имя панели для читалки экрана. */
  label: string;
  children: ReactNode;
}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          initial={{ opacity: 0, x: 16 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 16 }}
          transition={{ duration: 0.16 }}
          className="panel absolute inset-y-0 right-0 z-30 flex w-[380px] flex-col border-l border-line shadow-[-8px_0_24px_rgba(0,0,0,0.28)] max-md:inset-0 max-md:w-auto max-md:border-l-0"
          role="dialog"
          aria-label={label}
        >
          {children}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

/** Крестик в шапке панели. */
export function DrawerClose({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label={t('common.close')}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-text-muted transition-colors hover:bg-bg-hover hover:text-text"
    >
      <Icon name="x" className="text-[13px]" />
    </button>
  );
}

/**
 * Реплика, вырванная из ленты: лицо, автор и текст. `text` — как показать
 * сказанное (поиск подсвечивает в нём найденное); у реплики без текста —
 * подпись «вложение».
 */
export function MessageExcerpt({
  msg,
  text,
}: {
  msg: Pick<ChatMessage, 'fingerprint' | 'name' | 'text'>;
  text?: ReactNode;
}) {
  const t = useT();
  return (
    <div className="mt-1.5 flex items-start gap-2">
      {msg.fingerprint ? (
        <Identicon fingerprint={msg.fingerprint} size={20} className="mt-0.5" />
      ) : (
        <span className="mt-0.5 h-5 w-5 shrink-0 rounded-full bg-bg-active" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <span className="text-[13px] font-semibold text-text-header">{msg.name}</span>
        <p className="break-words text-[13px] leading-[1.45] text-text">
          {msg.text ? (text ?? msg.text) : t('chat.attachment')}
        </p>
      </div>
    </div>
  );
}
