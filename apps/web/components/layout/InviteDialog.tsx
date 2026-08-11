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
import { Icon } from '@/components/ui/icon';
import { getSocket } from '@/lib/socket';
import { useT } from '@/lib/i18n';

type InviteState =
  | { phase: 'loading' }
  | { phase: 'ready'; url: string; listen: boolean }
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
  const t = useT();
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
        setState({ phase: 'ready', url, listen: res.listen });
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
      toast(t('invite.copied'));
    } catch {
      // Буфер недоступен (http/старый браузер) — выделяем текст для ручного Cmd+C.
      inputRef.current?.select();
      toast(t('invite.copyManually'));
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="text-text-muted">
              <Icon name="link" className="text-[18px]" />
            </span>
            {t('invite.dialog.title', { channel: target?.label ?? '' })}
          </DialogTitle>
          <DialogDescription>{t('invite.dialog.description')}</DialogDescription>
        </DialogHeader>

        {state.phase === 'error' ? (
          <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-[13px] text-danger">
            {t('invite.dialog.failed')}
          </p>
        ) : (
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              readOnly
              value={state.phase === 'ready' ? state.url : t('invite.dialog.creating')}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 rounded-lg border border-black/40 bg-bg-deep/70 px-3 py-2.5 font-mono text-[12px] text-text outline-none focus:border-accent"
            />
            <Button
              type="button"
              variant="primary"
              disabled={state.phase !== 'ready'}
              onClick={() => state.phase === 'ready' && void copy(state.url)}
            >
              {t('invite.dialog.copy')}
            </Button>
          </div>
        )}

        {/* Канал закрытого сервера раздаёт по ссылке только право слушать —
            сказать об этом надо ДО того, как ссылку отправят, иначе гостя ждёт
            сюрприз, а пригласившего — вопрос «почему меня не слышно». */}
        {state.phase === 'ready' && state.listen && (
          <p className="flex items-start gap-2 rounded-lg border border-line bg-bg-elev px-3 py-2.5 text-[12px] leading-snug text-text-muted">
            <Icon name="headphones" className="mt-px shrink-0 text-[15px]" />
            {t('invite.dialog.listen')}
          </p>
        )}

        <p className="text-[11px] leading-snug text-text-muted">{t('invite.dialog.note')}</p>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
