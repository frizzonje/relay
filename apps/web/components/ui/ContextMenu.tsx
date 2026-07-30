'use client';

import type { ReactNode } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { openContextMenu } from '@/lib/context-menu';
import {
  isSeparator,
  useContextMenuStore,
  type MenuAction,
  type MenuIcon,
  type OpenMenu,
} from '@/stores/context-menu';
import { useT } from '@/lib/i18n';

/**
 * Контекстное меню relay: одно на всё приложение.
 *
 * Держит два конца задачи — глушит меню движка на `contextmenu` документа и
 * рисует своё, в языке интерфейса (тёмная панель, тонкая рамка, моно-подсказки
 * клавиш). Начинка — в lib/context-menu.ts.
 *
 * Уговор с экранами: кто хочет свои пункты, зовёт `openContextMenu(e, …)` —
 * тот ставит событию preventDefault, и общий обработчик отсюда в это событие
 * уже не лезет.
 *
 * Чего сознательно не делаем:
 *   • не перехватываем долгий тап (pointerType === 'touch') — там системное
 *     меню часть выделения текста, своим мы бы только мешали;
 *   • Shift+ПКМ пропускаем к браузеру: на вебе нужны «перевести страницу»,
 *     «сохранить как» и инспектор.
 */

const ITEM =
  'flex h-[30px] w-full cursor-default items-center justify-between gap-6 rounded-[7px] px-2.5 text-left text-[13px] leading-none transition-colors duration-75';

// ── Значки пунктов ──────────────────────────────────────────────────────────
// Один контур на пункт (Feather, strokeWidth 2), покрашенный currentColor:
// подсвеченный пункт и красное «Удалить» тянут значок за собой сами.
const GLYPHS: Record<MenuIcon, ReactNode> = {
  copy: (
    <>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  cut: (
    <>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <line x1="20" y1="4" x2="8.12" y2="15.88" />
      <line x1="14.47" y1="14.48" x2="20" y2="20" />
      <line x1="8.12" y1="8.12" x2="12" y2="12" />
    </>
  ),
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </>
  ),
  edit: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </>
  ),
  'link-open': (
    <>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </>
  ),
  paste: (
    <>
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <rect x="8" y="2" width="8" height="4" rx="1" />
    </>
  ),
  refresh: (
    <>
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </>
  ),
  reply: (
    <>
      <polyline points="9 17 4 12 9 7" />
      <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
    </>
  ),
  'select-all': (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" strokeDasharray="4 3" />
      <line x1="7" y1="9" x2="17" y2="9" />
      <line x1="7" y1="13" x2="17" y2="13" />
      <line x1="7" y1="17" x2="13" y2="17" />
    </>
  ),
  settings: (
    <>
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </>
  ),
  trash: (
    <>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </>
  ),
};

function Glyph({ name }: { name: MenuIcon }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      {GLYPHS[name]}
    </svg>
  );
}

export function ContextMenu() {
  const t = useT();
  const menu = useContextMenuStore((s) => s.menu);
  const close = useContextMenuStore((s) => s.close);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null);
  const [active, setActive] = useState(-1);

  // ── Перехват ПКМ на документе ────────────────────────────────────────────
  useEffect(() => {
    // Тип последнего указателя: contextmenu сам по себе не отличает мышь от
    // долгого тапа (кнопка/detail врут в разных движках).
    let touch = false;
    const onPointer = (e: PointerEvent) => {
      touch = e.pointerType === 'touch';
    };
    const onContextMenu = (e: MouseEvent) => {
      if (e.defaultPrevented) return; // экран уже показал своё меню
      if (e.shiftKey || touch) return; // аварийный выход к меню движка
      openContextMenu(e);
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('contextmenu', onContextMenu);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('contextmenu', onContextMenu);
    };
  }, []);

  // Новое меню — подсветка снимается (стрелки пойдут с начала списка).
  useEffect(() => setActive(-1), [menu]);

  /**
   * Позиция панели — в два прохода, оба до отрисовки (layout-эффект), поэтому
   * прыжка не видно: сперва ставим меню в точку курсора (без узла в DOM нечего
   * мерить), потом, зная размер, прижимаем к экрану — у края меню раскрывается
   * в другую сторону, а не уезжает под обрез окна.
   */
  const measured = useRef<OpenMenu | null>(null);
  useLayoutEffect(() => {
    if (!menu) {
      measured.current = null;
      setPos(null);
      return;
    }
    if (!pos) {
      setPos({ left: menu.x, top: menu.y, origin: 'top left' });
      return;
    }
    const el = ref.current;
    if (!el || measured.current === menu) return; // это меню уже прижато
    measured.current = menu;
    const { offsetWidth: w, offsetHeight: h } = el;
    const pad = 8;
    const flipX = menu.x + w + pad > window.innerWidth;
    const flipY = menu.y + h + pad > window.innerHeight;
    setPos({
      left: Math.max(pad, flipX ? menu.x - w : menu.x),
      top: Math.max(pad, flipY ? menu.y - h : menu.y),
      origin: `${flipY ? 'bottom' : 'top'} ${flipX ? 'right' : 'left'}`,
    });
  }, [menu, pos]);

  // Живые пункты (без разделителей и отключённых) — по ним ходят стрелки.
  const actions = useMemo(
    () => menu?.entries.filter((e): e is MenuAction => !isSeparator(e) && !e.disabled) ?? [],
    [menu],
  );

  // Хоть один значок в меню — столбец под значки держим у всех пунктов, иначе
  // подписи разъезжаются по левому краю.
  const iconColumn = useMemo(() => !!menu?.entries.some((e) => !isSeparator(e) && e.icon), [menu]);

  const run = useCallback(
    (item: MenuAction) => {
      close();
      void item.run();
    },
    [close],
  );

  // ── Закрытие и клавиатура ────────────────────────────────────────────────
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      const step = (d: number) => {
        e.preventDefault();
        setActive((i) => {
          if (!actions.length) return -1;
          if (i < 0) return d > 0 ? 0 : actions.length - 1; // первый вход в список
          return (i + d + actions.length) % actions.length;
        });
      };
      if (e.key === 'Escape') {
        e.preventDefault();
        // Дальше не пускаем: Escape закрывает меню, а не диалог под ним.
        e.stopPropagation();
        close();
      } else if (e.key === 'ArrowDown') step(1);
      else if (e.key === 'ArrowUp') step(-1);
      else if (e.key === 'Enter' || e.key === ' ') {
        const item = actions[active];
        if (!item) return;
        e.preventDefault();
        run(item);
      } else if (e.key === 'Tab') close();
    };
    // Колесо и уход фокуса — меню больше не к месту (оно прибито к точке щелчка).
    const onScroll = () => close();
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('wheel', onScroll, { passive: true });
    window.addEventListener('blur', onScroll);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('wheel', onScroll);
      window.removeEventListener('blur', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [menu, close, actions, active, run]);

  return (
    <AnimatePresence>
      {menu && pos && (
        <motion.div
          ref={ref}
          role="menu"
          aria-label={menu.label ?? t('common.actions')}
          initial={{ opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.09 } }}
          transition={{ duration: 0.13, ease: [0.16, 1, 0.3, 1] }}
          style={{ left: pos.left, top: pos.top, transformOrigin: pos.origin }}
          // Меню живёт вне дерева радикс-диалогов, поэтому берём на себя две
          // их привычки: pointer-events-auto — модалка гасит указатель всему
          // вне себя; stopPropagation на pointerdown — иначе щелчок по пункту
          // читается диалогом как «клик мимо» и закрывает его.
          onPointerDown={(e) => e.stopPropagation()}
          // Фокус остаётся там, где был: иначе поле ввода потеряет выделение,
          // и «Вырезать»/«Вставить» будут не о чем.
          onMouseDown={(e) => e.preventDefault()}
          // Панель как у остальных всплывашек (glass-3), но радиус и тень —
          // меню: компактнее карточки, зато отчётливо «над» интерфейсом.
          className="glass glass-3 pointer-events-auto fixed z-[200] min-w-[204px] max-w-[300px] rounded-[11px] border-line-strong p-1 shadow-[0_18px_44px_rgba(0,0,0,0.6)]"
        >
          {menu.label && (
            <div className="truncate px-2.5 pb-1.5 pt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-text-faint">
              {menu.label}
            </div>
          )}
          {menu.entries.map((entry) =>
            isSeparator(entry) ? (
              <div key={entry.id} className="my-1 h-px bg-line" />
            ) : (
              <button
                key={entry.id}
                type="button"
                role="menuitem"
                disabled={entry.disabled}
                onMouseEnter={() => setActive(actions.indexOf(entry))}
                onClick={() => run(entry)}
                className={cn(
                  ITEM,
                  entry.disabled && 'text-text-faint',
                  !entry.disabled && (entry.danger ? 'text-danger' : 'text-text'),
                  !entry.disabled &&
                    actions[active] === entry &&
                    (entry.danger ? 'bg-danger/15' : 'bg-white/[0.07] text-text-header'),
                )}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  {iconColumn &&
                    (entry.icon ? (
                      <Glyph name={entry.icon} />
                    ) : (
                      <span className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    ))}
                  <span className="truncate">{entry.label}</span>
                </span>
                {entry.hint && (
                  <span className="shrink-0 font-mono text-[10.5px] tracking-tight text-text-faint">
                    {entry.hint}
                  </span>
                )}
              </button>
            ),
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
