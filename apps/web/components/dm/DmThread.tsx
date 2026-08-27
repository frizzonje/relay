'use client';

import { ChatPanel } from '@/components/chat/ChatPanel';
import { Identicon } from '@/components/ui/Identicon';
import { shortFingerprint } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { useUiStore } from '@/stores/ui';

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
 */
export function DmThread() {
  const t = useT();
  const peer = useUiStore((s) => s.dmPeer);
  const nick = useUiStore((s) => s.textLabel);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* На телефоне ту же самую шапку несёт `MobileNav` — лицо, ник, отпечаток
          и статус стоят там. Оставить обе значило бы отдать беседе две полосы
          по 52px из 812 точек экрана, повторив в них одно и то же. */}
      <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line px-4 shadow-[0_1px_2px_rgba(0,0,0,0.2)] max-md:hidden">
        {peer && <Identicon fingerprint={peer} size={34} className="shrink-0" />}
        <div className="min-w-0 flex-1 leading-tight">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[14px] font-bold text-text-header">{nick}</span>
            {peer && (
              <span className="shrink-0 truncate font-mono text-[10px] tracking-[0.06em] text-text-faint">
                {shortFingerprint(peer)}
              </span>
            )}
          </div>
          {/* Присутствия у беседы в этапе A нет (см. DmPeerCard) — статус в
              шапке говорит то же самое, а не молчит об этом. */}
          <span className="text-[11.5px] text-text-muted">{t('dm.header.status.unknown')}</span>
        </div>
      </div>

      <ChatPanel />

      {/* Честная строка приватности (ограничение 11): инсталляция
          самостоятельная, и владелец сервера читает базу — обещать обратное
          здесь значило бы соврать. */}
      <p className="shrink-0 px-4 pb-3 pt-1 text-center text-[11.5px] leading-snug text-text-faint">
        {t('dm.privacy')}
      </p>
    </div>
  );
}
