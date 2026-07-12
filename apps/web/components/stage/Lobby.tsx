'use client';

import { useState, type FormEvent } from 'react';
import { Logo } from '@/components/ui/Logo';
import { joinVoice } from '@/lib/voice';
import { codeToSlug } from '@/lib/join-code';

/**
 * Лобби (раздел 03 референса): компактная форма быстрого входа по коду. Знак,
 * подпись «быстрый вход», одно поле «ссылка или код канала» и кнопка
 * «Присоединиться». Заменяет сетку-заставку: если у тебя есть ссылка на канал —
 * заходишь сразу, не разыскивая его в сайдбаре.
 */
export function Lobby() {
  const [code, setCode] = useState('');

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const slug = codeToSlug(code);
    if (!slug) return;
    void joinVoice(slug, code.trim());
  }

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <form
        onSubmit={onSubmit}
        className="glass glass-2 flex w-full max-w-[380px] animate-lobby-rise flex-col items-center px-8 py-9 text-center"
      >
        <Logo size={60} animate nodeBg="#0d0f12" />
        <div className="mt-4 font-mono text-[11px] uppercase tracking-[0.24em] text-text-faint">
          быстрый вход
        </div>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="ссылка или код канала"
          autoComplete="off"
          spellCheck={false}
          className="mt-5 w-full rounded-[10px] border border-line bg-bg-elev px-3.5 py-3 text-center font-mono text-[14px] text-text outline-none transition placeholder:text-text-faint focus:border-line-strong focus:ring-1 focus:ring-line-strong"
        />
        <button
          type="submit"
          disabled={!code.trim()}
          className="mt-2.5 w-full rounded-[10px] bg-accent-strong px-3 py-3 text-[14px] font-semibold text-bg-app transition hover:brightness-95 active:translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Присоединиться
        </button>
      </form>
    </div>
  );
}
