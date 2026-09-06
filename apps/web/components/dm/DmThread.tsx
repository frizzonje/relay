'use client';

import { ChatPanel } from '@/components/chat/ChatPanel';
import { Icon } from '@/components/ui/icon';
import { Identicon } from '@/components/ui/Identicon';
import { PresenceDot } from '@/components/ui/PresenceDot';
import { cn } from '@/lib/utils';
import { shortFingerprint } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { useUiStore } from '@/stores/ui';
import { PRESENCE_LABEL_KEY, usePresence } from '@/stores/presence';
import { useOwnerText, useSetting } from '@/stores/config';
import { useCallGate, useRingStore } from '@/stores/ring';

/**
 * Обёртка беседы: шапка собеседника (лицо, ник, короткий отпечаток, статус) и
 * честная строка приватности вокруг переиспользованной ленты.
 *
 * Второй ленты здесь нет: `ChatPanel` сам понимает, что открыт `dmRoom`, а не
 * `textRoom` (см. его комментарий про «канал или беседа» — тот же слаг сокет
 * держит адресом ленты, независимо от того, канал это или переписка), и
 * получает те же `chat`/`chat-history`, что и текстовый канал. `DmThread`
 * добавляет ровно то, чего у канала нет и не может быть по смыслу: лицо
 * собеседника сверху и напоминание, что переписку видит владелец инсталляции,
 * снизу.
 *
 * Кнопка звонка в шапке (задача 6 плана B) — не дубль карточки собеседника
 * (`DmPeerCard`), а подстраховка от дыры в раскладке: карточка несжимаема и
 * гаснет на узком десктопе, пока раскрыт док ЛС (`max-lg:hidden` при
 * `dmSection`, см. её комментарий), а эта шапка — нет. Без своей кнопки здесь
 * позвонить в этом окне было бы нечем. `useCallGate` — тот же источник
 * правды, что у карточки и мобильной шапки (MobileNav): развести проверку
 * «можно ли звонить» по трём местам значило бы однажды погасить кнопку тут, а
 * там забыть.
 */
export function DmThread() {
  const t = useT();
  const peer = useUiStore((s) => s.dmPeer);
  const nick = useUiStore((s) => s.textLabel);
  const showFingerprints = useSetting<boolean>('people.showFingerprints');
  const presence = usePresence(peer ?? '');
  const gate = useCallGate();
  // Текст владельца, если он его переписал (`direct.privacyNotice`), и перевод,
  // пока не переписывал: умолчание каталога написано на языке базы, и
  // подставить его вместо перевода значило бы ответить по-английски тому, у
  // кого всё остальное по-русски.
  const privacy = useOwnerText('direct.privacyNotice', t('dm.privacy'));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* На телефоне ту же самую шапку несёт `MobileNav` — лицо, ник, отпечаток
          и статус стоят там. Оставить обе значило бы отдать беседе две полосы
          по 52px из 812 точек экрана, повторив в них одно и то же. */}
      <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line px-4 shadow-[0_1px_2px_rgba(0,0,0,0.2)] max-md:hidden">
        {peer && (
          <div className="relative h-[34px] w-[34px] shrink-0">
            <Identicon fingerprint={peer} size={34} />
            <PresenceDot
              state={presence}
              size={11}
              className="absolute -bottom-0.5 -right-0.5 ring-2 ring-bg-main"
            />
          </div>
        )}
        <div className="min-w-0 flex-1 leading-tight">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[14px] font-bold text-text-header">{nick}</span>
            {peer && showFingerprints && (
              <span className="shrink-0 truncate font-mono text-[10px] tracking-[0.06em] text-text-faint">
                {shortFingerprint(peer)}
              </span>
            )}
          </div>
          {/* Присутствие — из глобального стора (stores/presence.ts), той же
              картины, что и точка на лице выше и в списке переписок (DmList):
              одно состояние, названное словом и цветом одинаково всюду. */}
          <span className="text-[11.5px] text-text-muted">{t(PRESENCE_LABEL_KEY[presence])}</span>
        </div>
        {peer && (
          <button
            type="button"
            aria-disabled={gate.allowed ? undefined : true}
            title={gate.allowed ? t('toolbar.call') : t(gate.reasonKey)}
            aria-label={
              gate.allowed ? t('toolbar.call') : `${t('toolbar.call')} — ${t(gate.reasonKey)}`
            }
            onClick={
              gate.allowed
                ? () => void useRingStore.getState().start({ fingerprint: peer, nick }, false)
                : undefined
            }
            className={cn(
              'grid h-8 w-8 shrink-0 place-items-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-line-strong',
              gate.allowed ? 'text-ok hover:bg-ok/10' : 'cursor-not-allowed text-text-faint',
            )}
          >
            <Icon name="phone" className="text-[16px]" strokeWidth={1.8} />
          </button>
        )}
      </div>

      <ChatPanel />

      {/* Честная строка приватности (ограничение 11): инсталляция
          самостоятельная, и владелец сервера читает базу — обещать обратное
          здесь значило бы соврать. */}
      <p className="shrink-0 px-4 pb-3 pt-1 text-center text-[11.5px] leading-snug text-text-faint">
        {privacy}
      </p>
    </div>
  );
}
