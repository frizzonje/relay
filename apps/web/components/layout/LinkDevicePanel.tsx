'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatPairCode, pairLink } from '@relay/shared';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { askPairing, DeviceError, type DeviceFailure } from '@/lib/devices';
import { whoAmI } from '@/lib/identity-login';
import { qrPath } from '@/lib/qr';
import { useIdentityStore } from '@/stores/identity';
import { useT } from '@/lib/i18n';
import { failureText } from './pair-failure';

/**
 * Экран того, кто просится: «я новое устройство, впустите меня».
 *
 * Код показывает именно новичок — и это не вкусовщина. Показывай его тот, кто
 * уже внутри, код был бы пропуском на предъявителя: увидел чужой экран — вошёл
 * в чужую личность. Здесь наоборот: код говорит «вот мой ключ», а ответить на
 * него может только тот, кто в личности уже есть.
 *
 * Того же экрана два входа: первый вход (человек поставил приложение и у него
 * уже есть личность в браузере) и панель устройств. Поэтому содержимое —
 * отдельно от диалога: в первом случае оно живёт внутри чужого окна.
 */

/** Как часто спрашиваем сервер, не впустили ли нас. */
const POLL_MS = 2000;

type Phase =
  | { kind: 'asking' }
  | { kind: 'showing'; code: string; deadline: number }
  | { kind: 'expired' }
  | { kind: 'linked' }
  | { kind: 'failed'; reason: DeviceFailure };

export function LinkDevicePanel({ onClose }: { onClose?: () => void }) {
  const t = useT();
  const myId = useIdentityStore((s) => s.me?.id);
  const [phase, setPhase] = useState<Phase>({ kind: 'asking' });
  const [left, setLeft] = useState(0);
  // Личность на момент открытия экрана: с ней и сравниваем. Читаем в ref, чтобы
  // опрос не перезапускался от каждого обновления стора.
  const before = useRef(myId);

  const request = useCallback(async () => {
    setPhase({ kind: 'asking' });
    try {
      const { code, expiresIn } = await askPairing();
      setPhase({ kind: 'showing', code, deadline: Date.now() + expiresIn });
    } catch (err) {
      setPhase({
        kind: 'failed',
        reason: err instanceof DeviceError ? err.reason : 'network',
      });
    }
  }, []);

  useEffect(() => {
    void request();
  }, [request]);

  // Обратный отсчёт и смерть кода. Секунды считаем от своих часов: сервер
  // прислал длительность, а не метку, — расхождение часов тут ни при чём.
  useEffect(() => {
    if (phase.kind !== 'showing') return;
    const tick = () => {
      const ms = phase.deadline - Date.now();
      setLeft(Math.max(0, ms));
      if (ms <= 0) setPhase({ kind: 'expired' });
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [phase]);

  /**
   * Ждём, пока нас впустят. Спрашиваем «кто я»: как только устройство переехало
   * в чужую личность, наша сессия перестаёт сходиться — сервер отвечает «никто».
   * Это и есть сигнал, и другого не нужно.
   */
  useEffect(() => {
    if (phase.kind !== 'showing') return;
    let alive = true;
    const timer = setInterval(async () => {
      const me = await whoAmI().catch(() => null);
      if (!alive) return;
      if (me && me.id === before.current) return;
      setPhase({ kind: 'linked' });
      // Перезагрузка, а не тихое обновление стора: за старой личностью тянутся
      // сокет, лента и состав каналов, и собирать их заново по кусочку — это
      // десяток мест, каждое из которых однажды забудут.
      setTimeout(() => location.reload(), 1200);
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [phase]);

  const link = useMemo(
    () =>
      phase.kind === 'showing' && typeof window !== 'undefined'
        ? pairLink(window.location.origin, phase.code)
        : '',
    [phase],
  );

  return (
    <div className="px-7 pb-6 pt-6 text-center">
      <DialogTitle className="text-xl">{t('pair.link.title')}</DialogTitle>
      <DialogDescription className="mx-auto mt-1.5 max-w-[320px] text-[13px] leading-relaxed">
        {phase.kind === 'linked' ? t('pair.link.done') : t('pair.link.body')}
      </DialogDescription>

      {phase.kind === 'showing' && (
        <>
          <div className="mt-5 grid place-items-center">
            <Qr text={link} />
          </div>
          <p className="mt-4 select-all font-mono text-[26px] font-semibold tracking-[0.18em] text-text-header">
            {formatPairCode(phase.code)}
          </p>
          <p className="mt-1 text-[12px] text-text-muted">
            {t('pair.link.expires', { time: clock(left) })}
          </p>
          <p className="mt-4 text-[11px] leading-snug text-text-muted opacity-70">
            {t('pair.link.waiting')}
          </p>
        </>
      )}

      {phase.kind === 'expired' && (
        <>
          <p className="mt-5 text-[13px] leading-relaxed text-text-muted">{t('pair.link.gone')}</p>
          <Button
            variant="primary"
            size="lg"
            className="mt-4 w-full"
            onClick={() => void request()}
          >
            {t('pair.link.again')}
          </Button>
        </>
      )}

      {phase.kind === 'failed' && (
        <>
          <p className="mt-5 text-[13px] leading-relaxed text-danger">
            {t(failureText(phase.reason))}
          </p>
          {phase.reason !== 'has-history' && (
            <Button
              variant="primary"
              size="lg"
              className="mt-4 w-full"
              onClick={() => void request()}
            >
              {t('pair.retry')}
            </Button>
          )}
        </>
      )}

      {phase.kind === 'linked' && <div className="mt-6 text-4xl">🔗</div>}

      {onClose && phase.kind !== 'linked' && (
        <button
          type="button"
          onClick={onClose}
          className="mt-4 rounded-[8px] px-3 py-2 text-[13px] text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text"
        >
          {t('common.close')}
        </button>
      )}
    </div>
  );
}

/** Тот же экран, но своим окном: из панели устройств. */
export function LinkDeviceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[420px] overflow-hidden p-0">
        <LinkDevicePanel onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Сам код на экране. Светлый квадрат под ним нарисован намеренно: в тёмной теме
 * QR цвета темы не читается ни одной камерой — сканеру нужен контраст, а не
 * стиль.
 */
function Qr({ text }: { text: string }) {
  const { size, path } = useMemo(() => qrPath(text), [text]);
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="h-[188px] w-[188px] rounded-xl bg-white p-0 shadow-[0_6px_18px_rgba(0,0,0,0.35)]"
      role="img"
      aria-hidden
    >
      <path d={path} fill="#000" shapeRendering="crispEdges" />
    </svg>
  );
}

/** `2:59` — минуты и секунды, без словаря: цифры одинаковы во всех языках. */
function clock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
