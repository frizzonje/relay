'use client';

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { sanitizeNick, type Channel, type VoiceMode } from '@relay/shared';
import { AnimatePresence, motion } from 'framer-motion';
import { Icon } from '@/components/ui/icon';
import { Logo } from '@/components/ui/Logo';
import { cn } from '@/lib/utils';
import { listItem, springLayout } from '@/lib/motion';
import { useUiStore } from '@/stores/ui';
import { useChannelsStore } from '@/stores/channels';
import { useServersStore } from '@/stores/servers';
import { useUnreadStore, channelMentions, isChannelUnread } from '@/stores/unread';
import { useNotifyStore, isChannelLoud } from '@/stores/notify';
import { MAIN_SERVER_ID } from '@/lib/constants';
import { useRichT, useT } from '@/lib/i18n';
import { Identicon } from '@/components/ui/Identicon';
import { serverGradient, serverInitials } from '@/lib/server-visual';
import { useIdentityStore } from '@/stores/identity';
import {
  joinVoice,
  leaveVoice,
  renameSelf,
  showVoiceStage,
  toggleMic,
  toggleSpeakers,
} from '@/lib/voice';
import { channelMenuEntries } from '@/lib/channel-menu';
import { previewMessageSound } from '@/lib/notify';
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
import { InviteDialog } from '@/components/layout/InviteDialog';
import {
  DeleteServerDialog,
  type DeleteServerTarget,
} from '@/components/layout/DeleteServerDialog';
import { ChannelModeDialog, type ChannelModeTarget } from '@/components/layout/ChannelModeDialog';
import { BannedDialog, type BansTarget } from '@/components/layout/BannedDialog';

/**
 * Вспышка «пришло новое»: контур строки отходит от её краёв наружу и тает.
 * Ровно один заход, 0.75 с, без сдвига соседей — движение ловится боковым
 * зрением, но глазу не за что зацепиться, когда смотришь прямо.
 *
 * Фигура — та же карточка, что подсвечивает открытый канал: те же края, то же
 * скругление, только отодвинутые. Круг вокруг точки непрочитанного тут пробовали
 * первым, и он читался чужим — в строке нет ничего круглого, а в открытом канале
 * и самой точки нет, так что кольцо расходилось из пустого места.
 *
 * Растёт не `scale`, а отступы: строка вчетверо шире своей высоты, и масштаб
 * растащил бы её вбок сильнее, чем вверх, заодно расплющив скругления. Отступы
 * дают ровный ореол в BLOOM пикселей со всех сторон; радиус растёт с ними, чтобы
 * углы шли параллельно исходным.
 */
const BLOOM = 5;
const ROW_RADIUS = 4; // rounded у ChannelRow

const pingAnim = {
  initial: { top: 0, right: 0, bottom: 0, left: 0, borderRadius: ROW_RADIUS, opacity: 0.5 },
  animate: {
    top: -BLOOM,
    right: -BLOOM,
    bottom: -BLOOM,
    left: -BLOOM,
    borderRadius: ROW_RADIUS + BLOOM,
    opacity: 0,
  },
  transition: {
    duration: 0.75,
    ease: [0.2, 0.8, 0.3, 1] as const,
    // Прозрачность гасим ровно, без замедления в конце. С общей кривой контур
    // почти всю свою жизнь проводит уже погасшим: она отдаёт начало движению,
    // и к середине хода от вспышки остаётся неразличимый след.
    opacity: { duration: 0.75, ease: 'linear' as const },
  },
};

/**
 * Счётчик вспышек канала: локальный, начинается с нуля при монтировании. Прямо
 * по счётчику из хранилища рисовать нельзя — при первом рендере он уже не ноль
 * (сообщения приходили, пока сайдбар был на другом сервере), и вспышка сыграла
 * бы на пустом месте. Возвращённое число годится только как ключ: смена ключа
 * пересоздаёт элемент, и анимация запускается заново — в том числе на второй
 * реплике подряд, когда первая ещё не догорела.
 */
function useMessagePing(slug: string): number {
  const pings = useNotifyStore((s) => s.pings[slug] ?? 0);
  const seen = useRef(pings);
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (pings === seen.current) return;
    seen.current = pings;
    setShown((n) => n + 1);
  }, [pings]);
  return shown;
}

/** Сама вспышка — отдельным компонентом, чтобы подписка на канал жила в нём. */
function ChannelPing({ slug }: { slug: string }) {
  const ping = useMessagePing(slug);
  if (!ping) return null;
  return (
    <motion.span
      key={ping}
      aria-hidden
      {...pingAnim}
      className="pointer-events-none absolute border border-accent-strong"
    />
  );
}

/**
 * Подпись текстового канала с точкой «непрочитано». Открытый канал считается
 * прочитанным (точка гаснет); в остальных она загорается на входящих, пока ты
 * туда не заглянул (см. stores/unread). Непрочитанный канал чуть ярче и жирнее.
 */
function TextChannelLabel({ slug, name, active }: { slug: string; name: string; active: boolean }) {
  const unread = useUnreadStore((s) => !active && isChannelUnread(s, slug));
  // Счётчик упоминаний — числом, а не точкой: «в канале что-то пишут» и «тебя
  // там звали дважды» — разные новости, и вторая стоит того, чтобы её считать.
  const mentions = useUnreadStore((s) => (active ? 0 : channelMentions(s, slug)));
  const t = useT();
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
      {mentions > 0 && (
        <span
          title={t('mention.count', { count: mentions })}
          className="ml-auto shrink-0 rounded-full bg-danger px-1.5 py-px text-[11px] font-bold leading-[1.35] tabular-nums text-white"
        >
          {mentions > 99 ? '99+' : mentions}
        </span>
      )}
    </>
  );
}

/**
 * Состояние звука текстового канала — у правого края строки, там же, где «⋯».
 * Стоит у каждой строки, включая молчащие: молчание тут состояние по умолчанию,
 * и человек, впервые услышавший тик, должен видеть, где он включается, а не
 * искать по меню. Поэтому именно перечёркнутый колокольчик, а не пустое место.
 *
 * Чтобы он при этом не мельтешил, у выключенного канала значок почти прозрачен
 * — на расстоянии вытянутой руки список читается как обычный, а вблизи видно,
 * что каждая строка знает про звук. Включённый заметно ярче: разрешённый звук —
 * это исключение, и его видно сразу.
 *
 * Значок не кнопка: рядом такие же по размеру значки-кнопки, но щелчок по
 * строке открывает канал, и промах по мишени в 20 пикселей менял бы настройку
 * молча. Переключается звук в меню канала — одним местом для всех правил.
 */
function ChannelSoundMark({ slug }: { slug: string }) {
  const t = useT();
  const loud = useNotifyStore((s) => isChannelLoud(s, slug));
  return (
    <Icon
      name={loud ? 'bell' : 'bell-off'}
      title={t(loud ? 'sidebar.channel.loud' : 'sidebar.channel.silent')}
      className={cn(
        'text-[13px] transition-opacity',
        loud ? 'opacity-60' : 'opacity-25 group-hover/row:opacity-45',
      )}
    />
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
function ChannelRow({
  active,
  connected,
  onClick,
  onInvite,
  onMenu,
  mode,
  onToggleMode,
  sfuAvailable,
  trailing,
  flash,
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
  /**
   * Постоянный значок состояния у правого края — перед кнопками ховера. Те
   * держат своё место всегда (прячутся прозрачностью, не снятием с потока),
   * поэтому значок не прыгает под курсором.
   */
  trailing?: ReactNode;
  /**
   * Разовая вспышка поверх строки — рисуется по её краям, поэтому и живёт
   * здесь, а не в подписи: там ближайший `relative` обнимает только текст.
   */
  flash?: ReactNode;
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
      {flash}
      <span className="relative z-[1] flex min-w-0 items-center gap-1.5">{children}</span>
      {(trailing || onInvite || onMenu || onToggleMode) && (
        <span className="relative z-[1] ml-auto flex shrink-0 items-center gap-0.5">
          {trailing}
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
              <Icon name="link" className="text-[13px]" />
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
              <Icon name="more-horizontal" className="text-[15px]" />
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
  const fingerprint = useIdentityStore((s) => s.me?.fingerprint ?? '');

  const servers = useServersStore((s) => s.servers);
  const activeServerId = useServersStore((s) => s.activeServerId);
  const activeServer = servers.find((s) => s.id === activeServerId);
  const isMain = activeServerId === MAIN_SERVER_ID;

  const channels = useChannelsStore((s) => s.channels);
  const serverChannels = channels.filter((c) => c.serverId === activeServerId);
  const textChannels = serverChannels.filter((c) => c.type === 'text');
  const voiceChannels = serverChannels.filter((c) => c.type === 'voice');

  const sfuAvailable = useSfuAvailable();

  // Каналы со звуком входящих. Держим список целиком: он же решает, какой пункт
  // показать в меню («включить» или «заглушить»).
  const loudChannels = useNotifyStore((s) => s.loud);
  const toggleChannelSound = useNotifyStore((s) => s.toggleChannel);

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
  // Смена транспорта канала: null — диалог закрыт. Спрашиваем всегда — переезд
  // обрывает разговор у всех, кто в эфире.
  const [modeTarget, setModeTarget] = useState<ChannelModeTarget | null>(null);
  // Подтверждение удаления сервера (спрашиваем — уносит с собой все каналы).
  const [serverDeleteTarget, setServerDeleteTarget] = useState<DeleteServerTarget | null>(null);
  // Список забаненных этого сервера: null — закрыт.
  const [bansTarget, setBansTarget] = useState<BansTarget | null>(null);

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
      {
        channel: c,
        occupants: presence[c.slug]?.length ?? 0,
        loud: loudChannels.includes(c.slug),
      },
      {
        onRename: () => setRenameTarget({ id: c.id, name: c.name, type: c.type }),
        onDelete: () => setDeleteTarget({ id: c.id, name: c.name, type: c.type }),
        onInvite:
          c.type === 'voice' ? () => setInviteTarget({ slug: c.slug, label: c.name }) : undefined,
        // Звук — настройка своя, не канала: она есть у любого текстового,
        // включая дефолтные и чужие (см. lib/channel-menu). Включили — тут же
        // проигрываем тик: слышно, что именно включилось.
        onToggleSound:
          c.type === 'text'
            ? () => {
                if (toggleChannelSound(c.slug)) previewMessageSound();
              }
            : undefined,
      },
    );
    if (!entries.length) return undefined;
    return (e: MouseEvent<HTMLElement>) =>
      openContextMenu(e, entries, {
        label: `${c.type === 'text' ? '#' : ''}${c.name}`,
        bare: true,
      });
  }

  // Имя правится в панели в любой момент (даже в эфире). Применяется на
  // Enter/уход из поля: чистим, отдаём серверу — он хранит его у личности, а не
  // браузер у себя, — и оповещаем гейтвей (renameSelf), чтобы presence канала,
  // ростер чата и подписи плиток обновились у всех.
  //
  // Не сохранилось — поле возвращается к прежнему имени. Это и есть ответ: имя
  // теперь общее для всех устройств человека, и показывать в панели одно, пока
  // на сервере другое, значило бы врать до следующей перезагрузки.
  async function commitNick() {
    const clean = sanitizeNick(callsign);
    const known = useIdentityStore.getState().me?.nick ?? '';
    if (!clean || clean === known) {
      setCallsign(known || clean);
      return;
    }
    if (await useIdentityStore.getState().rename(clean)) renameSelf(clean);
    else setCallsign(known);
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
            <Logo size={16} nodeBg="var(--color-bg-elev)" />
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
        {activeServer?.moderated && (
          <button
            // Список забаненных — единственное место, где бан можно снять.
            // Стоит рядом с удалением сервера и по тому же правилу: кнопки
            // модератора живут там, где написано имя его сервера.
            onClick={() => setBansTarget({ server: activeServerId, name: activeServer.name })}
            title={t('moderation.bans.open')}
            aria-label={t('moderation.bans.open')}
            className="ml-auto grid h-6 w-6 shrink-0 place-items-center rounded text-text-muted outline-none transition-colors hover:text-text-header focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Icon name="user-x" className="text-[14px]" />
          </button>
        )}
        {!isMain && activeServer?.removable && activeServer.mine && (
          <button
            // Удаление необратимо и видно всем — спрашиваем своим диалогом,
            // тем же, что и у каналов (window.confirm в нативной оболочке
            // выдаёт себя системным окном браузера). Только создатель может
            // удалить сервер — диалог покажет цену: каналы и сообщения.
            onClick={() => setServerDeleteTarget({ id: activeServerId, name: activeServer.name })}
            title={t('sidebar.server.delete')}
            aria-label={t('sidebar.server.delete')}
            className="grid h-6 w-6 shrink-0 place-items-center rounded text-lg leading-none text-text-muted outline-none transition-colors hover:text-danger focus-visible:ring-2 focus-visible:ring-accent"
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
                trailing={<ChannelSoundMark slug={c.slug} />}
                flash={<ChannelPing slug={c.slug} />}
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
                    ? () =>
                        setModeTarget({
                          id: c.id,
                          name: c.name,
                          next: c.mode === 'sfu' ? 'p2p' : 'sfu',
                          occupants: presence[c.slug]?.length ?? 0,
                        })
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
                      ping.grade === 'mid' && 'text-warn',
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
        {/* Лицо своего ключа, а не картинка по имени: имена не уникальны, и
            узнавать себя по тому, что можно занять, незачем. */}
        <div className="relative h-[34px] w-[34px] shrink-0 after:absolute after:-bottom-0.5 after:-right-0.5 after:h-3 after:w-3 after:rounded-full after:border-[3px] after:border-bg-deep after:bg-ok after:content-['']">
          <Identicon
            fingerprint={fingerprint}
            size={34}
            title={fingerprint}
            className="rounded-lg ring-1 ring-inset ring-white/10"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center">
            <span className="select-none text-sm font-semibold text-text-muted">@</span>
            <input
              value={callsign}
              onChange={(e) => setCallsign(e.target.value)}
              onBlur={() => void commitNick()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
              maxLength={20}
              title={t('user.nick.hint')}
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
      <BannedDialog
        target={bansTarget}
        onOpenChange={(open) => {
          if (!open) setBansTarget(null);
        }}
      />
      <ChannelModeDialog
        target={modeTarget}
        onOpenChange={(open) => {
          if (!open) setModeTarget(null);
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
