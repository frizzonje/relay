'use client';

import { useEffect, useRef, useState } from 'react';
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
import { chatMessage, springPop } from '@/lib/motion';
import { avatarStyle } from '@/lib/avatar';
import { fmtBytes, fmtClock } from '@/lib/format';
import { renderMarkdownMini } from '@/lib/markdown';
import { getSocket } from '@/lib/socket';
import { useUiStore } from '@/stores/ui';
import { useChatStore } from '@/stores/chat';
import { useUnreadStore } from '@/stores/unread';
import { MessageAttachment } from '@/components/chat/MessageAttachment';

interface PendingFile {
  id: string;
  file: File;
  previewUrl?: string;
  spoiler: boolean;
}

/** Черновик ответа: снимок цитируемого сообщения, живёт в композере до отправки. */
type Draft = ReplyRef;

// ── Иконки действий (Feather, strokeWidth 2) ───────────────────────────────
function IconReply({ className }: { className?: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <polyline points="9 17 4 12 9 7" />
      <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
    </svg>
  );
}
function IconEdit() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}
function IconTrash() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}
function IconEye() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function IconSmile() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <line x1="9" y1="9" x2="9.01" y2="9" />
      <line x1="15" y1="9" x2="15.01" y2="9" />
    </svg>
  );
}
function IconDots() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  );
}
function IconArrowDown() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="19 12 12 19 5 12" />
    </svg>
  );
}

// ── Капсула действий сообщения ─────────────────────────────────────────────
// Одна геометрия на тулбар и на его выпадающие меню: «⋯» и пикер реакций
// раскрываются в панель ровно того же размера и формы, что и сама капсула,
// и выравниваются по её правому краю — не «второе окошко другой породы».
/** Геометрия капсулы: скругление, рамка, внутренний отступ, шаг кнопок. */
const CAPSULE = 'flex items-center gap-px rounded-full border border-white/[0.08] p-[2px] backdrop-blur-md';
/**
 * Выпадающая капсула: та же геометрия, но плотный фон и тень — она лежит
 * поверх ленты. Позиционируется от тулбара (у него `relative`), поэтому оба
 * меню падают на одну высоту и по одной вертикали.
 */
const CAPSULE_POPOVER = cn(
  CAPSULE,
  'absolute -right-px top-[calc(100%+6px)] z-30 bg-bg-deep/95 shadow-[0_12px_32px_rgba(0,0,0,0.55)]',
);
/** Ячейка капсулы — общий размер для кнопок и эмодзи. */
const CAPSULE_CELL = 'grid h-6 w-6 place-items-center rounded-full';
/** Кнопка капсулы: ячейка плюс монохромный ховер. */
const CAPSULE_BTN = cn(CAPSULE_CELL, 'text-text-muted transition-colors hover:bg-white/[0.08] hover:text-text-header');
/** Общая анимация раскрытия меню — одинаковая у пикера и у «⋯». */
const popoverAnim = {
  initial: { opacity: 0, y: -4, scale: 0.94 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -4, scale: 0.94 },
  transition: { duration: 0.14, ease: [0.16, 1, 0.3, 1] as const },
  style: { transformOrigin: 'top right' },
};

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
            title={p.spoiler ? 'Спойлер включён' : 'Пометить спойлером'}
            aria-pressed={p.spoiler}
            className={cn(
              'absolute -left-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full shadow ring-1 transition-colors',
              p.spoiler
                ? 'bg-accent-strong text-bg-app ring-white/20'
                : 'bg-bg-deep text-text-muted ring-white/10 hover:text-text',
            )}
          >
            <IconEye />
          </button>
          <button
            type="button"
            onClick={() => onRemove(p.id)}
            title="Убрать из отправки"
            className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-bg-deep text-[11px] leading-none text-text-muted shadow ring-1 ring-white/10 transition-colors hover:bg-danger hover:text-white"
          >
            ✕
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
  return (
    <button
      type="button"
      onClick={onJump}
      className="group/quote mb-1 flex max-w-full items-center gap-2 text-left text-[12px] leading-tight text-text-muted transition-colors hover:text-text"
    >
      <span className="h-3.5 w-[2px] shrink-0 rounded-full bg-white/25 transition-colors group-hover/quote:bg-white/50" />
      <span className="shrink-0 font-semibold text-text/90">{reply.name}</span>
      <span className="truncate text-text-faint">{reply.text || 'вложение'}</span>
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
      aria-label="Редактирование сообщения"
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

/** Кнопка-«смайлик» (в тулбаре сообщения) с попапом выбора реакции. */
function AddReaction({ id, closeSignal }: { id: string; closeSignal: number }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Мышь ушла с сообщения (родитель дёрнул счётчик) — пикер закрываем, чтобы
  // при возврате курсора не встречало «залипшее» меню.
  useEffect(() => {
    setOpen(false);
  }, [closeSignal]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Обёртка без `relative`: меню якорится к капсуле тулбара (см. CAPSULE_POPOVER).
  return (
    <div ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Поставить реакцию"
        aria-label="Поставить реакцию"
        className={cn(CAPSULE_BTN, open && 'bg-white/[0.08] text-text-header')}
      >
        <IconSmile />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div {...popoverAnim} className={CAPSULE_POPOVER}>
            {/* Эмодзи обесцвечены до наведения — не выбиваются из монохрома. */}
            {REACTION_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => {
                  react(id, emoji);
                  setOpen(false);
                }}
                className={cn(
                  CAPSULE_CELL,
                  'text-[15px] leading-none grayscale transition-[transform,filter,background-color] duration-100 hover:scale-110 hover:bg-white/[0.08] hover:grayscale-0',
                )}
              >
                {emoji}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
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
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Мышь ушла с сообщения — меню закрываем (см. AddReaction).
  useEffect(() => {
    setOpen(false);
  }, [closeSignal]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function item(title: string, icon: React.ReactNode, danger: boolean, action: () => void) {
    return (
      <button
        type="button"
        title={title}
        aria-label={title}
        onClick={() => {
          setOpen(false);
          action();
        }}
        className={cn(CAPSULE_BTN, danger && 'hover:!bg-danger/15 hover:!text-danger')}
      >
        {icon}
      </button>
    );
  }

  // Обёртка без `relative`: меню якорится к капсуле тулбара (см. CAPSULE_POPOVER).
  return (
    <div ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Ещё"
        aria-label="Ещё действия"
        className={cn(CAPSULE_BTN, open && 'bg-white/[0.08] text-text-header')}
      >
        <IconDots />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div {...popoverAnim} className={CAPSULE_POPOVER}>
            {item('Редактировать', <IconEdit />, false, onEdit)}
            {item('Удалить', <IconTrash />, true, onDelete)}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
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
  return (
    <motion.div
      {...anim}
      data-mid={msg.id}
      className="group flex items-start px-1"
      onMouseLeave={() => setLeaveTick((t) => t + 1)}
    >
      {/* Карточка обжимается по содержимому (flex-ребёнок без flex-1) — не
          растягивается на всю страницу; подсветка ховера обнимает только её.
          В режиме правки даём умеренную фиксированную ширину под textarea. */}
      <div
        className="flex min-w-0 max-w-[min(100%,720px)] gap-3 rounded-[10px] px-2.5 py-1.5 transition-colors group-hover:bg-white/[0.03]"
      >
        <div
          className="mt-0.5 h-[38px] w-[38px] shrink-0 rounded-full"
          style={avatarStyle(msg.name ?? '')}
        />
        <div className="min-w-0 flex-1">
          {msg.replyTo && <ReplyQuote reply={msg.replyTo} onJump={() => onJumpTo(msg.replyTo!.id)} />}
          <div className="flex items-baseline gap-2">
            <span
              className={cn('text-[15px] font-semibold', mine ? 'text-[#79a6ff]' : 'text-text-header')}
            >
              {msg.name}
            </span>
            <span className="text-[11px] text-text-muted">{fmtClock(msg.ts)}</span>
            {msg.editedTs && <span className="text-[10px] text-text-faint">(изменено)</span>}
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
            title="Отменить правку"
            aria-label="Отменить правку"
            className={CAPSULE_BTN}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
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
          <ActionBtn title="Ответить" onClick={() => onReply(msg)}>
            <IconReply />
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
  return (
    <div className="my-1 flex items-center gap-2 px-2">
      <div className="h-px flex-1 bg-danger/35" />
      <span className="rounded-full bg-danger/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-danger">
        новые
      </span>
      <div className="h-px flex-1 bg-danger/35" />
    </div>
  );
}

/** Текст индикатора «печатает…» по списку тегов. */
function typingText(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0]} печатает…`;
  if (names.length === 2) return `${names[0]} и ${names[1]} печатают…`;
  return 'несколько человек печатают…';
}

/**
 * Текстовый канал: лента сообщений и композер со скрепкой. Подписка/история
 * живут в SocketProvider; здесь — рендер ленты, отправка, ответы/правка/удаление,
 * drag-and-drop файлов, индикатор «печатает…», разделитель «новые» и «вниз».
 */
export function ChatPanel() {
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
  const [dragging, setDragging] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [hasNew, setHasNew] = useState(false);
  const [dividerTs, setDividerTs] = useState(0);

  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<PendingFile[]>([]);
  const prevLen = useRef(0);
  const dragDepth = useRef(0);
  const lastTypingSent = useRef(0);

  const me = callsign.trim() || 'Аноним';

  // Анимируем вход сообщений только после прогрузки истории; заодно на смену
  // канала фиксируем отметку «прочитано до» — для разделителя «новые».
  const [enterAnim, setEnterAnim] = useState(false);
  useEffect(() => {
    setEnterAnim(false);
    setReply(null);
    setEditingId(null);
    setDividerTs(useUnreadStore.getState().readMark(textRoom || ''));
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
    if (!m.id) return;
    if (!window.confirm('Удалить это сообщение?')) return;
    getSocket().emit('chat-delete', { id: m.id });
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
    if (t)
      getSocket().emit('chat-message', { text: t, ...(replyId ? { replyTo: replyId } : {}) });
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
      toast.error(`Не удалось отправить файл «${p.file.name}».`);
    } finally {
      setUploading(false);
    }
  }

  // Добавляет выбранные файлы в предпросмотр — не отправляет их сразу.
  function addFiles(files: File[]) {
    const accepted: PendingFile[] = [];
    for (const file of files) {
      if (file.size > MAX_UPLOAD_BYTES) {
        toast.error(`Файл «${file.name}» больше ${fmtBytes(MAX_UPLOAD_BYTES)} — не добавлен.`);
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
          Это начало канала <b className="text-text-header">#{textLabel}</b>. Поздоровайтесь.
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
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
              <span className="font-mono text-[12px] uppercase tracking-[0.16em]">
                Отпустите файлы, чтобы прикрепить
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
            {hasNew ? 'Новые сообщения' : 'Вниз'}
            <IconArrowDown />
          </motion.button>
        )}
      </AnimatePresence>

      <div className="shrink-0 px-4 pb-5 pt-1">
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
                <IconReply className="shrink-0 text-text-muted" />
                <span className="text-text-muted">Ответ</span>
                <span className="shrink-0 font-medium text-text-header">{reply.name}</span>
                <span className="truncate text-text-muted">{reply.text || 'вложение'}</span>
                <button
                  type="button"
                  onClick={() => setReply(null)}
                  aria-label="Отменить ответ"
                  className="ml-auto grid h-5 w-5 shrink-0 place-items-center rounded-full text-text-muted transition-colors hover:bg-bg-hover hover:text-text"
                >
                  ✕
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <PendingAttachments items={pending} onRemove={removePending} onToggleSpoiler={toggleSpoiler} />
        <form
          onSubmit={send}
          className="flex items-center gap-1 rounded-2xl bg-bg-active px-2 py-1.5 ring-1 ring-line transition-shadow focus-within:ring-2 focus-within:ring-line-strong"
        >
          <input ref={fileRef} type="file" hidden multiple onChange={onFiles} />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            title="Приложить файл"
            className={cn(
              'grid h-9 w-9 shrink-0 place-items-center rounded-full text-text-muted transition-colors hover:bg-white/10 hover:text-text',
              uploading && 'cursor-progress opacity-60',
            )}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => onType(e.target.value)}
            onPaste={onPaste}
            maxLength={500}
            autoComplete="off"
            placeholder={`написать в #${textLabel}`}
            className="min-w-0 flex-1 bg-transparent px-1 py-1.5 text-[15px] text-text outline-none placeholder:text-text-muted/70"
          />
          <button
            type="submit"
            disabled={uploading || (!text.trim() && pending.length === 0)}
            title="Отправить"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent-strong text-base font-bold text-bg-app transition-all hover:brightness-95 disabled:scale-90 disabled:opacity-40"
          >
            ➤
          </button>
        </form>
      </div>
    </div>
  );
}
