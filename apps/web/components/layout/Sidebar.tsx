'use client';

import { useState, type MouseEvent, type ReactNode } from 'react';
import type { Channel, VoiceMode } from '@relay/shared';
import { AnimatePresence, motion } from 'framer-motion';
import { Icon } from '@/components/ui/icon';
import { Logo } from '@/components/ui/Logo';
import { cn } from '@/lib/utils';
import { listItem, springLayout } from '@/lib/motion';
import { useUiStore } from '@/stores/ui';
import { useChannelsStore } from '@/stores/channels';
import { useServersStore } from '@/stores/servers';
import { useUnreadStore, isChannelUnread } from '@/stores/unread';
import { MAIN_SERVER_ID } from '@/lib/constants';
import { useRichT, useT } from '@/lib/i18n';
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
import { setChannelMode } from '@/lib/channels';
import { channelMenuEntries } from '@/lib/channel-menu';
import { openContextMenu } from '@/lib/context-menu';
import { useSfuAvailable } from '@/lib/use-sfu';
import { useVoiceStore } from '@/stores/voice';
import { VoiceMembers } from '@/components/layout/VoiceMembers';
import { CreateChannelDialog } from '@/components/layout/CreateChannelDialog';
import {
  DeleteChannelDialog,
  type DeleteChannelTarget,
} from '@/components/layout/DeleteChannelDialog';
import {
  RenameChannelDialog,
  type RenameChannelTarget,
} from '@/components/layout/RenameChannelDialog';
import { InviteDialog, LinkIcon } from '@/components/layout/InviteDialog';
import {
  DeleteServerDialog,
  type DeleteServerTarget,
} from '@/components/layout/DeleteServerDialog';

/**
 * Подпись текстового канала с точкой «непрочитано». Открытый канал считается
 * прочитанным (точка гаснет); в остальных она загорается на входящих, пока ты
 * туда не заглянул (см. stores/unread). Непрочитанный канал чуть ярче и жирнее.
 */
function TextChannelLabel({ slug, name, active }: { slug: string; name: string; active: boolean }) {
  const unread = useUnreadStore((s) => !active && isChannelUnread(s, slug));
  return (
    <>
      <span
        aria-hidden
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full bg-accent-strong transition-opacity',
          unread ? 'opacity-100' : 'opacity-0',
        )}
      />
      <span className={cn('text-text-muted/70', unread && 'text-text/80')}>#</span>
      <span className={cn('truncate', unread && 'font-medium text-text-header')}>{name}</span>
    </>
  );
}

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

/** Три точки — вход в меню канала (тот же набор, что по правой кнопке). */
function MoreIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  );
}

function ChannelRow({
  active,
  connected,
  onClick,
  onInvite,
  onMenu,
  mode,
  onToggleMode,
  sfuAvailable,
  children,
}: {
  active?: boolean;
  connected?: boolean;
  onClick?: () => void;
  /** Голосовые каналы: hover-кнопка «Пригласить по ссылке». */
  onInvite?: () => void;
  /**
   * Меню канала (переименовать/удалить). Одна кнопка вместо россыпи значков:
   * в 238 пикселях сайдбара им не разойтись, а правая кнопка мыши и «⋯»
   * открывают ровно один и тот же список. Не задано — предлагать нечего
   * (канал по умолчанию), и кнопки нет вовсе.
   */
  onMenu?: (e: MouseEvent<HTMLElement>) => void;
  /** Транспорт голосового канала. Задан только там, где его разрешено менять. */
  mode?: VoiceMode;
  onToggleMode?: () => void;
  sfuAvailable?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  // Переключить на «через сервер» нельзя, пока медиасервер не поднят. Обратно
  // (на p2p) — можно всегда: p2p работает без всякой инфраструктуры.
  const modeLocked = mode === 'p2p' && !sfuAvailable;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={onClick}
      onContextMenu={onMenu}
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
      {(onInvite || onMenu || onToggleMode) && (
        <span className="relative z-[1] ml-auto flex shrink-0 items-center gap-0.5">
          {onToggleMode && mode && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (!modeLocked) onToggleMode();
              }}
              disabled={modeLocked}
              title={t(
                modeLocked
                  ? 'channel.mode.locked'
                  : mode === 'sfu'
                    ? 'channel.mode.sfu'
                    : 'channel.mode.p2p',
              )}
              className={cn(
                'shrink-0 rounded px-1 text-[9px] font-bold uppercase leading-[15px] tracking-[0.3px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent',
                modeLocked && 'cursor-not-allowed opacity-40',
                mode === 'sfu'
                  ? 'bg-accent/20 text-accent'
                  : 'text-text-muted/60 hover:text-text-header',
              )}
            >
              {mode === 'sfu' ? 'SFU' : 'P2P'}
            </button>
          )}
          {/* Мышь показывает эти кнопки на ховере; на тач-экранах ховера нет —
              там они видны всегда, иначе действие недостижимо. */}
          {onInvite && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onInvite();
              }}
              title={t('channel.invite')}
              aria-label={t('channel.invite')}
              className="grid h-5 w-5 shrink-0 place-items-center rounded text-text-muted opacity-0 outline-none transition-[opacity,color] hover:text-text-header focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent group-hover/row:opacity-100 max-md:opacity-100"
            >
              <LinkIcon size={13} />
            </button>
          )}
          {onMenu && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onMenu(e);
              }}
              title={t('channel.actions')}
              aria-label={t('channel.actions')}
              aria-haspopup="menu"
              className="grid h-5 w-5 shrink-0 place-items-center rounded text-text-muted opacity-0 outline-none transition-[opacity,color] hover:text-text-header focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent group-hover/row:opacity-100 max-md:opacity-100"
            >
              <MoreIcon />
            </button>
          )}
        </span>
      )}
    </div>
  );
}

/**
 * Сайдбар каналов. Текстовые
 * и голосовые направления берём из общего реестра сервера (stores/channels) —
 * создание/удаление видят все сразу. Кнопка «+» у заголовка секции открывает
 * модалку создания. Ниже — панель «голос подключён» и панель пользователя с @-тегом.
 */
export function Sidebar() {
  const t = useT();
  const rt = useRichT();
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

  const sfuAvailable = useSfuAvailable();

  const micOn = useVoiceStore((s) => s.micOn);
  const speakersOn = useVoiceStore((s) => s.speakersOn);
  const ping = useVoiceStore((s) => s.ping);
  const presence = useVoiceStore((s) => s.presence);

  const createOpen = useUiStore((s) => s.createChannelOpen);
  const createType = useUiStore((s) => s.createChannelType);
  const openCreate = useUiStore((s) => s.openCreateChannel);
  const setCreateOpen = useUiStore((s) => s.setCreateChannelOpen);

  // Инвайт-ссылка на войс-канал: null — модалка закрыта.
  const [inviteTarget, setInviteTarget] = useState<{ slug: string; label: string } | null>(null);
  // Правка канала из меню: null — соответствующая модалка закрыта.
  const [renameTarget, setRenameTarget] = useState<RenameChannelTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteChannelTarget | null>(null);
  // Подтверждение удаления сервера (спрашиваем — уносит с собой все каналы).
  const [serverDeleteTarget, setServerDeleteTarget] = useState<DeleteServerTarget | null>(null);

  // Управление реестровой записью — по флагу `mine`: сервер считает его под
  // наш сокет и присылает вместе с реестром (audit B2). Id владельца клиенту
  // не показывают и сравнивать его не с чем — кнопки рисуем ровно там, где
  // сервер уже сказал «твоё».

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

  /**
   * Меню канала — общее для правой кнопки на строке и для «⋯». Состав считает
   * lib/channel-menu по тем же правилам, что держит сервер; пусто (каналы
   * главного сервера) — значит своё меню не показываем вовсе, и ПКМ отдаёт
   * обычное меню оболочки.
   */
  function channelMenu(c: Channel) {
    const entries = channelMenuEntries(
      { channel: c, occupants: presence[c.slug]?.length ?? 0 },
      {
        onRename: () => setRenameTarget({ id: c.id, name: c.name, type: c.type }),
        onDelete: () => setDeleteTarget({ id: c.id, name: c.name, type: c.type }),
        onInvite:
          c.type === 'voice' ? () => setInviteTarget({ slug: c.slug, label: c.name }) : undefined,
      },
    );
    if (!entries.length) return undefined;
    return (e: MouseEvent<HTMLElement>) =>
      openContextMenu(e, entries, {
        label: `${c.type === 'text' ? '#' : ''}${c.name}`,
        bare: true,
      });
  }

  // Тег правится в панели в любой момент (даже в эфире). Применяется на
  // Enter/уход из поля: чистим тег, запоминаем и оповещаем сервер (renameSelf) —
  // presence канала, ростер чата и подписи плиток обновятся у всех.
  function commitCallsign() {
    const clean = sanitizeTag(callsign);
    setCallsign(clean);
    saveTag(clean);
    renameSelf(clean || t('common.anonymous'));
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
          {isMain ? 'relay' : (activeServer?.name ?? t('sidebar.server.fallback'))}
        </span>
        {!isMain && activeServer?.removable && activeServer.mine && (
          <button
            // Удаление необратимо и видно всем — спрашиваем своим диалогом,
            // тем же, что и у каналов (window.confirm в нативной оболочке
            // выдаёт себя системным окном браузера). Только создатель может
            // удалить сервер — диалог покажет цену: каналы и сообщения.
            onClick={() => setServerDeleteTarget({ id: activeServerId, name: activeServer.name })}
            title={t('sidebar.server.delete')}
            aria-label={t('sidebar.server.delete')}
            className="ml-auto grid h-6 w-6 shrink-0 place-items-center rounded text-lg leading-none text-text-muted outline-none transition-colors hover:text-danger focus-visible:ring-2 focus-visible:ring-accent"
          >
            ×
          </button>
        )}
      </div>

      {/* Каналы */}
      <div className="flex-1 overflow-y-auto px-2 py-3">
        {/* Свежий сервер без каналов — подсказываем создать первый */}
        {!isMain && serverChannels.length === 0 && (
          <div className="mx-1 mt-2 rounded-lg border border-dashed border-line px-3 py-4 text-center text-[13px] leading-snug text-text-muted">
            {rt('sidebar.empty', {
              plus: (
                <span className="inline-grid h-4 w-4 -translate-y-px place-items-center rounded bg-ok/15 align-middle text-ok">
                  +
                </span>
              ),
            })}
          </div>
        )}

        <Category
          onAdd={isMain ? undefined : () => openCreate('text')}
          addLabel={t('sidebar.channel.createText')}
        >
          {t('sidebar.section.text')}
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
                onMenu={channelMenu(c)}
              >
                <TextChannelLabel
                  slug={c.slug}
                  name={c.name}
                  active={view === 'text' && textRoom === c.slug}
                />
              </ChannelRow>
            </motion.div>
          ))}
        </AnimatePresence>

        <Category
          onAdd={isMain ? undefined : () => openCreate('voice')}
          addLabel={t('sidebar.channel.createVoice')}
        >
          {t('sidebar.section.voice')}
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
                onMenu={channelMenu(c)}
                // Режим правим только у своих каналов — у дефолтных он всегда
                // p2p, чужие трогает владелец (см. handleChannelMode на бэке).
                mode={c.removable && c.mine ? (c.mode ?? 'p2p') : undefined}
                onToggleMode={
                  c.removable && c.mine
                    ? () => setChannelMode(c.id, c.mode === 'sfu' ? 'p2p' : 'sfu')
                    : undefined
                }
                sfuAvailable={sfuAvailable}
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
            title={t('voice.panel.backToVideo')}
          >
            <div className="flex items-center gap-1.5 text-sm font-bold text-ok">
              <span className="h-2 w-2 animate-pulse-dot rounded-full bg-ok shadow-[0_0_6px_var(--color-ok)]" />
              {t('voice.panel.connected')}
            </div>
            <div className={cn('text-[11px]', ping.waiting ? 'text-ok' : 'text-text-muted')}>
              {ping.waiting ? (
                <span className="vp-dots">{ping.label && t(ping.label)}</span>
              ) : (
                <>
                  {t('voice.panel.latency')}{' '}
                  <span
                    className={cn(
                      'font-bold',
                      ping.grade === 'good' && 'text-ok',
                      ping.grade === 'mid' && 'text-[#d8a32a]',
                      ping.grade === 'bad' && 'text-danger',
                    )}
                  >
                    {t('voice.panel.ms', { ms: ping.ms ?? 0 })}
                  </span>
                </>
              )}
            </div>
          </div>
          <button
            title={t('voice.mic')}
            aria-label={t(micOn ? 'voice.mic.turnOff' : 'voice.mic.turnOn')}
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
            title={t(speakersOn ? 'voice.sound.turnOffAll' : 'voice.sound.turnOn')}
            aria-label={t(speakersOn ? 'voice.sound.turnOff' : 'voice.sound.turnOn')}
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
            title={t('voice.leave')}
            aria-label={t('voice.leave.aria')}
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
              title={t('user.tag.hint')}
              className="w-full border-0 border-b border-transparent bg-transparent p-0 text-sm font-semibold text-text-header outline-none focus:border-accent"
            />
          </div>
          <div className="truncate text-[11px] text-text-muted">{t('user.status.online')}</div>
        </div>
      </div>

      <CreateChannelDialog
        open={createOpen}
        initialType={createType}
        onOpenChange={setCreateOpen}
      />
      <RenameChannelDialog
        target={renameTarget}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
      />
      <DeleteChannelDialog
        target={deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      />
      <DeleteServerDialog
        target={serverDeleteTarget}
        onOpenChange={(open) => {
          if (!open) setServerDeleteTarget(null);
        }}
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
