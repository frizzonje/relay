'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { REACTION_EMOJIS, type ChatMessage, type MentionRef, type ReplyRef } from '@relay/shared';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/ui/icon';
import { copyText, openContextMenu } from '@/lib/context-menu';
import { chatMessage, springPop } from '@/lib/motion';
import { avatarStyle } from '@/lib/avatar';
import { Identicon } from '@/components/ui/Identicon';
import { fmtClock } from '@/lib/format';
import { renderMarkdownMini } from '@/lib/markdown';
import { mentions } from '@/lib/mentions';
import { getSocket } from '@/lib/socket';
import { useDismiss } from '@/lib/use-dismiss';
import { MessageAttachment } from '@/components/chat/MessageAttachment';
import { useT } from '@/lib/i18n';

/**
 * Строка ленты и всё, что к ней прилипает: капсула действий с двумя её меню,
 * инлайн-правка, цитата, реакции.
 *
 * Отдельным файлом, потому что это отдельная работа: ChatPanel отвечает за
 * ленту и композер — прокрутку, непрочитанное, отправку, перетаскивание
 * файлов, — а здесь живёт одно сообщение и то, что можно с ним сделать.
 */

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

/** Текст сообщения с markdown-мини (жирный / код / упоминания / авто-ссылки). */
function MessageText({
  text,
  mentions,
  me,
}: {
  text: string;
  mentions?: MentionRef[];
  me?: string;
}) {
  return (
    <div className="whitespace-pre-wrap break-words text-[15px] leading-[1.4] text-text">
      {renderMarkdownMini(text, mentions ?? [], me)}
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

/**
 * Меню «⋯» сообщения: правка и удаление, чтобы не плодить кнопки.
 *
 * У чужой реплики правки нет вовсе — даже у модератора: `onEdit` там пуст, и
 * пункт не рисуется. Кнопка «переписать чужое своим текстом» не должна
 * существовать в интерфейсе, а не просто получать отказ от сервера.
 */
function MoreMenu({
  onEdit,
  onDelete,
  closeSignal,
}: {
  onEdit?: () => void;
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
          {onEdit && (
            <ActionBtn
              title={t('chat.action.edit')}
              onClick={() => {
                close();
                onEdit();
              }}
            >
              <Icon name="edit" className="text-[13px]" />
            </ActionBtn>
          )}
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

/**
 * Одно сообщение ленты: системное (вход/выход) или обычное.
 *
 * `memo` здесь не микрооптимизация: лента перерисовывалась целиком на каждое
 * входящее, на каждую реакцию и на каждый тик «печатает…», а каждая строка —
 * это своя капсула действий, разметка markdown и анимация framer. Все пропсы
 * стабильны (обработчики — useCallback у родителя), объекты сообщений в сторе
 * личность сохраняют, поэтому перерисовывается ровно та строка, что менялась.
 */
export const Message = memo(function Message({
  msg,
  mine,
  me,
  myFingerprint,
  enter,
  editing,
  moderated,
  owner,
  onReply,
  onStartEdit,
  onSubmitEdit,
  onCancelEdit,
  onDelete,
  onBan,
  onJumpTo,
}: {
  msg: ChatMessage;
  mine: boolean;
  me: string;
  /**
   * Отпечаток читающего. Им сверяются упоминания: имена не уникальны, и «тебя
   * назвали» по совпадению подписи зажигалось бы у тёзки.
   */
  myFingerprint?: string;
  enter: boolean;
  editing: boolean;
  /**
   * Этот канал модерируется тобой: сервер сказал `moderated` про его сервер.
   * Флаг приходит с сервера и не вычисляется здесь — иначе рано или поздно на
   * экране появилась бы кнопка, которая получает отказ.
   */
  moderated: boolean;
  /** Владелец инсталляции: только ему доступен бан на всю инсталляцию. */
  owner: boolean;
  onReply: (m: ChatMessage) => void;
  onStartEdit: (m: ChatMessage) => void;
  onSubmitEdit: (id: string, text: string) => void;
  onCancelEdit: () => void;
  onDelete: (m: ChatMessage) => void;
  onBan: (m: ChatMessage, everywhere: boolean) => void;
  onJumpTo: (id: string) => void;
}) {
  const t = useT();
  // Счётчик «мышь ушла с сообщения» — по нему AddReaction закрывает свой пикер.
  const [leaveTick, setLeaveTick] = useState(0);
  // Назвали именно тебя — не тёзку: сверяется отпечаток, а не подпись.
  const mentioned = !mine && mentions(msg.mentions, myFingerprint);
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
        // Удалить своё может автор; чужое — модератор сервера. Правку чужого
        // не предлагаем ни тому, ни другому: удалить сказанное — модерация,
        // переписать сказанное чужим именем — подлог.
        mine || moderated
          ? {
              id: 'msg-delete',
              label: t('chat.action.deleteMessage'),
              icon: 'trash' as const,
              danger: true,
              run: () => onDelete(msg),
            }
          : null,
        // Банить есть кого, только если у реплики есть автор-личность: за гостя
        // по инвайту ручается токен, и разговор с ним кончается «выгнать».
        !mine && moderated && msg.fingerprint && !msg.system
          ? {
              id: 'msg-ban',
              label: t('chat.action.ban'),
              icon: 'user-x' as const,
              danger: true,
              run: () => onBan(msg, false),
            }
          : null,
        !mine && moderated && owner && msg.fingerprint && !msg.system
          ? {
              id: 'msg-ban-everywhere',
              label: t('chat.action.banEverywhere'),
              icon: 'user-x' as const,
              danger: true,
              run: () => onBan(msg, true),
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
          В режиме правки даём умеренную фиксированную ширину под textarea.
          Реплика, в которой назвали тебя, подсвечена и в спокойном состоянии:
          это то, что глаз ищет, пролистывая пропущенный разговор. */}
      <div
        className={cn(
          'flex min-w-0 max-w-[min(100%,720px)] gap-3 rounded-[10px] px-2.5 py-1.5 transition-colors group-hover:bg-white/[0.03]',
          mentioned && 'bg-accent-strong/[0.08] shadow-[inset_2px_0_0_var(--color-accent-strong)]',
        )}
      >
        {/* Лицо автора рисуется из отпечатка его ключа, а не из имени: имена
            свободные и не уникальные, и градиент по имени у двух разных «Ань»
            совпал бы — то есть показывал бы ровно обратное тому, зачем он тут.
            Без отпечатка (гость по инвайту, реплика до 1.0) остаётся прежний
            градиент: у такой подписи и правда нет за спиной ничего, кроме имени. */}
        {msg.fingerprint ? (
          <Identicon
            fingerprint={msg.fingerprint}
            size={38}
            title={msg.fingerprint}
            className="mt-0.5 shrink-0 rounded-[10px]"
          />
        ) : (
          <div
            className="mt-0.5 h-[38px] w-[38px] shrink-0 rounded-full"
            style={avatarStyle(msg.name ?? '')}
          />
        )}
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
              {msg.text && (
                <MessageText text={msg.text} mentions={msg.mentions} me={myFingerprint} />
              )}
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
          {(mine || moderated) && (
            <MoreMenu
              onEdit={mine ? () => onStartEdit(msg) : undefined}
              onDelete={() => onDelete(msg)}
              closeSignal={leaveTick}
            />
          )}
        </div>
      )}
    </motion.div>
  );
});

/** Разделитель «новые сообщения» перед первой непрочитанной репликой. */
export function UnreadDivider() {
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
