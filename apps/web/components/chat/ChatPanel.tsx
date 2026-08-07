'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  MAX_UPLOAD_BYTES,
  REACTION_EMOJIS,
  type ChatMessage,
  type ReplyRef,
  type UploadResponse,
} from '@relay/shared';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/ui/icon';
import { copyText, openContextMenu } from '@/lib/context-menu';
import { chatMessage, springPop } from '@/lib/motion';
import { avatarStyle } from '@/lib/avatar';
import { fmtBytes, fmtClock } from '@/lib/format';
import { renderMarkdownMini } from '@/lib/markdown';
import { getSocket } from '@/lib/socket';
import { useDismiss } from '@/lib/use-dismiss';
import { useUiStore } from '@/stores/ui';
import { useChatStore } from '@/stores/chat';
import { useUnreadStore } from '@/stores/unread';
import { MessageAttachment } from '@/components/chat/MessageAttachment';
import { DeleteMessageDialog } from '@/components/chat/DeleteMessageDialog';
import { tx, useRichT, useT } from '@/lib/i18n';

interface PendingFile {
  id: string;
  file: File;
  previewUrl?: string;
  spoiler: boolean;
}

/** Черновик ответа: снимок цитируемого сообщения, живёт в композере до отправки. */
type Draft = ReplyRef;

// ── Капсула действий сообщения ─────────────────────────────────────────────
// Одна геометрия на тулбар и на его выпадающие меню: «⋯» и пикер реакций
// раскрываются в панель ровно того же размера и формы, что и сама капсула,
// и выравниваются по её правому краю — не «второе окошко другой породы».
/** Геометрия капсулы: скругление, рамка, внутренний отступ, шаг кнопок. */
const CAPSULE =
  'flex items-center gap-px rounded-full border border-white/[0.08] p-[2px] backdrop-blur-md';
/**
 * Выпадающая капсула: та же геометрия, но плотный фон и тень — она лежит
 * поверх ленты. Позиционируется от тулбара (у него `relative`), поэтому оба
 * меню падают на одну высоту и по одной вертикали.
 */
const CAPSULE_POPOVER = cn(
  CAPSULE,
  'absolute -right-px top-[calc(100%+6px)] z-30 bg-bg-deep/95 shadow-[0_12px_32px_rgba(0,0,0,0.55)]',
);
/** Та же капсула, но раскрывается вверх — для тулбара у нижнего края ленты
 * (иначе меню обрежется краем скролл-контейнера у последних сообщений). */
const CAPSULE_POPOVER_UP = cn(
  CAPSULE,
  'absolute -right-px bottom-[calc(100%+6px)] z-30 bg-bg-deep/95 shadow-[0_12px_32px_rgba(0,0,0,0.55)]',
);
/** Ячейка капсулы — общий размер для кнопок и эмодзи. */
const CAPSULE_CELL = 'grid h-6 w-6 place-items-center rounded-full';
/** Кнопка капсулы: ячейка плюс монохромный ховер. */
const CAPSULE_BTN = cn(
  CAPSULE_CELL,
  'text-text-muted transition-colors hover:bg-white/[0.08] hover:text-text-header',
);
/** Общая анимация раскрытия меню — одинаковая у пикера и у «⋯». */
const popoverAnim = {
  initial: { opacity: 0, y: -4, scale: 0.94 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -4, scale: 0.94 },
  transition: { duration: 0.14, ease: [0.16, 1, 0.3, 1] as const },
  style: { transformOrigin: 'top right' },
};
/** Та же анимация, но зеркальная по вертикали — для капсулы, раскрытой вверх. */
const popoverAnimUp = {
  initial: { opacity: 0, y: 4, scale: 0.94 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 4, scale: 0.94 },
  transition: { duration: 0.14, ease: [0.16, 1, 0.3, 1] as const },
  style: { transformOrigin: 'bottom right' },
};
/** Хватает ли места под тулбаром до низа скролл-ленты — иначе меню раскрываем вверх. */
function fitsBelow(trigger: HTMLElement | null): boolean {
  if (!trigger) return true;
  const scrollEl = trigger.closest('.overflow-y-auto');
  const bottom = (scrollEl ?? document.documentElement).getBoundingClientRect().bottom;
  return bottom - trigger.getBoundingClientRect().bottom >= 48;
}

/** Полоса предпросмотра ещё не отправленных вложений — над композером. */
function PendingAttachments({
  items,
  onRemove,
  onToggleSpoiler,
}: {
  items: PendingFile[];
  onRemove: (id: string) => void;
  onToggleSpoiler: (id: string) => void;
}) {
  const t = useT();
  if (!items.length) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-2 px-1">
      {items.map((p) => (
        <div key={p.id} className="group/preview relative shrink-0">
          {p.previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={p.previewUrl}
              alt={p.file.name}
              className={cn(
                'h-16 w-16 rounded-lg border border-white/10 object-cover transition',
                p.spoiler && 'blur-[6px] brightness-75',
              )}
            />
          ) : (
            <div className="flex h-16 w-16 flex-col items-center justify-center gap-1 rounded-lg border border-white/10 bg-bg-active px-1 text-center">
              <span className="text-lg leading-none">📄</span>
              <span className="w-full truncate text-[9px] text-text-muted">{p.file.name}</span>
            </div>
          )}
          {/* Тумблер спойлера */}
          <button
            type="button"
            onClick={() => onToggleSpoiler(p.id)}
            title={t(p.spoiler ? 'chat.spoiler.on' : 'chat.spoiler.mark')}
            aria-pressed={p.spoiler}
            className={cn(
              'absolute -left-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full shadow ring-1 transition-colors',
              p.spoiler
                ? 'bg-accent-strong text-bg-app ring-white/20'
                : 'bg-bg-deep text-text-muted ring-white/10 hover:text-text',
            )}
          >
            <Icon name="eye" className="text-[12px]" />
          </button>
          <button
            type="button"
            onClick={() => onRemove(p.id)}
            title={t('chat.attachment.remove')}
            className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-bg-deep text-text-muted shadow ring-1 ring-white/10 transition-colors hover:bg-danger hover:text-white"
          >
            <Icon name="x" className="text-[10px]" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Текст сообщения с markdown-мини (жирный / код / авто-ссылки). */
function MessageText({ text }: { text: string }) {
  return (
    <div className="whitespace-pre-wrap break-words text-[15px] leading-[1.4] text-text">
      {renderMarkdownMini(text)}
    </div>
  );
}

/** Цитата сообщения-адресата над ответом; клик прокручивает к оригиналу. */
function ReplyQuote({ reply, onJump }: { reply: ReplyRef; onJump: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onJump}
      className="group/quote mb-1 flex max-w-full items-center gap-2 text-left text-[12px] leading-tight text-text-muted transition-colors hover:text-text"
    >
      <span className="h-3.5 w-[2px] shrink-0 rounded-full bg-white/25 transition-colors group-hover/quote:bg-white/50" />
      <span className="shrink-0 font-semibold text-text/90">{reply.name}</span>
      <span className="truncate text-text-faint">{reply.text || t('chat.attachment')}</span>
    </button>
  );
}

/**
 * Инлайн-правка прямо по тексту сообщения — без отдельного окна. Редактируем
 * сам абзац (contentEditable), так что текст правится «на месте». Enter —
 * сохранить, Esc — отмена. Лимит 500 стережём на вводе (у contentEditable нет
 * maxLength).
 */
function EditBox({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = initial;
    el.focus();
    // Курсор в конец текста.
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, [initial]);

  function onKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const t = (ref.current?.textContent ?? '').trim();
      if (t) onSubmit(t);
      else onCancel();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  }

  function onInput() {
    const el = ref.current;
    if (el && (el.textContent?.length ?? 0) > 500) {
      el.textContent = el.textContent!.slice(0, 500);
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }

  return (
    // Отрицательные margin по вертикали гасят собственный padding подсветки:
    // абзац красится «пилюлей», но по высоте занимает ровно столько же, сколько
    // обычный текст — рамка сообщения не прыгает при входе в правку. Крестик
    // вынесен наружу карточки (см. Message), чтобы не менять её ширину.
    <div
      ref={ref}
      contentEditable
      role="textbox"
      aria-label={t('chat.edit.aria')}
      aria-multiline="true"
      suppressContentEditableWarning
      onKeyDown={onKey}
      onInput={onInput}
      // Клик мимо (потеря фокуса) отменяет правку — Enter сохраняет, поэтому
      // blur всегда трактуем как «передумал».
      onBlur={onCancel}
      className="-mx-1.5 -my-0.5 mt-0.5 w-fit min-w-[1.5rem] max-w-full whitespace-pre-wrap break-words rounded-md bg-white/[0.04] px-1.5 py-0.5 text-[15px] leading-[1.4] text-text caret-white outline-none transition-colors focus:bg-white/[0.06]"
    />
  );
}

/** Отправить тогл реакции на сервер (повторный эмодзи снимает свою реакцию). */
function react(id: string, emoji: string) {
  getSocket().emit('chat-react', { id, emoji });
}

/** Лента уже поставленных реакций: чип «эмодзи × счётчик», свои — подсвечены. */
function ReactionBar({
  id,
  reactions,
  me,
}: {
  id: string;
  reactions: NonNullable<ChatMessage['reactions']>;
  me: string;
}) {
  const entries = Object.entries(reactions).filter(([, names]) => names.length > 0);
  if (!entries.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      <AnimatePresence initial={false}>
        {entries.map(([emoji, names]) => {
          const mine = names.includes(me);
          return (
            <motion.button
              key={emoji}
              layout
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.6 }}
              transition={springPop}
              type="button"
              onClick={() => react(id, emoji)}
              title={names.join(', ')}
              className={cn(
                'flex items-center gap-1 rounded-full border px-2 py-0.5 text-[13px] leading-none transition-colors',
                mine
                  ? 'border-accent/70 bg-accent/25 text-text-header'
                  : 'border-white/5 bg-black/25 text-text-muted hover:border-white/15 hover:bg-black/40',
              )}
            >
              <span className="text-[14px]">{emoji}</span>
              <span className="font-semibold tabular-nums">
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={names.length}
                    initial={{ y: -8, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: 8, opacity: 0 }}
                    transition={{ duration: 0.16 }}
                    className="inline-block"
                  >
                    {names.length}
                  </motion.span>
                </AnimatePresence>
              </span>
            </motion.button>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

/**
 * Кнопка тулбара, раскрывающая под собой капсулу-меню (или над собой — у нижнего
 * края ленты, см. fitsBelow). Одна механика на пикер реакций и на «⋯»: они
 * отличались только значком и содержимым, а копии успели разойтись.
 */
function CapsuleMenu({
  icon,
  title,
  ariaLabel,
  closeSignal,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  ariaLabel?: string;
  /** Мышь ушла с сообщения — родитель дёргает счётчик, меню закрывается. */
  closeSignal: number;
  /** Содержимое капсулы; `close` закрывает её после выбора. */
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, wrapRef);

  // Курсор ушёл с сообщения — закрываем, чтобы при возврате не встречало
  // «залипшее» меню.
  useEffect(close, [closeSignal, close]);

  // Обёртка без `relative`: меню якорится к капсуле тулбара (см. CAPSULE_POPOVER).
  return (
    <div ref={wrapRef}>
      <button
        type="button"
        onClick={() => {
          setOpenUp(!fitsBelow(wrapRef.current));
          setOpen((o) => !o);
        }}
        title={title}
        aria-label={ariaLabel ?? title}
        aria-expanded={open}
        className={cn(CAPSULE_BTN, open && 'bg-white/[0.08] text-text-header')}
      >
        {icon}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            {...(openUp ? popoverAnimUp : popoverAnim)}
            className={openUp ? CAPSULE_POPOVER_UP : CAPSULE_POPOVER}
          >
            {children(close)}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Кнопка-«смайлик» (в тулбаре сообщения) с попапом выбора реакции. */
function AddReaction({ id, closeSignal }: { id: string; closeSignal: number }) {
  const t = useT();
  return (
    <CapsuleMenu
      icon={<Icon name="smile" className="text-[13px]" />}
      title={t('chat.react')}
      closeSignal={closeSignal}
    >
      {(close) =>
        // Эмодзи обесцвечены до наведения — не выбиваются из монохрома.
        REACTION_EMOJIS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            onClick={() => {
              react(id, emoji);
              close();
            }}
            className={cn(
              CAPSULE_CELL,
              'text-[15px] leading-none grayscale transition-[transform,filter,background-color] duration-100 hover:scale-110 hover:bg-white/[0.08] hover:grayscale-0',
            )}
          >
            {emoji}
          </button>
        ))
      }
    </CapsuleMenu>
  );
}

/** Меню «⋯» своего сообщения: правка и удаление, чтобы не плодить кнопки. */
function MoreMenu({
  onEdit,
  onDelete,
  closeSignal,
}: {
  onEdit: () => void;
  onDelete: () => void;
  closeSignal: number;
}) {
  const t = useT();
  return (
    <CapsuleMenu
      icon={<Icon name="more-horizontal" className="text-[13px]" />}
      title={t('chat.more')}
      ariaLabel={t('chat.more.aria')}
      closeSignal={closeSignal}
    >
      {(close) => (
        <>
          <ActionBtn
            title={t('chat.action.edit')}
            onClick={() => {
              close();
              onEdit();
            }}
          >
            <Icon name="edit" className="text-[13px]" />
          </ActionBtn>
          <ActionBtn
            title={t('chat.action.delete')}
            danger
            onClick={() => {
              close();
              onDelete();
            }}
          >
            <Icon name="trash" className="text-[13px]" />
          </ActionBtn>
        </>
      )}
    </CapsuleMenu>
  );
}

/** Кнопка тулбара сообщения (ответ/реакция) — видна при наведении. */
function ActionBtn({
  title,
  danger,
  onClick,
  children,
}: {
  title: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(CAPSULE_BTN, danger && 'hover:!bg-danger/15 hover:!text-danger')}
    >
      {children}
    </button>
  );
}

/** Одно сообщение ленты: системное (вход/выход) или обычное. */
function Message({
  msg,
  mine,
  me,
  enter,
  editing,
  onReply,
  onStartEdit,
  onSubmitEdit,
  onCancelEdit,
  onDelete,
  onJumpTo,
}: {
  msg: ChatMessage;
  mine: boolean;
  me: string;
  enter: boolean;
  editing: boolean;
  onReply: (m: ChatMessage) => void;
  onStartEdit: (m: ChatMessage) => void;
  onSubmitEdit: (id: string, text: string) => void;
  onCancelEdit: () => void;
  onDelete: (m: ChatMessage) => void;
  onJumpTo: (id: string) => void;
}) {
  const t = useT();
  // Счётчик «мышь ушла с сообщения» — по нему AddReaction закрывает свой пикер.
  const [leaveTick, setLeaveTick] = useState(0);
  const anim = {
    variants: chatMessage,
    initial: enter ? ('hidden' as const) : false,
    animate: 'show' as const,
  };
  if (msg.system) {
    return (
      <motion.div
        {...anim}
        className="justify-center px-2 py-1 text-center text-xs italic text-text-muted"
      >
        {msg.text}
      </motion.div>
    );
  }
  // ПКМ по сообщению — те же действия, что в капсуле на ховере, плюс копия
  // текста. Пункты цели (адрес ссылки, «сохранить картинку», копирование
  // выделенного) допишет openContextMenu.
  function onContextMenu(e: React.MouseEvent) {
    if (editing || !msg.id) return; // в правке командует поле ввода
    openContextMenu(
      e,
      [
        {
          id: 'msg-reply',
          label: t('chat.action.reply'),
          icon: 'reply' as const,
          run: () => onReply(msg),
        },
        msg.text
          ? {
              id: 'msg-copy',
              label: t('chat.action.copyText'),
              icon: 'copy' as const,
              run: () => void copyText(msg.text),
            }
          : null,
        mine
          ? {
              id: 'msg-edit',
              label: t('chat.action.edit'),
              icon: 'edit' as const,
              run: () => onStartEdit(msg),
            }
          : null,
        mine
          ? {
              id: 'msg-delete',
              label: t('chat.action.deleteMessage'),
              icon: 'trash' as const,
              danger: true,
              run: () => onDelete(msg),
            }
          : null,
      ],
      { label: msg.name },
    );
  }

  return (
    <motion.div
      {...anim}
      data-mid={msg.id}
      className="group flex items-start px-1"
      onMouseLeave={() => setLeaveTick((t) => t + 1)}
      onContextMenu={onContextMenu}
    >
      {/* Карточка обжимается по содержимому (flex-ребёнок без flex-1) — не
          растягивается на всю страницу; подсветка ховера обнимает только её.
          В режиме правки даём умеренную фиксированную ширину под textarea. */}
      <div className="flex min-w-0 max-w-[min(100%,720px)] gap-3 rounded-[10px] px-2.5 py-1.5 transition-colors group-hover:bg-white/[0.03]">
        <div
          className="mt-0.5 h-[38px] w-[38px] shrink-0 rounded-full"
          style={avatarStyle(msg.name ?? '')}
        />
        <div className="min-w-0 flex-1">
          {msg.replyTo && (
            <ReplyQuote reply={msg.replyTo} onJump={() => onJumpTo(msg.replyTo!.id)} />
          )}
          <div className="flex items-baseline gap-2">
            <span
              className={cn('text-[15px] font-semibold', mine ? 'text-link' : 'text-text-header')}
            >
              {msg.name}
            </span>
            <span className="text-[11px] text-text-muted">{fmtClock(msg.ts)}</span>
            {msg.editedTs && (
              <span className="text-[10px] text-text-faint">{t('chat.edited')}</span>
            )}
          </div>
          {editing && msg.id ? (
            <EditBox
              initial={msg.text}
              onSubmit={(t) => onSubmitEdit(msg.id!, t)}
              onCancel={onCancelEdit}
            />
          ) : (
            <>
              {msg.text && <MessageText text={msg.text} />}
              {msg.attachment && <MessageAttachment att={msg.attachment} />}
            </>
          )}
          {msg.id && msg.reactions && <ReactionBar id={msg.id} reactions={msg.reactions} me={me} />}
        </div>
      </div>
      {editing && (
        // Крестик отмены — снаружи карточки, в том же слоте, что и панель
        // действий: не влияет на ширину сообщения, поэтому рамка не растёт.
        <div className={cn(CAPSULE, 'ml-1.5 mt-1.5 shrink-0 bg-white/[0.03]')}>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onCancelEdit}
            title={t('chat.edit.cancel')}
            aria-label={t('chat.edit.cancel')}
            className={CAPSULE_BTN}
          >
            <Icon name="x" className="text-[11px]" />
          </button>
        </div>
      )}
      {msg.id && !editing && (
        // Стеклянная капсула действий сразу справа от карточки — максимум три
        // кружка: ответить, реакция и «⋯» (правка/удаление своего сообщения
        // спрятаны в меню). Появляется на ховере лёгким выездом; при открытом
        // пикере/меню держится focus-within. `relative` — якорь выпадающих
        // капсул, чтобы они падали ровно под неё и по её правому краю.
        <div
          className={cn(
            CAPSULE,
            'pointer-events-none relative ml-1.5 mt-1.5 shrink-0 translate-x-1 bg-white/[0.03] opacity-0 transition-all duration-150 focus-within:pointer-events-auto focus-within:translate-x-0 focus-within:opacity-100 group-hover:pointer-events-auto group-hover:translate-x-0 group-hover:opacity-100',
          )}
        >
          <ActionBtn title={t('chat.action.reply')} onClick={() => onReply(msg)}>
            <Icon name="reply" className="text-[13px]" />
          </ActionBtn>
          <AddReaction id={msg.id} closeSignal={leaveTick} />
          {mine && (
            <MoreMenu
              onEdit={() => onStartEdit(msg)}
              onDelete={() => onDelete(msg)}
              closeSignal={leaveTick}
            />
          )}
        </div>
      )}
    </motion.div>
  );
}

/** Разделитель «новые сообщения» перед первой непрочитанной репликой. */
function UnreadDivider() {
  const t = useT();
  return (
    <div className="my-1 flex items-center gap-2 px-2">
      <div className="h-px flex-1 bg-danger/35" />
      <span className="rounded-full bg-danger/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-danger">
        {t('chat.unread.divider')}
      </span>
      <div className="h-px flex-1 bg-danger/35" />
    </div>
  );
}

/** Текст индикатора «печатает…» по списку тегов. */
function typingText(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return tx('chat.typing.one', { name: names[0] });
  if (names.length === 2) return tx('chat.typing.two', { first: names[0], second: names[1] });
  return tx('chat.typing.many');
}

/**
 * Текстовый канал: лента сообщений и композер со скрепкой. Подписка/история
 * живут в SocketProvider; здесь — рендер ленты, отправка, ответы/правка/удаление,
 * drag-and-drop файлов, индикатор «печатает…», разделитель «новые» и «вниз».
 */
export function ChatPanel() {
  const t = useT();
  const rt = useRichT();
  const textLabel = useUiStore((s) => s.textLabel);
  const textRoom = useUiStore((s) => s.textRoom);
  const callsign = useUiStore((s) => s.callsign);
  const messages = useChatStore((s) => s.messages);
  const typing = useChatStore((s) => s.typing);

  const [text, setText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [reply, setReply] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ChatMessage | null>(null);
  const [dragging, setDragging] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [hasNew, setHasNew] = useState(false);
  // Отметка «дочитал до» на момент входа в канал (или момента, когда от него
  // отвернулись) — по ней рисуем линию «новые». Держит её стор, а не локальный
  // стейт: она двигается и без смены канала (свернул окно → вернулся).
  const dividerTs = useUnreadStore((s) => (textRoom ? (s.divider[textRoom] ?? 0) : 0));

  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<PendingFile[]>([]);
  const prevLen = useRef(0);
  const dragDepth = useRef(0);
  const lastTypingSent = useRef(0);

  const me = callsign.trim() || t('common.anonymous');

  // Анимируем вход сообщений только после прогрузки истории. Отметку «прочитано
  // до» на смену канала ставит SocketProvider (openChannel) — до того, как сюда
  // доедет история, иначе линия «новые» вставала бы на моменте открытия.
  const [enterAnim, setEnterAnim] = useState(false);
  useEffect(() => {
    setEnterAnim(false);
    setReply(null);
    setEditingId(null);
    setPendingDelete(null);
    setAtBottom(true);
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setEnterAnim(true)));
    return () => cancelAnimationFrame(raf);
  }, [textRoom]);

  // Автопрокрутка вниз, если уже у дна; иначе, если лента выросла — зажигаем «вниз».
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const grew = messages.length > prevLen.current;
    prevLen.current = messages.length;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (bottom) el.scrollTo({ top: el.scrollHeight, behavior: enterAnim ? 'smooth' : 'auto' });
    else if (grew) setHasNew(true);
  }, [messages, enterAnim]);

  // Отзываем object URL превьюшек при размонтировании — иначе утечка блобов.
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);
  useEffect(
    () => () => {
      pendingRef.current.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl));
    },
    [],
  );

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAtBottom(bottom);
    // Отскроллен вверх — входящие не считаются прочитанными (stores/unread).
    useUnreadStore.getState().setAtBottom(bottom);
    if (bottom) setHasNew(false);
  }

  function jumpToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setHasNew(false);
  }

  // Прокрутить к оригиналу цитаты и коротко подсветить его.
  function jumpTo(id: string) {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-mid="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('msg-flash');
    setTimeout(() => el.classList.remove('msg-flash'), 1200);
  }

  function startReply(m: ChatMessage) {
    if (!m.id || !m.name) return;
    setReply({ id: m.id, name: m.name, text: m.text.slice(0, 140) });
    setEditingId(null);
    inputRef.current?.focus();
  }

  function submitEdit(id: string, newText: string) {
    getSocket().emit('chat-edit', { id, text: newText });
    setEditingId(null);
  }

  function deleteMessage(m: ChatMessage) {
    if (m.id) setPendingDelete(m);
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!textRoom) return;
    const t = text.trim();
    if (!t && pending.length === 0) return;
    const files = pending;
    const replyId = reply?.id;
    setPending([]);
    setText('');
    setReply(null);

    // Ответ вешаем на текстовое сообщение; если текста нет — на первый файл.
    for (let i = 0; i < files.length; i++) {
      const p = files[i];
      const useReply = !t && i === 0 ? replyId : undefined;
      await uploadAndSend(p, useReply);
      if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    }
    if (t) getSocket().emit('chat-message', { text: t, ...(replyId ? { replyTo: replyId } : {}) });
  }

  async function uploadAndSend(p: PendingFile, replyToId?: string) {
    if (!textRoom) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', p.file);
      const base = process.env.NEXT_PUBLIC_API_URL || '';
      const res = await fetch(`${base}/api/upload`, {
        method: 'POST',
        body: fd,
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`upload failed: ${res.status}`);
      const att = (await res.json()) as UploadResponse;
      getSocket().emit('chat-message', {
        uploadId: att.id,
        ...(p.spoiler ? { spoiler: true } : {}),
        ...(replyToId ? { replyTo: replyToId } : {}),
      });
    } catch (err) {
      console.error(err);
      toast.error(t('chat.upload.failed', { name: p.file.name }));
    } finally {
      setUploading(false);
    }
  }

  // Добавляет выбранные файлы в предпросмотр — не отправляет их сразу.
  function addFiles(files: File[]) {
    const accepted: PendingFile[] = [];
    for (const file of files) {
      if (file.size > MAX_UPLOAD_BYTES) {
        toast.error(
          t('chat.upload.tooBig', { name: file.name, limit: fmtBytes(MAX_UPLOAD_BYTES) }),
        );
        continue;
      }
      accepted.push({
        id: crypto.randomUUID(),
        file,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
        spoiler: false,
      });
    }
    if (accepted.length) setPending((p) => [...p, ...accepted]);
  }

  function removePending(id: string) {
    setPending((p) => {
      const target = p.find((f) => f.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return p.filter((f) => f.id !== id);
    });
  }

  function toggleSpoiler(id: string) {
    setPending((p) => p.map((f) => (f.id === id ? { ...f, spoiler: !f.spoiler } : f)));
  }

  function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    addFiles(files);
  }

  function onPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const imageFiles = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (!imageFiles.length) return;
    e.preventDefault();
    addFiles(imageFiles);
  }

  function onType(v: string) {
    setText(v);
    const now = Date.now();
    if (v && now - lastTypingSent.current > 2500) {
      lastTypingSent.current = now;
      getSocket().emit('chat-typing');
    }
  }

  // ── Drag-and-drop файлов на всю панель ──────────────────────────────────
  const dragHasFiles = (e: React.DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  function onDragEnter(e: React.DragEvent) {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }
  function onDragOver(e: React.DragEvent) {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
  function onDragLeave() {
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragging(false);
    }
  }
  function onDrop(e: React.DragEvent) {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const files = [...e.dataTransfer.files];
    if (files.length) addFiles(files);
  }

  const firstUnreadIdx =
    dividerTs > 0 ? messages.findIndex((m) => !m.system && m.ts > dividerTs) : -1;

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-4 pb-2 pt-4"
      >
        <div className="px-4 pb-3 pt-7 text-center text-[13px] leading-[1.5] text-text-muted">
          {rt('chat.start', {
            channel: <b className="text-text-header">#{textLabel}</b>,
          })}
        </div>
        {messages.map((m, i) => (
          <div key={m.id ?? i}>
            {i === firstUnreadIdx && <UnreadDivider />}
            <Message
              msg={m}
              mine={!m.system && m.name === me}
              me={me}
              enter={enterAnim}
              editing={editingId === m.id}
              onReply={startReply}
              onStartEdit={(mm) => setEditingId(mm.id ?? null)}
              onSubmitEdit={submitEdit}
              onCancelEdit={() => setEditingId(null)}
              onDelete={deleteMessage}
              onJumpTo={jumpTo}
            />
          </div>
        ))}
      </div>

      {/* Drag-overlay поверх ленты */}
      <AnimatePresence>
        {dragging && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="pointer-events-none absolute inset-2 z-30 grid place-items-center rounded-[14px] border-2 border-dashed border-line-strong bg-bg-app/75 backdrop-blur-sm"
          >
            <div className="flex flex-col items-center gap-2 text-text-header">
              <Icon name="paperclip" className="text-[30px]" strokeWidth={1.7} />
              <span className="font-mono text-[12px] uppercase tracking-[0.16em]">
                {t('chat.drop')}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* «Вниз к новым» — когда лента прокручена вверх */}
      <AnimatePresence>
        {!atBottom && (
          <motion.button
            type="button"
            onClick={jumpToBottom}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.14 }}
            className={cn(
              'absolute right-5 z-20 flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] shadow-lg backdrop-blur transition-colors',
              hasNew
                ? 'border-accent-strong/40 bg-accent-strong/90 text-bg-app hover:brightness-95'
                : 'border-line bg-bg-panel/95 text-text hover:bg-bg-active',
            )}
            style={{ bottom: pending.length || reply ? 132 : 84 }}
          >
            {t(hasNew ? 'chat.jump.new' : 'chat.jump.bottom')}
            <Icon name="arrow-down" className="text-[15px]" />
          </motion.button>
        )}
      </AnimatePresence>

      {/* Композер. На мобиле прижат к нижнему краю (навигация уехала в шапку):
          отступ снизу — только под домашнюю полоску iPhone. */}
      <div className="shrink-0 px-4 pb-5 pt-1 max-md:px-2 max-md:pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {/* «Печатает…» — тонкая строка над композером (высоту резервируем всегда) */}
        <div className="h-5 truncate px-2 text-[12px] leading-5 text-text-muted">
          {typing.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <span className="flex gap-0.5" aria-hidden>
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="h-1 w-1 rounded-full bg-text-muted"
                    style={{ animation: `typingDot 1s ease-in-out ${i * 0.15}s infinite` }}
                  />
                ))}
              </span>
              {typingText(typing)}
            </span>
          )}
        </div>

        {/* Баннер ответа */}
        <AnimatePresence>
          {reply && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.14 }}
              className="overflow-hidden"
            >
              <div className="mb-2 flex items-center gap-2 rounded-[10px] border border-line bg-bg-active/60 px-3 py-1.5 text-[12.5px]">
                <Icon name="reply" className="text-[13px] text-text-muted" />
                <span className="text-text-muted">{t('chat.reply.label')}</span>
                <span className="shrink-0 font-medium text-text-header">{reply.name}</span>
                <span className="truncate text-text-muted">
                  {reply.text || t('chat.attachment')}
                </span>
                <button
                  type="button"
                  onClick={() => setReply(null)}
                  aria-label={t('chat.reply.cancel')}
                  className="ml-auto grid h-5 w-5 shrink-0 place-items-center rounded-full text-text-muted transition-colors hover:bg-bg-hover hover:text-text"
                >
                  <Icon name="x" className="text-[11px]" />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <PendingAttachments
          items={pending}
          onRemove={removePending}
          onToggleSpoiler={toggleSpoiler}
        />
        <form
          onSubmit={send}
          className="flex items-center gap-1 rounded-2xl bg-bg-active px-2 py-1.5 ring-1 ring-line transition-shadow focus-within:ring-2 focus-within:ring-line-strong"
        >
          <input ref={fileRef} type="file" hidden multiple onChange={onFiles} />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            title={t('chat.attach')}
            className={cn(
              'grid h-9 w-9 shrink-0 place-items-center rounded-full text-text-muted transition-colors hover:bg-white/10 hover:text-text',
              uploading && 'cursor-progress opacity-60',
            )}
          >
            <Icon name="paperclip" className="text-[20px]" />
          </button>
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => onType(e.target.value)}
            onPaste={onPaste}
            maxLength={500}
            autoComplete="off"
            placeholder={t('chat.composer.placeholder', { channel: textLabel })}
            className="min-w-0 flex-1 bg-transparent px-1 py-1.5 text-[15px] text-text outline-none placeholder:text-text-muted/70"
          />
          <button
            type="submit"
            disabled={uploading || (!text.trim() && pending.length === 0)}
            title={t('chat.send')}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent-strong text-base font-bold text-bg-app transition-all hover:brightness-95 disabled:scale-90 disabled:opacity-40"
          >
            ➤
          </button>
        </form>
      </div>

      <DeleteMessageDialog
        target={pendingDelete}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      />
    </div>
  );
}
