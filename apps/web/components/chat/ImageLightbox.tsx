'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/ui/icon';
import { useT } from '@/lib/i18n';

const MIN_SCALE = 1;
const MAX_SCALE = 6;
const DBLCLICK_SCALE = 2.5;
const STEP = 0.5;

/** Иконка-кнопка тулбара — в стиле CtlBtn голосовой панели. */
function ToolBtn({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'grid h-9 w-9 place-items-center rounded-[10px] text-text-muted outline-none transition-colors',
        'hover:bg-bg-active hover:text-text focus-visible:ring-2 focus-visible:ring-line-strong',
        'disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-muted',
        danger && 'hover:!bg-danger/15 hover:!text-danger',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Полноэкранный просмотр картинки из чата в стиле relay: плоские панели с тонкой
 * рамкой, моно-подпись с именем и размерами. Зум колесом/кнопками/двойным кликом
 * (к точке под курсором), панорамирование перетаскиванием, скачивание. Закрытие —
 * Esc, крестик или клик по фону. На Radix Dialog (фокус-трап, скролл-лок, портал).
 */
export function ImageLightbox({
  src,
  alt,
  downloadName,
  sizeLabel,
  open,
  onOpenChange,
}: {
  src: string;
  alt: string;
  downloadName?: string;
  sizeLabel?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    id: number;
    startX: number;
    startY: number;
    baseTx: number;
    baseTy: number;
  } | null>(null);

  const reset = useCallback(() => {
    setScale(1);
    setTx(0);
    setTy(0);
  }, []);

  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  // Зум относительно точки (cx, cy) на экране — точка под курсором остаётся на
  // месте. Модель: transform-origin по центру, translate двигает центр.
  const zoomAt = useCallback((nextScaleRaw: number, cx: number, cy: number) => {
    const el = containerRef.current;
    if (!el) return;
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScaleRaw));
    setScale((prev) => {
      if (next === prev) return prev;
      const rect = el.getBoundingClientRect();
      const lx = rect.left + rect.width / 2;
      const ly = rect.top + rect.height / 2;
      setTx((prevTx) => {
        const localX = (cx - (lx + prevTx)) / prev;
        return next <= MIN_SCALE ? 0 : cx - lx - localX * next;
      });
      setTy((prevTy) => {
        const localY = (cy - (ly + prevTy)) / prev;
        return next <= MIN_SCALE ? 0 : cy - ly - localY * next;
      });
      return next;
    });
  }, []);

  const centerZoom = useCallback(
    (delta: number) => zoomAt(scale + delta, window.innerWidth / 2, window.innerHeight / 2),
    [scale, zoomAt],
  );

  const onWheel = useCallback(
    (e: ReactWheelEvent) => {
      e.preventDefault();
      zoomAt(scale * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    },
    [scale, zoomAt],
  );

  const onDoubleClick = useCallback(
    (e: ReactMouseEvent) => {
      if (scale > 1) reset();
      else zoomAt(DBLCLICK_SCALE, e.clientX, e.clientY);
    },
    [scale, zoomAt, reset],
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (scale <= 1 || e.button !== 0) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      drag.current = {
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        baseTx: tx,
        baseTy: ty,
      };
    },
    [scale, tx, ty],
  );

  const onPointerMove = useCallback((e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    setTx(d.baseTx + (e.clientX - d.startX));
    setTy(d.baseTy + (e.clientY - d.startY));
  }, []);

  const endDrag = useCallback((e: ReactPointerEvent) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  }, []);

  const zoomed = scale > 1;
  const pct = Math.round(scale * 100);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="lbx-overlay fixed inset-0 z-[70]"
          style={{ background: 'rgba(6,7,9,0.94)', backdropFilter: 'blur(6px)' }}
        />
        <DialogPrimitive.Content
          aria-label={alt || t('lightbox.aria')}
          aria-describedby={undefined}
          className="fixed inset-0 z-[70] focus:outline-none"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {/* Сцена: клик по фону закрывает; по картинке — нет (проверяем target). */}
          <div
            ref={containerRef}
            className="absolute inset-0 flex items-center justify-center overflow-hidden"
            onWheel={onWheel}
            onPointerDown={(e) => {
              if (e.target === e.currentTarget) onOpenChange(false);
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={alt}
              draggable={false}
              onLoad={(e) =>
                setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
              }
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onDoubleClick={onDoubleClick}
              style={{
                transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
                transition: drag.current ? 'none' : 'transform 0.14s cubic-bezier(0.16, 1, 0.3, 1)',
                cursor: zoomed ? (drag.current ? 'grabbing' : 'grab') : 'zoom-in',
                touchAction: 'none',
              }}
              className="lbx-img-in max-h-[90vh] max-w-[92vw] select-none rounded-[12px] object-contain shadow-[0_30px_90px_rgba(0,0,0,0.7)] ring-1 ring-line-strong"
            />
          </div>

          {/* Подпись слева сверху: имя файла + размеры/вес (моно, как таймстампы). */}
          <div className="lbx-chrome pointer-events-none absolute left-4 top-4 flex max-w-[46vw] items-center gap-2.5 rounded-[10px] border border-line bg-bg-panel/90 px-3 py-2 shadow-[0_16px_50px_rgba(0,0,0,0.6)] backdrop-blur">
            <Icon name="image" className="shrink-0 text-[16px] text-text-faint" />
            <span className="truncate font-mono text-[12px] text-text">
              {alt || t('lightbox.image')}
            </span>
            {(dims || sizeLabel) && (
              <span className="shrink-0 font-mono text-[11px] text-text-faint">
                {dims ? `${dims.w}×${dims.h}` : ''}
                {dims && sizeLabel ? ' · ' : ''}
                {sizeLabel ?? ''}
              </span>
            )}
          </div>

          {/* Тулбар справа сверху: зум ± со счётчиком, сброс | скачать · закрыть. */}
          <div className="lbx-chrome absolute right-4 top-4 flex items-center gap-0.5 rounded-[12px] border border-line bg-bg-panel/90 p-1 shadow-[0_16px_50px_rgba(0,0,0,0.6)] backdrop-blur">
            <ToolBtn
              label={t('lightbox.zoomOut')}
              onClick={() => centerZoom(-STEP)}
              disabled={!zoomed}
            >
              <Icon name="zoom-out" className="text-[18px]" />
            </ToolBtn>
            <span className="min-w-[3.4rem] select-none text-center font-mono text-[11px] tabular-nums text-text-muted">
              {pct}%
            </span>
            <ToolBtn
              label={t('lightbox.zoomIn')}
              onClick={() => centerZoom(STEP)}
              disabled={scale >= MAX_SCALE}
            >
              <Icon name="zoom-in" className="text-[18px]" />
            </ToolBtn>
            <ToolBtn label={t('lightbox.zoomReset')} onClick={reset} disabled={!zoomed}>
              <Icon name="rotate-ccw" className="text-[18px]" />
            </ToolBtn>
            <span className="mx-1 h-5 w-px bg-line-strong" />
            <a
              href={src}
              download={downloadName || alt || true}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t('lightbox.download')}
              title={t('lightbox.download')}
              className="grid h-9 w-9 place-items-center rounded-[10px] text-text-muted outline-none transition-colors hover:bg-bg-active hover:text-text focus-visible:ring-2 focus-visible:ring-line-strong"
            >
              <Icon name="download" className="text-[18px]" />
            </a>
            <ToolBtn label={t('common.close')} onClick={() => onOpenChange(false)} danger>
              <Icon name="x" className="text-[18px]" />
            </ToolBtn>
          </div>

          {/* Подсказка снизу — гаснет через пару секунд (lbx-hint). */}
          <div className="lbx-hint pointer-events-none absolute inset-x-0 bottom-5 flex justify-center">
            <span className="rounded-full border border-line bg-bg-panel/80 px-3 py-1 font-mono text-[11px] text-text-faint backdrop-blur">
              {t('lightbox.hint')}
            </span>
          </div>

          <DialogPrimitive.Title className="sr-only">
            {alt || t('lightbox.title')}
          </DialogPrimitive.Title>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
