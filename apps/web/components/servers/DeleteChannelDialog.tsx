'use client';

import type { Channel } from '@relay/shared';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DeletionCost, useDeletionStats } from '@/components/servers/deletion';
import { channelStats, deleteChannel } from '@/lib/channels';
import { useT } from '@/lib/i18n';

export type DeleteChannelTarget = Pick<Channel, 'id' | 'name' | 'type'>;

/**
 * Подтверждение удаления канала. Спрашиваем всегда — канал пропадает сразу у
 * всех участников, и «промахнулся мышью» тут стоит дорого.
 *
 * Диалог не ограничивается вопросом: на открытии он спрашивает у сервера живой
 * срез канала (`channel-stats`) и показывает цену решения — сколько человек
 * внутри и сколько сообщений исчезнет. Голосовой канал с людьми в эфире не
 * удаляется вовсе: это правило сервера, здесь мы лишь показываем его заранее.
 */
export function DeleteChannelDialog({
  target,
  onOpenChange,
}: {
  target: DeleteChannelTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const { stats, busy, run, shown } = useDeletionStats(target, channelStats);

  const isVoice = shown?.type === 'voice';
  // Занятый эфир — запрет, а не предупреждение (сервер откажет в любом случае).
  const blocked = isVoice && (stats?.occupants ?? 0) > 0;

  async function confirm() {
    if (blocked) return;
    // Отказ сервера уже показан тостом (lib/channels) — диалог оставляем
    // открытым, чтобы человек видел, о каком канале речь.
    await run(
      ({ id }) => deleteChannel(id),
      () => onOpenChange(false),
    );
  }

  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={onOpenChange}
      title={t('deleteChannel.title', { name: shown?.name ?? '' })}
      description={t(isVoice ? 'deleteChannel.voice.body' : 'deleteChannel.text.body')}
      confirmLabel={t(blocked ? 'deleteChannel.busy' : 'deleteChannel.submit')}
      busy={busy}
      confirmDisabled={blocked || !stats}
      onConfirm={() => void confirm()}
      details={
        shown && (
          <DeletionCost
            stats={stats}
            counting={t('deleteChannel.counting')}
            blocked={
              blocked ? (s) => t('deleteChannel.occupied', { count: s.occupants }) : undefined
            }
            // У текстового канала люди не «внутри эфира», а держат его открытым,
            // и пропадёт его история; у голосового пропадать нечему.
            lines={(s) =>
              shown.type === 'text'
                ? [
                    s.occupants > 0 && t('deleteChannel.openFor', { count: s.occupants }),
                    s.messages > 0 && t('deleteChannel.history', { count: s.messages }),
                  ]
                : []
            }
          />
        )
      }
    />
  );
}
