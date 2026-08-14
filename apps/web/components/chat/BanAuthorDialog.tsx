'use client';

import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@relay/shared';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Identicon } from '@/components/ui/Identicon';
import { banAuthor } from '@/lib/moderation';
import { useT, type MessageKey } from '@/lib/i18n';

/** Кого и как далеко банят. `everywhere` — вся инсталляция вместо сервера. */
export interface BanTarget {
  message: ChatMessage;
  everywhere: boolean;
  /** Имя сервера — оно и есть охват, который человек должен увидеть. */
  server: string;
}

/**
 * Подтверждение бана.
 *
 * Спрашиваем всегда и показываем, кого именно: реплик на экране много,
 * промахнуться курсором — обычное дело, а бан выкидывает человека из разговора
 * немедленно, посреди фразы.
 *
 * Охват назван словами, а не флажком: «с этого сервера» и «со всей
 * инсталляции» — разные поступки, и первый не должен незаметно становиться
 * вторым. Отказ сервера показываем прямо здесь: у бана нет отката, и «нажал,
 * ничего не произошло» — худший из ответов.
 */
const FAILURE: Record<string, MessageKey> = {
  forbidden: 'moderation.ban.fail.forbidden',
  'not-found': 'moderation.ban.fail.notFound',
  unknown: 'moderation.ban.fail.notFound',
};

export function BanAuthorDialog({
  target,
  onOpenChange,
}: {
  target: BanTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);

  // Диалог закрывается с анимацией, а target обнуляется сразу — держим
  // последний, иначе на выходе мелькнёт пустая цитата.
  const last = useRef<BanTarget | null>(null);
  if (target) last.current = target;
  const shown = target ?? last.current;

  useEffect(() => {
    if (target) setError(null);
  }, [target]);

  async function confirm() {
    if (!target?.message.id) return;
    setBusy(true);
    const res = await banAuthor(target.message.id, target.everywhere);
    setBusy(false);
    if (res.ok) {
      onOpenChange(false);
      return;
    }
    setError(FAILURE[res.error] ?? 'moderation.ban.fail.notFound');
  }

  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={onOpenChange}
      busy={busy}
      title={t('moderation.ban.confirm', { name: shown?.message.name ?? '' })}
      description={
        shown?.everywhere
          ? t('moderation.ban.body.everywhere')
          : t('moderation.ban.body.server', { server: shown?.server ?? '' })
      }
      confirmLabel={t('moderation.ban.action')}
      details={
        shown && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 rounded-[10px] border border-line bg-bg-deep/60 px-3 py-2">
              {shown.message.fingerprint && (
                <Identicon fingerprint={shown.message.fingerprint} size={22} />
              )}
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold text-text-header">
                  {shown.message.name}
                </div>
                <div className="max-h-10 overflow-hidden text-[13px] leading-snug text-text-muted">
                  {shown.message.text || t('chat.attachment')}
                </div>
              </div>
            </div>
            <p className="text-[12px] leading-snug text-text-muted">{t('moderation.ban.warn')}</p>
            {error && <p className="text-[13px] leading-snug text-danger">{t(error)}</p>}
          </div>
        )
      }
      onConfirm={() => void confirm()}
    />
  );
}
