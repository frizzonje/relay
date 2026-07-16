'use client';

import { useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Icon } from '@/components/ui/icon';
import { Logo } from '@/components/ui/Logo';
import { cn } from '@/lib/utils';
import { listItem, springLayout } from '@/lib/motion';
import { useUiStore } from '@/stores/ui';
import { useChannelsStore } from '@/stores/channels';
import { useServersStore } from '@/stores/servers';
import { DEFAULT_STATUS, MAIN_SERVER_ID } from '@/lib/constants';
import { avatarStyle } from '@/lib/avatar';
import { serverGradient, serverInitials } from '@/lib/server-visual';
import { sanitizeTag, saveTag } from '@/lib/identity';
import {
  joinVoice,
  leaveVoice,
  renameSelf,
  showVoiceStage,
  toggleMic,
  toggleSpeakers,
} from '@/lib/voice';
import { deleteChannel } from '@/lib/channels';
import { deleteServer } from '@/lib/servers';
import { useVoiceStore } from '@/stores/voice';
import { VoiceMembers } from '@/components/layout/VoiceMembers';
import { CreateChannelDialog } from '@/components/layout/CreateChannelDialog';
import { InviteDialog, LinkIcon } from '@/components/layout/InviteDialog';

/** Заголовок секции с необязательной кнопкой «+» (появляется на ховере, как в Discord). */
function Category({
  children,
  onAdd,
  addLabel,
}: {
  children: ReactNode;
  onAdd?: () => void;
  addLabel?: string;
}) {
  return (
    <div className="group/cat flex items-center justify-between px-2 pb-1 pt-3">
      <span className="text-[11px] font-bold uppercase tracking-[0.3px] text-text-muted">
        {children}
      </span>
      {onAdd && (
        <button
          onClick={onAdd}
          title={addLabel}
          aria-label={addLabel}
          className="grid h-4 w-4 place-items-center rounded text-text-muted opacity-0 outline-none transition-opacity hover:text-text-header focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent group-hover/cat:opacity-100"
        >
          <Icon name="plus" className="text-sm" />
        </button>
      )}
    </div>
  );
}

function ChannelRow({
  active,
  connected,
  onClick,
  onInvite,
  onDelete,
  deleteLabel,
  children,
}: {
  active?: boolean;
  connected?: boolean;
  onClick?: () => void;
  /** Голосовые каналы: hover-кнопка «Пригласить по ссылке». */
  onInvite?: () => void;
  onDelete?: () => void;
  deleteLabel?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick?.();
        }
      }}
      className={cn(
        'group/row relative flex cursor-pointer select-none items-center gap-1.5 rounded px-2 py-[7px] text-[15px] text-text-muted outline-none transition-colors hover:text-text focus-visible:ring-2 focus-visible:ring-accent/70',
        !active && 'hover:bg-bg-hover',
        connected && !active && 'text-ok',
        active && 'text-text-header',
      )}
    >
      {/* Подсветка активного канала «переезжает» между строками (общий layoutId),
          как пилюля на рейке серверов. */}
      {active && (
        <motion.span
          layoutId="channel-active"
          transition={springLayout}
          className="pointer-events-none absolute inset-0 rounded bg-bg-active"
        />
      )}
      <span className="relative z-[1] flex min-w-0 items-center gap-1.5">{children}</span>
      {(onInvite || onDelete) && (
        <span className="relative z-[1] ml-auto flex shrink-0 items-center gap-0.5">
          {onInvite && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onInvite();
              }}
              title="Пригласить по ссылке"
              aria-label="Пригласить по ссылке"
              className="grid h-5 w-5 shrink-0 place-items-center rounded text-text-muted opacity-0 outline-none transition-[opacity,color] hover:text-text-header focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent group-hover/row:opacity-100"
            >
              <LinkIcon size={13} />
            </button>
          )}
          {onDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              title={deleteLabel}
              aria-label={deleteLabel}
              className="grid h-5 w-5 shrink-0 place-items-center rounded text-lg leading-none text-text-muted opacity-0 outline-none transition-[opacity,color] hover:text-danger focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent group-hover/row:opacity-100"
            >
              ×
            </button>
          )}
        </span>
      )}
    </div>
  );
}

/**
 * Сайдбар каналов. Служебные секции (только-чтение / «Око») статичны; текстовые
 * и голосовые направления берём из общего реестра сервера (stores/channels) —
 * создание/удаление видят все сразу. Кнопка «+» у заголовка секции открывает
 * модалку создания. Ниже — панель «голос подключён» и панель пользователя с @-тегом.
 */
export function Sidebar() {
  const view = useUiStore((s) => s.view);
  const textRoom = useUiStore((s) => s.textRoom);
  const voiceRoom = useUiStore((s) => s.voiceRoom);
  const leaveText = useUiStore((s) => s.leaveText);
  const callsign = useUiStore((s) => s.callsign);
  const setCallsign = useUiStore((s) => s.setCallsign);

  const servers = useServersStore((s) => s.servers);
  const activeServerId = useServersStore((s) => s.activeServerId);
  const activeServer = servers.find((s) => s.id === activeServerId);
  const isMain = activeServerId === MAIN_SERVER_ID;

  const channels = useChannelsStore((s) => s.channels);
  const serverChannels = channels.filter((c) => c.serverId === activeServerId);
  const textChannels = serverChannels.filter((c) => c.type === 'text');
  const voiceChannels = serverChannels.filter((c) => c.type === 'voice');

  const micOn = useVoiceStore((s) => s.micOn);
  const speakersOn = useVoiceStore((s) => s.speakersOn);
  const ping = useVoiceStore((s) => s.ping);
  const presence = useVoiceStore((s) => s.presence);

  const createOpen = useUiStore((s) => s.createChannelOpen);
  const createType = useUiStore((s) => s.createChannelType);
  const openCreate = useUiStore((s) => s.openCreateChannel);
  const setCreateOpen = useUiStore((s) => s.setCreateChannelOpen);
  const openJoinByCode = useUiStore((s) => s.setJoinByCodeOpen);

  // Инвайт-ссылка на войс-канал: null — модалка закрыта.
  const [inviteTarget, setInviteTarget] = useState<{ slug: string; label: string } | null>(null);

  // Занятые эфиры, которых нет ни в одном сервере реестра (напр. канал удалили,
  // пока в нём сидят) — не роняем из виду. Слаги считаем глобально (не по активному
  // серверу), иначе живые каналы других серверов утекли бы сюда как «сироты».
  // Показываем их только на главном — своего сервера у них уже нет.
  const allVoiceSlugs = new Set(channels.filter((c) => c.type === 'voice').map((c) => c.slug));
  const orphanRooms = Object.keys(presence).filter(
    (r) => !allVoiceSlugs.has(r) && ((presence[r]?.length ?? 0) > 0 || r === voiceRoom),
  );

  // Клик по уже открытому текстовому каналу — выходим.
  function openTextChannel(slug: string, label: string) {
    if (view === 'text' && textRoom === slug) {
      leaveText();
      return;
    }
    useUiStore.getState().openText(slug, label);
  }

  // Тег правится в панели в любой момент (даже в эфире). Применяется на
  // Enter/уход из поля: чистим тег, запоминаем и оповещаем сервер (renameSelf) —
  // presence канала, ростер чата и подписи плиток обновятся у всех.
  function commitCallsign() {
    const clean = sanitizeTag(callsign);
    setCallsign(clean);
    saveTag(clean);
    renameSelf(clean || 'Аноним');
  }

  return (
    <aside className="panel panel-sidebar flex w-[238px] shrink-0 flex-col border-r border-line max-md:grow">
      {/* Шапка — иконка активного сервера и его имя (стык 52px, как топбар) */}
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line px-4 shadow-[0_1px_2px_rgba(0,0,0,0.2)]">
        {isMain ? (
          <span
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-bg-elev ring-1 ring-inset ring-white/10"
            aria-hidden
          >
            <Logo size={16} nodeBg="#111418" />
          </span>
        ) : (
          <span
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-[11px] font-bold text-white ring-1 ring-inset ring-white/10"
            style={{ background: serverGradient(activeServerId) }}
            aria-hidden
          >
            {activeServer?.emoji ?? serverInitials(activeServer?.name ?? '')}
          </span>
        )}
        <span className="truncate font-bold text-text-header">
          {isMain ? 'relay' : (activeServer?.name ?? 'Сервер')}
        </span>
        {!isMain && activeServer?.removable && (
          <button
            onClick={() => {
              // Удаление необратимо и видно всем — спрашиваем, чтобы «×» мимо не снёс сервер.
              if (
                window.confirm(
                  `Удалить сервер «${activeServer.name}» со всеми каналами у всех участников?`,
                )
              )
                deleteServer(activeServerId);
            }}
            title="Удалить сервер"
            aria-label="Удалить сервер"
            className="ml-auto grid h-6 w-6 shrink-0 place-items-center rounded text-lg leading-none text-text-muted outline-none transition-colors hover:text-danger focus-visible:ring-2 focus-visible:ring-accent"
          >
            ×
          </button>
        )}
      </div>

      {/* Каналы */}
      <div className="flex-1 overflow-y-auto px-2 py-3">
        {/* Быстрый вход по коду — только на мобиле (на десктопе это делает лобби) */}
        <button
          type="button"
          onClick={() => openJoinByCode(true)}
          className="mb-1 flex w-full items-center gap-1.5 rounded-[10px] border border-line bg-bg-elev px-3 py-2 text-[14px] font-medium text-text-muted outline-none transition-colors hover:text-text-header md:hidden"
        >
          <Icon name="plus" className="text-[16px]" />
          Войти по коду
        </button>

        {/* Свежий сервер без каналов — подсказываем создать первый */}
        {!isMain && serverChannels.length === 0 && (
          <div className="mx-1 mt-2 rounded-lg border border-dashed border-line px-3 py-4 text-center text-[13px] leading-snug text-text-muted">
            Пока пусто. Создай первый канал кнопкой{' '}
            <span className="inline-grid h-4 w-4 -translate-y-px place-items-center rounded bg-ok/15 align-middle text-ok">
              +
            </span>{' '}
            у секции.
          </div>
        )}

        <Category onAdd={() => openCreate('text')} addLabel="Создать текстовый канал">
          — Текстовые
        </Category>
        <AnimatePresence key={`text-${activeServerId}`} initial={false}>
          {textChannels.map((c) => (
            <motion.div
              key={c.id}
              layout
              variants={listItem}
              initial="hidden"
              animate="show"
              exit="exit"
              transition={springLayout}
            >
              <ChannelRow
                active={view === 'text' && textRoom === c.slug}
                onClick={() => openTextChannel(c.slug, c.name)}
                onDelete={c.removable ? () => deleteChannel(c.id) : undefined}
                deleteLabel="Удалить канал"
              >
                <span className="text-text-muted/70">#</span>
                <span>{c.name}</span>
              </ChannelRow>
            </motion.div>
          ))}
        </AnimatePresence>

        <Category onAdd={() => openCreate('voice')} addLabel="Создать голосовой канал">
          — Голосовые
        </Category>
        <AnimatePresence key={`voice-${activeServerId}`} initial={false}>
          {voiceChannels.map((c) => (
            <motion.div
              key={c.id}
              layout
              variants={listItem}
              initial="hidden"
              animate="show"
              exit="exit"
              transition={springLayout}
            >
              <ChannelRow
                active={view === 'voice' && voiceRoom === c.slug}
                connected={voiceRoom === c.slug}
                onClick={() => void joinVoice(c.slug, c.name)}
                onInvite={() => setInviteTarget({ slug: c.slug, label: c.name })}
                onDelete={c.removable ? () => deleteChannel(c.id) : undefined}
                deleteLabel="Удалить канал"
              >
                <Icon name="volume-2" className="text-[18px]" />
                <span>{c.name}</span>
              </ChannelRow>
              <VoiceMembers room={c.slug} />
            </motion.div>
          ))}
        </AnimatePresence>
        {/* Занятые эфиры вне реестра — временные строки, чтобы никого не потерять */}
        {isMain &&
          orphanRooms.map((r) => (
            <div key={r}>
              <ChannelRow
                active={view === 'voice' && voiceRoom === r}
                connected={voiceRoom === r}
                onClick={() => void joinVoice(r, r)}
              >
                <Icon name="volume-2" className="text-[18px]" />
                <span>{r}</span>
              </ChannelRow>
              <VoiceMembers room={r} />
            </div>
          ))}
      </div>

      {/* Панель «голос подключён» — видна, пока мы в голосовом канале (даже глядя текст) */}
      {voiceRoom && (
        <div className="flex items-center gap-2 border-b border-black/30 bg-bg-deep/80 px-2.5 py-2">
          <div
            onClick={showVoiceStage}
            className="min-w-0 flex-1 cursor-pointer rounded px-1 py-0.5 hover:bg-bg-hover"
            title="Вернуться к видео"
          >
            <div className="flex items-center gap-1.5 text-sm font-bold text-ok">
              <span className="h-2 w-2 animate-pulse-dot rounded-full bg-ok shadow-[0_0_6px_var(--color-ok)]" />
              Голос подключён
            </div>
            <div className={cn('text-[11px]', ping.waiting ? 'text-ok' : 'text-text-muted')}>
              {ping.waiting ? (
                <span className="vp-dots">{ping.label}</span>
              ) : (
                <>
                  задержка:{' '}
                  <span
                    className={cn(
                      'font-bold',
                      ping.grade === 'good' && 'text-ok',
                      ping.grade === 'mid' && 'text-[#d8a32a]',
                      ping.grade === 'bad' && 'text-danger',
                    )}
                  >
                    {ping.ms} мс
                  </span>
                </>
              )}
            </div>
          </div>
          <button
            title="Микрофон"
            aria-label={micOn ? 'Выключить микрофон' : 'Включить микрофон'}
            aria-pressed={!micOn}
            onClick={toggleMic}
            className={cn(
              'rounded p-1 text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text-header focus-visible:ring-2 focus-visible:ring-accent',
              !micOn && 'text-danger',
            )}
          >
            <Icon name={micOn ? 'mic' : 'mic-off'} className="text-[18px]" />
          </button>
          <button
            title={speakersOn ? 'Выключить звук (и микрофон)' : 'Включить звук'}
            aria-label={speakersOn ? 'Выключить звук' : 'Включить звук'}
            aria-pressed={!speakersOn}
            onClick={toggleSpeakers}
            className={cn(
              'rounded p-1 text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text-header focus-visible:ring-2 focus-visible:ring-accent',
              !speakersOn && 'text-danger',
            )}
          >
            <Icon name={speakersOn ? 'headphones' : 'headphone-off'} className="text-[18px]" />
          </button>
          <button
            title="Отключиться"
            aria-label="Выйти из голосового канала"
            onClick={() => leaveVoice()}
            className="rounded p-1 text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-danger focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Icon name="phone-off" className="text-[18px]" />
          </button>
        </div>
      )}

      {/* Панель юзера — стык 64px */}
      <div className="flex h-16 items-center gap-2 border-t border-line bg-bg-deep/80 px-2">
        <div
          className="relative h-[34px] w-[34px] shrink-0 rounded-full after:absolute after:-bottom-0.5 after:-right-0.5 after:h-3 after:w-3 after:rounded-full after:border-[3px] after:border-bg-deep after:bg-ok after:content-['']"
          style={avatarStyle(callsign)}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center">
            <span className="select-none text-sm font-semibold text-text-muted">@</span>
            <input
              value={callsign}
              onChange={(e) => setCallsign(e.target.value)}
              onBlur={commitCallsign}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
              maxLength={20}
              title="Тег — Enter или клик мимо, чтобы применить"
              className="w-full border-0 border-b border-transparent bg-transparent p-0 text-sm font-semibold text-text-header outline-none focus:border-accent"
            />
          </div>
          <div className="truncate text-[11px] text-text-muted">{DEFAULT_STATUS}</div>
        </div>
      </div>

      <CreateChannelDialog
        open={createOpen}
        initialType={createType}
        onOpenChange={setCreateOpen}
      />
      <InviteDialog
        target={inviteTarget}
        onOpenChange={(open) => {
          if (!open) setInviteTarget(null);
        }}
      />
    </aside>
  );
}
