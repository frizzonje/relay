'use client';

import { useState } from 'react';
import type { Server } from '@relay/shared';
import { Icon } from '@/components/ui/icon';
import { Logo } from '@/components/ui/Logo';
import { cn } from '@/lib/utils';
import { MAIN_SERVER_ID } from '@/lib/constants';
import { serverGradient, serverInitials } from '@/lib/server-visual';
import { avatarStyle } from '@/lib/avatar';
import { isServerUnlocked, useServersStore } from '@/stores/servers';
import { useChannelsStore } from '@/stores/channels';
import { useVoiceStore } from '@/stores/voice';
import { CreateServerDialog } from '@/components/layout/CreateServerDialog';
import { UnlockServerDialog } from '@/components/layout/UnlockServerDialog';
import { SettingsDialog } from '@/components/layout/SettingsDialog';

/** Шестерёнка настроек (инлайновый line-icon, раздел 01 референса). */
function GearIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/** Белая пилюля-индикатор слева: высокая у активного, короткая на ховере. */
function Pill({ active }: { active: boolean }) {
  return (
    <span
      className={cn(
        'pointer-events-none absolute -left-2 top-1/2 w-1 -translate-y-1/2 rounded-r bg-white transition-all duration-200',
        active ? 'h-10' : 'h-0 opacity-0 group-hover/srv:h-5 group-hover/srv:opacity-100',
      )}
    />
  );
}

/**
 * Аватарки тех, кто прямо сейчас сидит в любом голосовом канале этого сервера —
 * компактным стеком под иконкой в рейке (как индикатор «тут кипит жизнь»).
 * Агрегируем presence по всем voice-каналам сервера; показываем до трёх, остальных
 * сворачиваем в «+N». Пусто — ничего не рисуем.
 */
function ServerVoiceStack({ serverId }: { serverId: string }) {
  const channels = useChannelsStore((s) => s.channels);
  const presence = useVoiceStore((s) => s.presence);

  const names: string[] = [];
  for (const c of channels) {
    if (c.serverId === serverId && c.type === 'voice') {
      for (const m of presence[c.slug] ?? []) names.push(m.name || 'Аноним');
    }
  }
  if (names.length === 0) return null;

  const shown = names.slice(0, 3);
  const extra = names.length - shown.length;
  return (
    <div
      className="pointer-events-none mt-1 flex items-center justify-center"
      aria-label={`В голосовых: ${names.length}`}
      title={names.join(', ')}
    >
      <span className="flex -space-x-1.5">
        {shown.map((n, i) => (
          <span
            key={i}
            className="h-4 w-4 rounded-full bg-cover bg-center ring-2 ring-bg-rail"
            style={avatarStyle(n)}
          />
        ))}
      </span>
      {extra > 0 && (
        <span className="ml-0.5 text-[10px] font-semibold leading-none tabular-nums text-text-muted">
          +{extra}
        </span>
      )}
    </div>
  );
}

/** Стеклянная плашка с названием сервера, выезжающая справа от иконки на ховере. */
function RailTooltip({ label }: { label: string }) {
  return (
    <div
      role="tooltip"
      className={cn(
        'glass glass-3 pointer-events-none absolute left-full top-1/2 z-30 ml-3 -translate-y-1/2',
        'translate-x-[-6px] scale-95 whitespace-nowrap px-3 py-1.5 text-[13px] font-semibold text-text-header opacity-0 shadow-xl',
        'transition-all duration-150 group-hover/srv:translate-x-0 group-hover/srv:scale-100 group-hover/srv:opacity-100',
      )}
    >
      {label}
      <span className="absolute right-full top-1/2 -mr-px h-2 w-2 -translate-y-1/2 rotate-45 bg-[#101216]" />
    </div>
  );
}

/**
 * Рейка «серверов» (гильдий) слева. Главный — relay, ниже — серверы, созданные
 * участниками (эмодзи/инициалы на градиенте). Клик переключает активный сервер
 * (сайдбар показывает его каналы). Зелёный «+» внизу создаёт новый сервер.
 */
export function ServerRail() {
  const servers = useServersStore((s) => s.servers);
  const activeServerId = useServersStore((s) => s.activeServerId);
  const unlockedIds = useServersStore((s) => s.unlockedIds);
  const setActiveServer = useServersStore((s) => s.setActiveServer);
  const openUnlock = useServersStore((s) => s.openUnlock);
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const main = servers.find((s) => s.id === MAIN_SERVER_ID);
  const others = servers.filter((s) => s.id !== MAIN_SERVER_ID);

  // Клик по серверу: закрытый и ещё не разблокированный — просим пароль; иначе
  // просто открываем.
  function selectServer(s: Server) {
    if (!isServerUnlocked(s, unlockedIds)) openUnlock(s.id);
    else setActiveServer(s.id);
  }

  return (
    <nav className="panel panel-rail relative z-10 flex w-16 shrink-0 flex-col items-center gap-2 border-r border-line py-3">
      {/* Главный сервер — relay: наш знак mesh-триады на чистой брендовой плашке */}
      <div className="group/srv relative flex flex-col items-center">
        <div className="relative">
          <Pill active={activeServerId === (main?.id ?? MAIN_SERVER_ID)} />
          <button
            onClick={() => setActiveServer(main?.id ?? MAIN_SERVER_ID)}
            aria-label={main?.name ?? 'relay'}
            className="relative grid h-12 w-12 place-items-center rounded-2xl bg-bg-elev ring-1 ring-inset ring-white/10 outline-none transition-[box-shadow,background-color] duration-200 hover:bg-bg-active hover:ring-white/15 focus-visible:ring-2 focus-visible:ring-line-strong"
          >
            <Logo size={28} animate nodeBg="#111418" />
          </button>
          <RailTooltip label={main?.name ?? 'relay'} />
        </div>
        <ServerVoiceStack serverId={main?.id ?? MAIN_SERVER_ID} />
      </div>

      <span className="my-1 h-0.5 w-8 rounded-full bg-white/10" />

      {/* Остальные серверы */}
      {others.map((s) => (
        <ServerIcon
          key={s.id}
          server={s}
          active={activeServerId === s.id}
          locked={!isServerUnlocked(s, unlockedIds)}
          onClick={() => selectServer(s)}
        />
      ))}

      {/* Создать новый сервер */}
      <div className="group/srv relative">
        <button
          onClick={() => setCreateOpen(true)}
          title="Создать сервер"
          aria-label="Создать сервер"
          className="group grid h-12 w-12 place-items-center rounded-[50%] bg-white/[0.04] text-text-muted outline-none transition-[background-color,border-radius,color] duration-200 hover:rounded-2xl hover:bg-ok/15 hover:text-ok focus-visible:rounded-2xl focus-visible:ring-2 focus-visible:ring-ok/60 active:scale-95"
        >
          {/* Пунктирное кольцо — «слот под новый сервер», гаснет при наведении */}
          <span className="pointer-events-none absolute inset-1 rounded-[inherit] border border-dashed border-white/15 transition-opacity duration-200 group-hover:opacity-0" />
          <Icon
            name="plus"
            className="text-[24px] drop-shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-transform duration-300 group-hover:rotate-90 group-hover:scale-110"
          />
        </button>
      </div>

      {/* Настройки — внизу рейки */}
      <div className="group/srv relative mt-auto">
        <button
          onClick={() => setSettingsOpen(true)}
          title="Настройки"
          aria-label="Настройки"
          className="grid h-11 w-11 place-items-center rounded-[14px] text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text-header focus-visible:ring-2 focus-visible:ring-line-strong"
        >
          <GearIcon />
        </button>
        <RailTooltip label="Настройки" />
      </div>

      <CreateServerDialog open={createOpen} onOpenChange={setCreateOpen} />
      <UnlockServerDialog />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </nav>
  );
}

/** Плашка сервера: эмодзи или инициалы на градиенте; замок у закрытых. */
function ServerIcon({
  server,
  active,
  locked,
  onClick,
}: {
  server: Server;
  active: boolean;
  locked: boolean;
  onClick: () => void;
}) {
  return (
    <div className="group/srv relative flex flex-col items-center">
      <div className="relative">
        <Pill active={active} />
        <button
          onClick={onClick}
          aria-label={locked ? `${server.name} — под паролем` : server.name}
          aria-pressed={active}
          style={{ background: serverGradient(server.id) }}
          className={cn(
            'grid h-12 w-12 place-items-center overflow-hidden text-white outline-none ring-1 ring-inset ring-white/10',
            'transition-[border-radius,box-shadow] duration-200 hover:rounded-2xl focus-visible:rounded-2xl',
            'focus-visible:ring-2 focus-visible:ring-accent',
            active ? 'rounded-2xl shadow-[0_0_16px_-4px_rgba(255,255,255,0.5)]' : 'rounded-[50%]',
          )}
        >
          {server.emoji ? (
            <span className="grayscale text-[24px] leading-none drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]">
              {server.emoji}
            </span>
          ) : (
            <span className="text-lg font-bold drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]">
              {serverInitials(server.name)}
            </span>
          )}
        </button>
        <RailTooltip label={locked ? `${server.name} — под паролем` : server.name} />
        {/* Бейдж-замок у закрытых серверов (пока не введён пароль) */}
        {locked && (
          <span
            aria-hidden
            className="pointer-events-none absolute -bottom-0.5 -right-0.5 grid h-[18px] w-[18px] place-items-center rounded-full border-2 border-bg-rail bg-bg-deep text-[9px] leading-none shadow"
          >
            🔒
          </span>
        )}
      </div>
      <ServerVoiceStack serverId={server.id} />
    </div>
  );
}
