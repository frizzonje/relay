'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { InviteCreateResult } from '@relay/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { getSocket } from '@/lib/socket';

/** Цепочка-ссылка (инлайновый line-icon, в наборе /img/icons её нет). */
export function LinkIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

type InviteState =
  | { phase: 'loading' }
  | { phase: 'ready'; url: string }
  | { phase: 'error' };

/**
 * Модалка «Пригласить по ссылке»: запрашивает у сервера гостевой токен на
 * войс-канал (invite-create, ack) и отдаёт готовую ссылку `/invite/<token>`.
 * Ссылка многоразовая, живёт 24 часа; гость по ней попадает только в этот эфир.
 */
export function InviteDialog({
  target,
  onOpenChange,
}: {
  /** Канал, на который зовём; null — модалка закрыта. */
  target: { slug: string; label: string } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [state, setState] = useState<InviteState>({ phase: 'loading' });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!target) return;
    setState({ phase: 'loading' });
    let alive = true;
    // Ack может не прийти (обрыв) — не подвисаем в «loading» навсегда.
    const fallback = setTimeout(() => {
      if (alive) setState({ phase: 'error' });
    }, 6000);
    getSocket().emit('invite-create', { room: target.slug }, (res: InviteCreateResult) => {
      if (!alive) return;
      clearTimeout(fallback);
      if (res?.ok) {
        const url = `${window.location.origin}/invite/${res.token}?l=${encodeURIComponent(target.label)}`;
        setState({ phase: 'ready', url });
      } else {
        setState({ phase: 'error' });
      }
    });
    return () => {
      alive = false;
      clearTimeout(fallback);
    };
  }, [target]);

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast('Ссылка скопирована');
    } catch {
      // Буфер недоступен (http/старый браузер) — выделяем текст для ручного Cmd+C.
      inputRef.current?.select();
      toast('Скопируйте ссылку вручную (Ctrl/Cmd+C)');
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="text-text-muted">
              <LinkIcon size={18} />
            </span>
            Пригласить в «{target?.label}»
          </DialogTitle>
          <DialogDescription>
            Гость войдёт по ссылке без пароля — сразу в этот голосовой канал.
          </DialogDescription>
        </DialogHeader>

        {state.phase === 'error' ? (
          <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-[13px] text-danger">
            Не удалось создать приглашение. Проверьте соединение и попробуйте ещё раз.
          </p>
        ) : (
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              readOnly
              value={state.phase === 'ready' ? state.url : 'Создаём ссылку…'}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 rounded-lg border border-black/40 bg-bg-deep/70 px-3 py-2.5 font-mono text-[12px] text-text outline-none focus:border-accent"
            />
            <Button
              type="button"
              variant="primary"
              disabled={state.phase !== 'ready'}
              onClick={() => state.phase === 'ready' && void copy(state.url)}
            >
              Скопировать
            </Button>
          </div>
        )}

        <p className="text-[11px] leading-snug text-text-muted">
          Ссылка действует 24 часа, входить по ней может любое число гостей. Чаты и другие каналы
          гостям недоступны.
        </p>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Закрыть
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
