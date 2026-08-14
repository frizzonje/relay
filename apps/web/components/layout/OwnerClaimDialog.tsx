'use client';

import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Identicon } from '@/components/ui/Identicon';
import { claimOwner, OwnerError, type OwnerFailure } from '@/lib/owner';
import { useIdentityStore } from '@/stores/identity';
import { useOwnerStore } from '@/stores/owner';
import { useT, type MessageKey } from '@/lib/i18n';

/**
 * Ссылка владельца, открытая в браузере.
 *
 * Экран спрашивает, а не делает молча, ровно по одной причине: ссылка сгорает с
 * первого раза. Открыл её не в том браузере — и власть досталась не тому окну,
 * а за новой придётся идти в ssh. Поэтому здесь показано, чей именно ключ
 * станет владельцем, — то же лицо и тот же отпечаток, что и в карточке
 * личности.
 */

type Phase =
  | { kind: 'offer' }
  | { kind: 'claiming' }
  | { kind: 'done' }
  | { kind: 'failed'; reason: OwnerFailure };

export function OwnerClaimDialog() {
  const t = useT();
  const token = useOwnerStore((s) => s.claiming);
  const close = useOwnerStore((s) => s.close);
  const me = useIdentityStore((s) => s.me);
  const [phase, setPhase] = useState<Phase>({ kind: 'offer' });

  useEffect(() => {
    if (token !== null) setPhase({ kind: 'offer' });
  }, [token]);

  async function take() {
    if (!token) return;
    setPhase({ kind: 'claiming' });
    try {
      await claimOwner(token);
      setPhase({ kind: 'done' });
    } catch (err) {
      setPhase({ kind: 'failed', reason: err instanceof OwnerError ? err.reason : 'network' });
    }
  }

  return (
    <Dialog open={token !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{t(phase.kind === 'done' ? 'owner.done' : 'owner.title')}</DialogTitle>
          <DialogDescription>
            {t(phase.kind === 'done' ? 'owner.done.body' : 'owner.body')}
          </DialogDescription>
        </DialogHeader>

        {(phase.kind === 'offer' || phase.kind === 'claiming') && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3 rounded-[10px] border border-line bg-bg-elev/60 px-3.5 py-3">
              <Identicon
                fingerprint={me?.fingerprint ?? ''}
                size={38}
                className="shrink-0 rounded-lg ring-1 ring-inset ring-white/10"
              />
              <div className="min-w-0">
                <div className="truncate text-[14px] font-medium text-text-header">@{me?.nick}</div>
                <div className="font-mono text-[11px] tracking-[0.08em] text-text-muted">
                  {me?.fingerprint}
                </div>
              </div>
            </div>
            <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-[12px] leading-snug text-danger">
              {t('owner.warn')}
            </p>
          </div>
        )}

        {phase.kind === 'failed' && (
          <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-[13px] text-danger">
            {t(FAILURE[phase.reason])}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={close}>
            {t(phase.kind === 'done' ? 'common.close' : 'common.cancel')}
          </Button>
          {phase.kind === 'offer' && (
            <Button type="button" variant="primary" disabled={!me} onClick={() => void take()}>
              {t('owner.action')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Отказ → текст. Таблицей, а не шаблоном из имени причины: так компилятор
 * следит, чтобы у каждой причины был свой текст, и молчаливой дырки не будет.
 */
const FAILURE: Record<OwnerFailure, MessageKey> = {
  'bad-token': 'owner.fail.badToken',
  used: 'owner.fail.used',
  expired: 'owner.fail.expired',
  'no-identity': 'owner.fail.noIdentity',
  network: 'owner.fail.network',
};
