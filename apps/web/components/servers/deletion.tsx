'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Общее у удаления канала и сервера. Оба диалога на открытии спрашивают у
 * сервера живой срез и показывают цену решения — что исчезнет и кто сейчас
 * внутри; занятый эфир у обоих — запрет, а не предупреждение.
 */

/**
 * Срез цели, спрошенный на открытии диалога, и сама цель для показа.
 *
 * `shown` — последняя цель, а не текущая: диалог закрывается с анимацией, а
 * `target` обнуляется сразу, и без неё на выходе мелькнул бы заголовок с
 * пустым именем. Ответ, пришедший после закрытия или смены цели, не пишется.
 */
export function useDeletionStats<T extends { id: string }, S>(
  target: T | null,
  ask: (id: string) => Promise<S | null>,
) {
  const [stats, setStats] = useState<S | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!target) return;
    setStats(null);
    setBusy(false);
    let alive = true;
    void ask(target.id).then((s) => {
      if (alive) setStats(s);
    });
    return () => {
      alive = false;
    };
  }, [target, ask]);

  const last = useRef<T | null>(null);
  if (target) last.current = target;
  return { stats, busy, setBusy, shown: target ?? last.current };
}

/**
 * Цена решения. До ответа сервера — честное «считаем» (`counting`), занятый
 * эфир — запрет (`blocked`), иначе — что именно исчезнет (`lines`; ложные
 * строки пропускаются, так удобнее писать условия).
 */
export function DeletionCost<S>({
  stats,
  counting,
  blocked,
  lines,
}: {
  stats: S | null;
  counting: string;
  blocked?: (stats: S) => string;
  lines: (stats: S) => (string | false)[];
}) {
  if (!stats) {
    return (
      <p className="rounded-lg border border-line bg-bg-deep/60 px-3 py-2.5 text-[13px] text-text-muted">
        {counting}
      </p>
    );
  }
  if (blocked) {
    return (
      <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-[13px] leading-snug text-danger">
        {blocked(stats)}
      </p>
    );
  }
  const shown = lines(stats).filter((line): line is string => !!line);
  if (!shown.length) return null;
  return (
    <ul className="flex flex-col gap-1 rounded-lg border border-line bg-bg-deep/60 px-3 py-2.5 text-[13px] leading-snug text-text-muted">
      {shown.map((line) => (
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
