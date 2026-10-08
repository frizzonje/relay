'use client';

import type { Server } from '@relay/shared';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DeletionCost, useDeletionStats } from '@/components/servers/deletion';
import { deleteServer, serverStats } from '@/lib/servers';
import { useT } from '@/lib/i18n';

export type DeleteServerTarget = Pick<Server, 'id' | 'name'>;

/**
 * Подтверждение удаления сервера. Спрашиваем всегда — сервер уносит все свои
 * каналы и переписку сразу у всех участников, и «промахнулся мышью» тут стоит
 * дороже, чем в канале.
 *
 * Как и у каналов, диалог на открытии спрашивает у сервера живой срез
 * (`server-stats`) и показывает цену решения: сколько каналов и сообщений
 * исчезнет и сколько человек сейчас в эфирах этого сервера. Занятый эфир —
 * запрет, а не предупреждение: сервер уносит свои каналы разом, то есть
 * выбросил бы из разговора всех сразу, и отказывает ровно как отказывает
 * удалению занятого канала.
 *
 * Права на удаление — только у создателя (B2 в pre-1.0-audit), поэтому кнопка
 * в сайдбаре видна только ему; диалог держит те же правила.
 */
export function DeleteServerDialog({
  target,
  onOpenChange,
}: {
  target: DeleteServerTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const { stats, busy, setBusy, shown } = useDeletionStats(target, serverStats);

  // Пока в эфирах сервера кто-то есть — сервер откажет (occupied), и кнопку мы
  // не предлагаем: отключённая с объяснением честнее отказа после клика.
  const blocked = (stats?.occupants ?? 0) > 0;

  async function confirm() {
    if (!target || blocked) return;
    setBusy(true);
    const ok = await deleteServer(target.id);
    setBusy(false);
    // Отказ сервера уже показан тостом (lib/servers) — диалог оставляем
    // открытым, чтобы человек видел, о каком сервере речь.
    if (ok) onOpenChange(false);
  }

  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={onOpenChange}
      title={t('server.delete.title', { name: shown?.name ?? '' })}
      description={t('server.delete.body')}
      confirmLabel={t(blocked ? 'deleteServer.busy' : 'deleteServer.submit')}
      busy={busy}
      confirmDisabled={blocked || !stats}
      onConfirm={() => void confirm()}
      details={
        shown && (
          <DeletionCost
            stats={stats}
            counting={t('deleteServer.counting')}
            blocked={
              blocked ? (s) => t('deleteServer.occupied', { count: s.occupants }) : undefined
            }
            lines={(s) => [
              s.channels > 0 && t('deleteServer.channels', { count: s.channels }),
              s.messages > 0 && t('deleteServer.messages', { count: s.messages }),
            ]}
          />
        )
      }
    />
  );
}
