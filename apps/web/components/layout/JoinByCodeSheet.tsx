'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useUiStore } from '@/stores/ui';
import { joinVoice } from '@/lib/voice';
import { codeToSlug } from '@/lib/join-code';

/**
 * Мобильный bottom sheet быстрого входа по коду/ссылке. Даёт то же, что лобби на
 * десктопе, но доступно из любой панели (кнопка в списке каналов) — не нужно
 * искать канал в сайдбаре. Только мобильный (`md:hidden`): на десктопе для этого
 * есть само лобби. Открытие/закрытие — через ui-стор (`joinByCodeOpen`).
 */
export function JoinByCodeSheet() {
  const open = useUiStore((s) => s.joinByCodeOpen);
  const setOpen = useUiStore((s) => s.setJoinByCodeOpen);
  const [code, setCode] = useState('');

  // Esc закрывает; сбрасываем поле при каждом открытии.
  useEffect(() => {
    if (!open) return;
    setCode('');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const slug = codeToSlug(code);
    if (!slug) return;
    setOpen(false);
    void joinVoice(slug, code.trim());
  }

  return (
    <div
      className="fixed inset-0 z-50 md:hidden"
      role="dialog"
      aria-modal="true"
      aria-label="Войти по коду"
    >
      {/* Затемнение — тап закрывает */}
      <button
        aria-label="Закрыть"
        onClick={() => setOpen(false)}
        className="absolute inset-0 h-full w-full bg-black/60 backdrop-blur-[2px]"
      />
      <form
        onSubmit={onSubmit}
        className="absolute inset-x-0 bottom-0 flex flex-col gap-3 rounded-t-[18px] border-t border-line bg-bg-panel px-5 pb-[calc(20px+env(safe-area-inset-bottom))] pt-3 shadow-[0_-16px_50px_rgba(0,0,0,0.6)]"
      >
        {/* Ручка-грабер */}
        <span aria-hidden className="mx-auto h-1 w-9 rounded-full bg-line-strong" />
        <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-faint">
          быстрый вход
        </div>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="ссылка или код канала"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          className="w-full rounded-[10px] border border-line bg-bg-elev px-3.5 py-3 font-mono text-[15px] text-text outline-none transition placeholder:text-text-faint focus:border-line-strong focus:ring-1 focus:ring-line-strong"
        />
        <button
          type="submit"
          disabled={!code.trim()}
          className="w-full rounded-[10px] bg-accent-strong px-3 py-3 text-[15px] font-semibold text-bg-app transition active:translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Присоединиться
        </button>
      </form>
    </div>
  );
}
