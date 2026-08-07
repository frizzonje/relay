'use client';

import { useRef } from 'react';
import type { VoiceMode } from '@relay/shared';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { setChannelMode } from '@/lib/channels';
import { useT } from '@/lib/i18n';

export interface ChannelModeTarget {
  id: string;
  name: string;
  /** Режим, в который переключаем (не текущий). */
  next: VoiceMode;
  /** Сколько человек в эфире прямо сейчас — цена решения. */
  occupants: number;
}

/**
 * Подтверждение смены транспорта голосового канала. Спрашиваем всегда: кнопка
 * «P2P/SFU» стоит в строке канала рядом с обычными действиями, а стоит нажатие
 * дорого — разговор у ВСЕХ участников обрывается на время переезда, и попадает
 * это по людям, которые ничего не нажимали.
 */
export function ChannelModeDialog({
  target,
  onOpenChange,
}: {
  target: ChannelModeTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();

  // Диалог закрывается с анимацией, а `target` обнуляется сразу — держим
  // последний, иначе на выходе мелькнёт заголовок с пустым именем.
  const last = useRef<ChannelModeTarget | null>(null);
  if (target) last.current = target;
  const shown = target ?? last.current;
  const sfu = shown?.next === 'sfu';

  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={onOpenChange}
      title={t(sfu ? 'channel.mode.confirm.title.sfu' : 'channel.mode.confirm.title.p2p', {
        name: shown?.name ?? '',
      })}
      description={t(sfu ? 'channel.mode.confirm.body.sfu' : 'channel.mode.confirm.body.p2p')}
      confirmLabel={t('channel.mode.confirm.submit')}
      // Переключение обратимо — красной кнопкой не пугаем, но предупреждение
      // об обрыве показываем всегда, а при людях в эфире — их число.
      confirmVariant="primary"
      details={
        <div className="flex flex-col gap-1 rounded-lg border border-line bg-bg-deep/60 px-3 py-2.5 text-[13px] leading-snug text-text-muted">
          <p>{t('channel.mode.confirm.warning')}</p>
          {(shown?.occupants ?? 0) > 0 && (
            <p className="text-danger">
              {t('channel.mode.confirm.occupied', { count: shown?.occupants ?? 0 })}
            </p>
          )}
        </div>
      }
      onConfirm={() => {
        if (target) setChannelMode(target.id, target.next);
        onOpenChange(false);
      }}
    />
  );
}
