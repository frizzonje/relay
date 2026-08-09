'use client';

import { useRef } from 'react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { hostLabel, type RemoteHost } from '@/lib/hosts';
import { useHostsStore } from '@/stores/hosts';
import { useT } from '@/lib/i18n';

/**
 * Подтверждение удаления чужого хоста из рейки. Раньше здесь стоял
 * `window.confirm` — в десктоп-оболочке он выдаёт себя системным окном браузера
 * посреди приложения, и это единственное место, где relay выглядел не собой.
 *
 * Действие мягкое (меняется только твой список), поэтому и текст мягкий: пугать
 * тут нечем, но спросить стоит — вернуть хост можно, лишь помня его адрес.
 */
export function RemoveHostDialog({
  target,
  onOpenChange,
}: {
  target: RemoteHost | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const removeHost = useHostsStore((s) => s.removeHost);

  // Диалог закрывается с анимацией, а `target` обнуляется сразу — держим
  // последний, иначе на выходе мелькнёт вопрос без имени.
  const last = useRef<RemoteHost | null>(null);
  if (target) last.current = target;
  const shown = target ?? last.current;

  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={onOpenChange}
      title={t('rail.host.removeConfirm', { name: shown ? hostLabel(shown) : '' })}
      description={t('rail.host.removeBody')}
      confirmLabel={t('rail.host.remove')}
      onConfirm={() => {
        if (target) removeHost(target.url);
        onOpenChange(false);
      }}
      details={
        shown && (
          <p className="rounded-[10px] border border-line bg-bg-deep/60 px-3 py-2 font-mono text-[12px] text-text-muted">
            {shown.url}
          </p>
        )
      }
    />
  );
}
