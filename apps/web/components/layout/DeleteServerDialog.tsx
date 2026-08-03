'use client';

import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { deleteServer, serverStats } from '@/lib/servers';
import { useT } from '@/lib/i18n';

export interface DeleteServerTarget {
  id: string;
  name: string;
}

type Stats = { channels: number; messages: number };

/**
 * Подтверждение удаления сервера. Спрашиваем всегда — сервер уносит все свои
 * каналы и переписку сразу у всех участников, и «промахнулся мышью» тут стоит
 * дороже, чем в канале.
 *
 * Как и у каналов, диалог на открытии спрашивает у сервера живой срез
 * (`server-stats`) и показывает цену решения: сколько каналов и сообщений
 * исчезнет. Права на удаление — только у создателя (B2 в pre-1.0-audit),
 * поэтому кнопка в сайдбаре видна только ему; диалог держит те же правила.
 */
export function DeleteServerDialog({
  target,
  onOpenChange,
}: {
  target: DeleteServerTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const [stats, setStats] = useState<Stats | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!target) return;
    setStats(null);
    setBusy(false);
    let alive = true;
    void serverStats(target.id).then((s) => {
      if (alive) setStats(s);
    });
    return () => {
      alive = false;
    };
  }, [target]);

  // Диалог закрывается с анимацией, а `target` обнуляется сразу — держим
  // последний, иначе на выходе мелькнёт «Удалить сервер «»?».
  const last = useRef<DeleteServerTarget | null>(null);
  if (target) last.current = target;
  const shown = target ?? last.current;

  async function confirm() {
    if (!target) return;
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
      confirmLabel={t('deleteServer.submit')}
      busy={busy}
      confirmDisabled={!stats}
      onConfirm={() => void confirm()}
      details={<Details target={shown} stats={stats} />}
    />
  );
}

/** Цена решения: что именно исчезнет. До ответа сервера — честное «считаем». */
function Details({ target, stats }: { target: DeleteServerTarget | null; stats: Stats | null }) {
  const t = useT();
  if (!target) return null;

  if (!stats) {
    return (
      <p className="rounded-lg border border-line bg-bg-deep/60 px-3 py-2.5 text-[13px] text-text-muted">
        {t('deleteServer.counting')}
      </p>
    );
  }

  const lines: string[] = [];
  if (stats.channels > 0) lines.push(t('deleteServer.channels', { count: stats.channels }));
  if (stats.messages > 0) lines.push(t('deleteServer.messages', { count: stats.messages }));
  if (!lines.length) return null;

  return (
    <ul className="flex flex-col gap-1 rounded-lg border border-line bg-bg-deep/60 px-3 py-2.5 text-[13px] leading-snug text-text-muted">
      {lines.map((line) => (
        <li key={line} className="flex gap-2">
          <span aria-hidden className="text-text-faint">
            —
          </span>
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}
