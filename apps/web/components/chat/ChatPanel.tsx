'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  MAX_UPLOAD_BYTES,
  REACTION_EMOJIS,
  type ChatMessage,
  type UploadResponse,
} from '@relay/shared';
import { cn } from '@/lib/utils';
import { chatMessage, springPop } from '@/lib/motion';
import { avatarStyle } from '@/lib/avatar';
import { fmtBytes, fmtClock } from '@/lib/format';
import { getSocket } from '@/lib/socket';
import { useUiStore } from '@/stores/ui';
import { useChatStore } from '@/stores/chat';
import { MessageAttachment } from '@/components/chat/MessageAttachment';

interface PendingFile {
  id: string;
  file: File;
  previewUrl?: string;
}

/** Полоса предпросмотра ещё не отправленных вложений — над композером. */
function PendingAttachments({
  items,
  onRemove,
}: {
  items: PendingFile[];
  onRemove: (id: string) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-2 px-1">
      {items.map((p) => (
        <div key={p.id} className="group/preview relative shrink-0">
          {p.previewUrl ? (
            <img
              src={p.previewUrl}
              alt={p.file.name}
              className="h-16 w-16 rounded-lg border border-white/10 object-cover"
            />
          ) : (
            <div className="flex h-16 w-16 flex-col items-center justify-center gap-1 rounded-lg border border-white/10 bg-bg-active px-1 text-center">
              <span className="text-lg leading-none">📄</span>
              <span className="w-full truncate text-[9px] text-text-muted">{p.file.name}</span>
            </div>
          )}
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

/** Текст сообщения. */
function MessageText({ text }: { text: string }) {
  return (
    <div className="whitespace-pre-wrap break-words text-[15px] leading-[1.4] text-text">
      {text}
    </div>
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
              {/* key по счётчику: число «щёлкает» при изменении, не переползая */}
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

/** Кнопка-«смайлик» (видна при наведении на сообщение) с попапом выбора реакции. */
function AddReaction({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Поставить реакцию"
        className={cn(
          'grid h-7 w-7 place-items-center rounded-md bg-bg-deep/80 text-sm shadow ring-1 ring-white/10 transition-colors hover:bg-bg-active',
          !open && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
        )}
      >
        🙂
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.9 }}
            transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
            style={{ transformOrigin: 'top left' }}
            className="absolute left-0 top-8 z-10 flex gap-0.5 rounded-lg border border-white/10 bg-bg-deep p-1 shadow-xl"
          >
            {REACTION_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => {
                  react(id, emoji);
                  setOpen(false);
                }}
                className="grid h-8 w-8 place-items-center rounded-md text-lg transition-transform hover:scale-125 hover:bg-white/10"
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

/** Одно сообщение ленты: системное (вход/выход) или обычное. */
function Message({
  msg,
  mine,
  me,
  enter,
}: {
  msg: ChatMessage;
  mine: boolean;
  me: string;
  enter: boolean;
}) {
  // enter=false для истории при открытии канала — тогда сообщения появляются
  // мгновенно; новые (пришедшие уже открытым каналом) — с подъёмом.
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
    <motion.div {...anim} className="group flex items-start">
      <div className="flex min-w-0 max-w-full gap-3 rounded-md px-2 py-1 hover:bg-black/[0.12]">
        <div
          className="mt-0.5 h-[38px] w-[38px] shrink-0 rounded-full"
          style={avatarStyle(msg.name ?? '')}
        />
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                'text-[15px] font-semibold',
                mine ? 'text-[#79a6ff]' : 'text-text-header',
              )}
            >
              {msg.name}
            </span>
            <span className="text-[11px] text-text-muted">{fmtClock(msg.ts)}</span>
          </div>
          {msg.text && <MessageText text={msg.text} />}
          {msg.attachment && <MessageAttachment att={msg.attachment} />}
          {msg.id && msg.reactions && <ReactionBar id={msg.id} reactions={msg.reactions} me={me} />}
        </div>
      </div>
      {msg.id && (
        <div className="ml-1 mt-1 shrink-0">
          <AddReaction id={msg.id} />
        </div>
      )}
    </motion.div>
  );
}

/**
 * Текстовый канал: лента сообщений и композер со скрепкой. Подписка/история
 * живут в SocketProvider; здесь — рендер ленты и отправка.
 */
export function ChatPanel() {
  const textLabel = useUiStore((s) => s.textLabel);
  const textRoom = useUiStore((s) => s.textRoom);
  const callsign = useUiStore((s) => s.callsign);
  const messages = useChatStore((s) => s.messages);

  const [text, setText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<PendingFile[]>([]);

  const me = callsign.trim() || 'Аноним';

  // Анимируем ВХОД сообщений только после того, как канал прогрузил историю:
  // иначе вся лента «влетает» пачкой при открытии. Гасим на смену канала,
  // включаем через пару кадров — тогда подъёмом появляются лишь новые реплики.
  const [enterAnim, setEnterAnim] = useState(false);
  useEffect(() => {
    setEnterAnim(false);
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setEnterAnim(true)));
    return () => cancelAnimationFrame(raf);
  }, [textRoom]);

  // Автопрокрутка вниз, если уже у дна (как atBottom-логика в addChatMessage).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (atBottom)
      el.scrollTo({ top: el.scrollHeight, behavior: enterAnim ? 'smooth' : 'auto' });
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

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!textRoom) return;
    const t = text.trim();
    if (!t && pending.length === 0) return;
    const files = pending;
    setPending([]);
    setText('');
    if (files.length) await uploadFiles(files.map((p) => p.file));
    files.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl));
    if (t) getSocket().emit('chat-message', { text: t });
  }

  async function uploadFiles(files: File[]) {
    if (!textRoom || !files.length) return;
    setUploading(true);
    try {
      for (const file of files) {
        const fd = new FormData();
        fd.append('file', file);
        try {
          const base = process.env.NEXT_PUBLIC_API_URL || '';
          const res = await fetch(`${base}/api/upload`, {
            method: 'POST',
            body: fd,
            credentials: 'include',
          });
          if (!res.ok) throw new Error(`upload failed: ${res.status}`);
          const att = (await res.json()) as UploadResponse;
          getSocket().emit('chat-message', { uploadId: att.id });
        } catch (err) {
          console.error(err);
          toast.error(`Не удалось отправить файл «${file.name}».`);
        }
      }
    } finally {
      setUploading(false);
    }
  }

  // Добавляет выбранные файлы в предпросмотр — не отправляет их сразу
  // (чтобы пользователь видел, что именно улетит в канал, прежде чем это случится).
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-4 pb-2 pt-4">
        <div className="px-4 pb-3 pt-7 text-center text-[13px] leading-[1.5] text-text-muted">
          Это начало канала <b className="text-text-header">#{textLabel}</b>. Поздоровайтесь.
        </div>
        {messages.map((m, i) => (
          <Message
            key={m.id ?? i}
            msg={m}
            mine={!m.system && m.name === me}
            me={me}
            enter={enterAnim}
          />
        ))}
      </div>

      <div className="shrink-0 px-4 pb-5 pt-1">
        <PendingAttachments items={pending} onRemove={removePending} />
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
              value={text}
              onChange={(e) => setText(e.target.value)}
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
