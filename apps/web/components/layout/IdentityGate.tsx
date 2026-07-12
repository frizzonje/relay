'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { motion } from 'framer-motion';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { avatarStyle } from '@/lib/avatar';
import { loadTag, saveTag, sanitizeTag, suggestTag } from '@/lib/identity';
import { useUiStore } from '@/stores/ui';

/**
 * Выбор личности. Сразу после входа по паролю участник выбирает свой @-тег —
 * свободное имя, чтобы его различали на сервере. Ни пароля, ни базы: тег живёт
 * только в localStorage браузера. Если тег уже выбран (возврат) — молча
 * подхватываем его и окно не показываем. Сменить можно в панели пользователя.
 */
export function IdentityGate() {
  const setCallsign = useUiStore((s) => s.setCallsign);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const saved = loadTag();
    if (saved) {
      setCallsign(saved);
    } else {
      setDraft(suggestTag());
      setOpen(true);
    }
  }, [setCallsign]);

  const clean = sanitizeTag(draft);

  function confirm(e: FormEvent) {
    e.preventDefault();
    if (!clean) return;
    saveTag(clean);
    setCallsign(clean);
    setOpen(false);
  }

  return (
    <Dialog open={open}>
      <DialogContent
        className="max-w-[420px] overflow-hidden p-0"
        // Непропускаемо: тег обязателен, закрыть можно только выбрав его.
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <div className="px-7 pb-6 pt-6 text-center">
          {/* Живой предпросмотр аватара по тегу */}
          <div className="mb-3 grid place-items-center">
            <motion.div
              key={avatarStyle(clean || '?').background as string}
              initial={{ scale: 0.85, opacity: 0.4 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 320, damping: 22 }}
              className="h-16 w-16 rounded-full ring-2 ring-white/15 shadow-[0_6px_18px_rgba(0,0,0,0.45)]"
              style={avatarStyle(clean || '?')}
            />
          </div>

          <DialogTitle className="text-xl">Ваш тег</DialogTitle>
          <DialogDescription className="mx-auto mt-1.5 max-w-[300px] text-[13px] leading-relaxed">
            Под этим тегом вас увидят другие участники сервера. Пароля и базы нет —
            тег хранится только в браузере. Сменить можно в любой момент.
          </DialogDescription>

          <form onSubmit={confirm} className="mt-5 flex flex-col gap-2.5">
            <div className="flex items-center gap-2 rounded-lg border border-black/40 bg-bg-deep/70 px-3 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/60">
              <span className="select-none text-lg font-bold text-text-muted">@</span>
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="тег"
                maxLength={24}
                autoFocus
                spellCheck={false}
                autoComplete="off"
                className="min-w-0 flex-1 border-0 bg-transparent py-2.5 text-[15px] font-semibold text-text-header outline-none placeholder:font-normal placeholder:text-text-muted/60"
              />
              <button
                type="button"
                onClick={() => setDraft(suggestTag())}
                title="Другой вариант"
                aria-label="Сгенерировать другой тег"
                className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-base text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-accent"
              >
                🎲
              </button>
            </div>

            <Button type="submit" variant="primary" size="lg" disabled={!clean} className="mt-1">
              Продолжить
            </Button>
          </form>

          <p className="mt-3 text-[10px] leading-snug text-text-muted opacity-70">
            Тег хранится только в этом браузере.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
