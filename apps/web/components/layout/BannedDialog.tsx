'use client';

import { useCallback, useEffect, useState } from 'react';
import type { BanEntry } from '@relay/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Identicon } from '@/components/ui/Identicon';
import { Icon } from '@/components/ui/icon';
import { fmtSince } from '@/lib/format';
import { listBans, unban } from '@/lib/moderation';
import { useT } from '@/lib/i18n';

export interface BansTarget {
  /** Охват: сервер. Пусто — вся инсталляция, её список видит только владелец. */
  server?: string;
  name: string;
}

/**
 * Кто забанен — и единственное место, где бан можно снять.
 *
 * Список нужен ровно затем же, зачем список устройств: без него бан
 * необратим на практике. Забаненный из чата исчезает, и модератор, остывший
 * через час, не может ни вспомнить, кого выгнал, ни отменить это.
 *
 * Человек здесь — лицо, имя и отпечаток, а не строка с идентификатором: ники
 * не уникальны, и разбанивать тёзку по имени было бы лотереей.
 */
export function BannedDialog({
  target,
  onOpenChange,
}: {
  target: BansTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const [bans, setBans] = useState<BanEntry[] | null>(null);
  const server = target?.server;

  const load = useCallback(async () => {
    setBans(await listBans(server));
  }, [server]);

  useEffect(() => {
    if (!target) return;
    setBans(null);
    void load();
  }, [target, load]);

  async function lift(entry: BanEntry) {
    // Ответ не разбираем и перечитываем список в любом случае: отказ здесь
    // почти всегда означает, что список на экране устарел — разбанил кто-то
    // другой, — и показать свежий полезнее, чем сообщить об ошибке.
    await unban(entry.fingerprint, server);
    await load();
  }

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t('moderation.bans.title', { server: target?.name ?? '' })}</DialogTitle>
          <DialogDescription>{t('moderation.bans.body')}</DialogDescription>
        </DialogHeader>

        {bans === null ? (
          <p className="px-1 py-2 text-[13px] text-text-muted">{t('moderation.bans.loading')}</p>
        ) : bans.length === 0 ? (
          <p className="px-1 py-2 text-[13px] text-text-muted">{t('moderation.bans.empty')}</p>
        ) : (
          <div className="flex max-h-[320px] flex-col gap-2 overflow-y-auto">
            {bans.map((entry) => (
              <div
                key={entry.fingerprint}
                className="flex items-center gap-3 rounded-[10px] border border-line bg-bg-elev/60 px-3.5 py-3"
              >
                <Identicon fingerprint={entry.fingerprint} size={34} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium text-text-header">
                    {entry.nick}
                  </div>
                  <div className="truncate font-mono text-[11px] text-text-muted">
                    {entry.fingerprint}
                  </div>
                  <div className="truncate text-[12px] text-text-muted">
                    {entry.by
                      ? t('moderation.bans.byWhen', { by: entry.by, when: fmtSince(entry.at) })
                      : t('moderation.bans.when', { when: fmtSince(entry.at) })}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void lift(entry)}
                  aria-label={t('moderation.bans.unban')}
                  title={t('moderation.bans.unban')}
                  className="shrink-0 rounded-[8px] px-2 py-1.5 text-text-muted outline-none transition-colors hover:bg-ok/10 hover:text-ok"
                >
                  <Icon name="user-check" className="text-[17px]" />
                </button>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
