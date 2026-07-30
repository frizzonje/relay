'use client';

import { useEffect, useRef, useState } from 'react';
import type { ChannelType } from '@relay/shared';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { channelStats, deleteChannel, plural } from '@/lib/channels';

export interface DeleteChannelTarget {
  id: string;
  name: string;
  type: ChannelType;
}

type Stats = { occupants: number; messages: number };

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
  const [stats, setStats] = useState<Stats | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!target) return;
    setStats(null);
    setBusy(false);
    let alive = true;
    void channelStats(target.id).then((s) => {
      if (alive) setStats(s);
    });
    return () => {
      alive = false;
    };
  }, [target]);

  // Диалог закрывается с анимацией, а `target` обнуляется сразу — держим
  // последний, иначе на выходе мелькнёт «Удалить канал «»?».
  const last = useRef<DeleteChannelTarget | null>(null);
  if (target) last.current = target;
  const shown = target ?? last.current;

  const isVoice = shown?.type === 'voice';
  // Занятый эфир — запрет, а не предупреждение (сервер откажет в любом случае).
  const blocked = isVoice && (stats?.occupants ?? 0) > 0;

  async function confirm() {
    if (!target || blocked) return;
    setBusy(true);
    const ok = await deleteChannel(target.id);
    setBusy(false);
    // Отказ сервера уже показан тостом (lib/channels) — диалог оставляем
    // открытым, чтобы человек видел, о каком канале речь.
    if (ok) onOpenChange(false);
  }

  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={onOpenChange}
      title={<>Удалить канал «{shown?.name}»?</>}
      description={
        isVoice
          ? 'Канал исчезнет у всех участников сервера. Отменить это нельзя.'
          : 'Канал и вся его переписка исчезнут у всех участников. Отменить это нельзя.'
      }
      confirmLabel={blocked ? 'Канал занят' : 'Удалить канал'}
      busy={busy}
      confirmDisabled={blocked || !stats}
      onConfirm={() => void confirm()}
      details={<Details target={shown} stats={stats} blocked={blocked} />}
    />
  );
}

/** Цена решения: кто внутри и что пропадёт. До ответа сервера — честное «считаем». */
function Details({
  target,
  stats,
  blocked,
}: {
  target: DeleteChannelTarget | null;
  stats: Stats | null;
  blocked: boolean;
}) {
  if (!target) return null;

  if (!stats) {
    return (
      <p className="rounded-lg border border-line bg-bg-deep/60 px-3 py-2.5 text-[13px] text-text-muted">
        Смотрим, кто сейчас в канале…
      </p>
    );
  }

  if (blocked) {
    return (
      <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-[13px] leading-snug text-danger">
        В эфире {stats.occupants} {plural(stats.occupants, 'человек', 'человека', 'человек')} —
        канал не удалить, пока разговор идёт. Дождитесь, когда все выйдут.
      </p>
    );
  }

  const lines: string[] = [];
  if (target.type === 'text') {
    if (stats.occupants > 0) {
      lines.push(
        `Канал сейчас открыт у ${stats.occupants} ${plural(stats.occupants, 'человека', 'человек', 'человек')} — лента закроется прямо на глазах.`,
      );
    }
    if (stats.messages > 0) {
      lines.push(
        `Пропадёт история: ${stats.messages} ${plural(stats.messages, 'сообщение', 'сообщения', 'сообщений')}.`,
      );
    }
  }
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
