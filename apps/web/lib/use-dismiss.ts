'use client';

import { useEffect, useRef, type RefObject } from 'react';

/**
 * Закрыть всплывашку по щелчку мимо неё и по Escape.
 *
 * Логика была скопирована в пяти местах (пикер реакций, меню «⋯», выбор
 * микрофона, выбор динамиков, громкость собеседника), и копии успели разойтись:
 * в чате меню не закрывалось по Escape вовсе — из открытого пикера не было
 * выхода с клавиатуры.
 *
 * Слушаем `pointerdown`, а не `mousedown`: на телефоне синтетический mousedown
 * приходит не всегда и не сразу, и меню оставалось висеть после тапа мимо.
 *
 * `inside` — всё, щелчок по чему закрытием не считается: сама панель и её
 * кнопка-триггер, если они не в одной обёртке. Ссылки читаются в момент
 * события, поэтому список не обязан быть стабильным между рендерами.
 */
export function useDismiss(
  open: boolean,
  onDismiss: () => void,
  ...inside: RefObject<HTMLElement | null>[]
) {
  // Свежие колбэк и список — чтобы обработчики вешались один раз на открытие,
  // а не переподписывались на каждый рендер родителя.
  const latest = useRef({ onDismiss, inside });
  latest.current = { onDismiss, inside };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (latest.current.inside.some((ref) => ref.current?.contains(target))) return;
      latest.current.onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') latest.current.onDismiss();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
}
