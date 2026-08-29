'use client';

import { useEffect, useState } from 'react';
import type { BanEntry } from '@relay/shared';
import { Icon } from '@/components/ui/icon';
import { Identicon } from '@/components/ui/Identicon';
import { fmtSince, shortFingerprint } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { adminRefusalKey, type AdminFieldError } from '@/lib/refusals';
import { useAdminStore } from '@/stores/admin';

/**
 * Вкладка «Баны»: кого не пускают во всю инсталляцию.
 *
 * Сюда попадают только баны на инсталляцию — банов отдельных серверов здесь
 * нет и быть не должно: их ставит и снимает создатель сервера своей дорогой
 * (`moderation-bans`), и смешать два охвата в одном списке значило бы дать
 * владельцу снимать чужие решения, не заметив этого.
 *
 * Список — единственное место, где бан на инсталляцию снимается: забаненный не
 * появится ни в одном канале, и без этой вкладки бан был бы необратим на
 * практике. Поэтому снятие здесь не переспрашивают: вопрос останавливает руку
 * там, где отменить будет нечем, а разбан — как раз отмена, и повторить его
 * стоит одного нажатия на соседней вкладке.
 */
export function BansTab() {
  const t = useT();
  const bans = useAdminStore((s) => s.bans);
  const busy = useAdminStore((s) => s.bansBusy);
  const loaded = useAdminStore((s) => s.bansLoaded);
  const listError = useAdminStore((s) => s.listError);
  /** Отказ по строке: он про одного человека, и стоять ему рядом с ним. */
  const [refusals, setRefusals] = useState<Record<string, AdminFieldError>>({});

  // Свежесть списка помечает стор: бан, поставленный на соседней вкладке,
  // сбрасывает `bansLoaded`, потому что когда и кем — знает только сервер.
  useEffect(() => {
    if (!useAdminStore.getState().bansLoaded) void useAdminStore.getState().loadBans();
  }, [loaded]);

  const lift = async (entry: BanEntry) => {
    const reason = await useAdminStore.getState().unban(entry.fingerprint);
    setRefusals((prev) => {
      if (!reason) return prev;
      return { ...prev, [entry.fingerprint]: reason };
    });
  };

  return (
    <div data-testid="admin-bans" className="flex flex-col gap-2.5">
      <p className="text-[13px] leading-relaxed text-text-muted">{t('admin.bans.body')}</p>

      {busy && !loaded && (
        <p
          data-testid="admin-bans-busy"
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-faint"
        >
          {t('admin.loading')}
        </p>
      )}

      {listError && (
        <p data-testid="admin-bans-error" className="text-[13px] text-danger">
          {t(adminRefusalKey(listError))}
        </p>
      )}

      {loaded && bans.length === 0 && (
        <p data-testid="admin-bans-empty" className="text-[13px] text-text-muted">
          {t('admin.bans.empty')}
        </p>
      )}

      {bans.map((entry) => (
        <div
          key={entry.fingerprint}
          data-testid={`admin-banned-${entry.fingerprint}`}
          className="rounded-[10px] border border-line bg-bg-elev/60 px-3.5 py-3"
        >
          <div className="flex items-center gap-3">
            <Identicon fingerprint={entry.fingerprint} size={34} className="shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-medium text-text-header">{entry.nick}</div>
              {/* Короткий отпечаток, как и везде: тёзок различают по нему, а
                  девятнадцать знаков в строку списка не влезают. */}
              <div className="truncate font-mono text-[11px] tracking-[0.06em] text-text-faint">
                {shortFingerprint(entry.fingerprint)}
              </div>
              <div className="truncate text-[12px] text-text-muted">
                {entry.by
                  ? t('admin.bans.byWhen', { by: entry.by, when: fmtSince(entry.at) })
                  : t('admin.bans.when', { when: fmtSince(entry.at) })}
              </div>
            </div>
            <button
              type="button"
              data-testid={`admin-unban-${entry.fingerprint}`}
              onClick={() => void lift(entry)}
              title={t('admin.bans.unban')}
              aria-label={t('admin.bans.unban')}
              className="shrink-0 rounded-[8px] px-2 py-1.5 text-text-muted outline-none transition-colors hover:bg-ok/10 hover:text-ok"
            >
              <Icon name="user-check" className="text-[17px]" />
            </button>
          </div>
          {refusals[entry.fingerprint] && (
            <p className="mt-1.5 text-[12px] leading-relaxed text-danger">
              {t(adminRefusalKey(refusals[entry.fingerprint]))}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
