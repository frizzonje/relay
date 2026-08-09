'use client';

import { useRef } from 'react';
import type { ChatMessage } from '@relay/shared';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { getSocket } from '@/lib/socket';
import { useT } from '@/lib/i18n';

/**
 * Подтверждение удаления своего сообщения. Раньше здесь стоял `window.confirm`:
 * системное окно браузера посреди чата, а в десктоп-оболочке — окно чужого
 * приложения поверх relay.
 *
 * Заодно диалог показывает само сообщение. Вопрос «удалить сообщение?» без него
 * проверить нечем: реплик на экране много, промахнуться курсором — обычное дело,
 * а отката у удаления нет.
 */
export function DeleteMessageDialog({
  target,
  onOpenChange,
}: {
  target: ChatMessage | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();

  // Диалог закрывается с анимацией, а `target` обнуляется сразу — держим
  // последний, иначе на выходе мелькнёт пустая цитата.
  const last = useRef<ChatMessage | null>(null);
  if (target) last.current = target;
  const shown = target ?? last.current;

  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={onOpenChange}
      title={t('chat.delete.confirm')}
      description={t('chat.delete.body')}
      onConfirm={() => {
        if (target?.id) getSocket().emit('chat-delete', { id: target.id });
        onOpenChange(false);
      }}
      details={
        shown && (
          <p className="max-h-24 overflow-hidden rounded-[10px] border border-line bg-bg-deep/60 px-3 py-2 text-[13px] leading-snug text-text-muted">
            {shown.text || t('chat.attachment')}
          </p>
        )
      }
    />
  );
}
