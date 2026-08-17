'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  MAX_UPLOAD_BYTES,
  type ChatHistoryMoreResult,
  type ChatMessage,
  type ChatWindowResult,
  type ReplyRef,
  type UploadResponse,
} from '@relay/shared';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/ui/icon';
import { fmtBytes } from '@/lib/format';
import { getSocket } from '@/lib/socket';
import { ask } from '@/lib/channels';
import { useRetentionDays } from '@/lib/use-sfu';
import { useUiStore } from '@/stores/ui';
import { useChannelsStore } from '@/stores/channels';
import { useChatStore } from '@/stores/chat';
import { useOwnerStore } from '@/stores/owner';
import { useServersStore } from '@/stores/servers';
import { useUnreadStore } from '@/stores/unread';
import { useSearchStore } from '@/stores/search';
import { myName } from '@/stores/ui';
import { BanAuthorDialog, type BanTarget } from '@/components/chat/BanAuthorDialog';
import { DeleteMessageDialog } from '@/components/chat/DeleteMessageDialog';
import { Message, UnreadDivider } from '@/components/chat/Message';
import { SearchPanel } from '@/components/chat/SearchPanel';
import { tx, useRichT, useT } from '@/lib/i18n';

interface PendingFile {
  id: string;
  file: File;
  previewUrl?: string;
  spoiler: boolean;
}

/** Черновик ответа: снимок цитируемого сообщения, живёт в композере до отправки. */
type Draft = ReplyRef;

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
  const more = useChatStore((s) => s.more);
  const loadingMore = useChatStore((s) => s.loadingMore);
  // Лента стоит в прошлом — так бывает после перехода из поиска. Ниже
  // показанного есть ещё канал, и «вниз» перестаёт значить «к последним».
  const moreAfter = useChatStore((s) => s.moreAfter);
  const jump = useChatStore((s) => s.jump);
  const searchOpen = useSearchStore((s) => s.open);
  const retentionDays = useRetentionDays();
  // Право модерировать приходит с сервера — флагом на сервере реестра, которому
  // принадлежит открытый канал. Вычислять его здесь было бы гаданием: у
  // главного сервера создателя нет, и «моё» там истинно у всех.
  const channels = useChannelsStore((s) => s.channels);
  const servers = useServersStore((s) => s.servers);
  const owner = useOwnerStore((s) => s.owner);
  const channelServer = servers.find(
    (sv) => sv.id === channels.find((c) => c.type === 'text' && c.slug === textRoom)?.serverId,
  );
  const moderated = channelServer?.moderated === true;

  const [text, setText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [reply, setReply] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ChatMessage | null>(null);
  const [pendingBan, setPendingBan] = useState<BanTarget | null>(null);
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
  // Высота ленты до того, как сверху вставится страница. По разнице возвращаем
  // прокрутку на прежнее место: без этого подгрузка утаскивала бы читателя
  // вверх ровно на высоту приехавшего.
  const anchorHeight = useRef<number | null>(null);
  // Канал, для которого ленту уже поставили на свежие сообщения.
  const pinnedFor = useRef<string | null>(null);
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

  // Приехала страница сверху — возвращаем прокрутку туда, где читатель и был.
  // Слоем layout, а не обычным эффектом: между вставкой и правкой scrollTop не
  // должно быть ни одного кадра, иначе лента дёргается.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || anchorHeight.current === null) return;
    el.scrollTop += el.scrollHeight - anchorHeight.current;
    anchorHeight.current = null;
    prevLen.current = messages.length;
  }, [messages]);

  // Вход в канал ставит человека на свежие сообщения, а не на верх страницы.
  // Раньше это выходило само собой: истории было ровно столько, сколько
  // помещалось в память, и лента почти всегда была короткой. Теперь страница
  // приезжает готовым куском, и «уже у дна» на ней не выполняется — надо
  // сказать явно.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !messages.length || pinnedFor.current === textRoom) return;
    pinnedFor.current = textRoom;
    prevLen.current = messages.length;
    el.scrollTo({ top: el.scrollHeight });
    setHasNew(false);
    // Страница короче экрана, а выше что-то есть: прокрутить вверх человеку
    // нечем, поэтому подтягиваем сами — иначе история выглядит законченной.
    if (el.scrollHeight <= el.clientHeight && useChatStore.getState().more) void loadOlder();
  }, [messages, textRoom]);

  // Автопрокрутка вниз, если уже у дна; иначе, если лента выросла — зажигаем «вниз».
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Лента переехала в прошлое (переход из поиска) — тащить её вниз нельзя:
    // человека несло бы прочь от того, что он только что открыл.
    if (useChatStore.getState().jump || useChatStore.getState().moreAfter) return;
    // Подгрузка вверх — не «пришло новое»: значок «вниз» на неё зажигаться не
    // должен, читатель сам её и попросил.
    const grew = messages.length > prevLen.current && anchorHeight.current === null;
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
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const bottom = fromBottom < 80;
    setAtBottom(bottom);
    // Отскроллен вверх — входящие не считаются прочитанными (stores/unread).
    // Пока лента стоит в прошлом, «у дна» не бывает вовсе: под видимым лежит
    // ещё канал, и считать это дочитанным было бы неправдой.
    useUnreadStore.getState().setAtBottom(bottom && !useChatStore.getState().moreAfter);
    if (bottom) setHasNew(false);
    // Подтягиваем заранее, за экран до края: страница успевает приехать, пока
    // человек ещё листает, и лента не упирается в пустоту.
    if (el.scrollTop < el.clientHeight) void loadOlder();
    if (fromBottom < el.clientHeight) void loadNewer();
  }

  /**
   * Страница выше показанной. Курсор — верхняя реплика на экране; системные
   * строки в нём годятся так же, как обычные: сервер сортирует по времени и id,
   * а не по смыслу.
   */
  async function loadOlder() {
    const el = scrollRef.current;
    const state = useChatStore.getState();
    const top = state.messages[0];
    if (!el || !state.more || state.loadingMore || !top?.id) return;

    state.setLoadingMore(true);
    anchorHeight.current = el.scrollHeight;
    const page = await ask<ChatHistoryMoreResult>('chat-history-more', {
      beforeTs: top.ts,
      beforeId: top.id,
    });
    if (!page) {
      // Ответа не дождались — не врём, что история кончилась: пусть попробует
      // ещё раз, прокрутив ленту.
      anchorHeight.current = null;
      useChatStore.getState().setLoadingMore(false);
      return;
    }
    useChatStore.getState().prependHistory(page.messages, page.more);
  }

  /**
   * Страница ниже показанной. Спрашивается только у ленты, стоящей в прошлом:
   * у живого конца канала ниже ничего нет, и лишний запрос там был бы вопросом,
   * ответ на который известен заранее.
   */
  async function loadNewer() {
    const state = useChatStore.getState();
    const bottom = state.messages[state.messages.length - 1];
    if (!state.moreAfter || state.loadingAfter || !bottom?.id) return;

    state.setLoadingAfter(true);
    const page = await ask<ChatWindowResult>('chat-history-after', {
      afterTs: bottom.ts,
      afterId: bottom.id,
    });
    if (!page) {
      useChatStore.getState().setLoadingAfter(false);
      return;
    }
    useChatStore.getState().appendHistory(page.messages, page.moreAfter);
  }

  /**
   * Кнопка внизу ленты делает разное. У живого канала — просто прокручивает
   * вниз. У ленты, стоящей в прошлом, прокрутка ни к чему не приведёт: под ней
   * лежит непрогруженное, и вернуться к последним можно только заново спросив
   * канал — тем же входом, каким он открывается.
   */
  function jumpToBottom() {
    if (useChatStore.getState().moreAfter && textRoom) {
      getSocket().emit('chat-join', { room: textRoom, name: myName() });
      pinnedFor.current = null;
      setHasNew(false);
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setHasNew(false);
  }

  // Прокрутить к оригиналу цитаты и коротко подсветить его.
  const jumpTo = useCallback((id: string) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-mid="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('msg-flash');
    setTimeout(() => el.classList.remove('msg-flash'), 1200);
  }, []);

  // Переход из поиска: встать на найденное и подсветить его. Эффект ждёт саму
  // ленту — окно приезжает вместе с id, но нарисовано будет позже, поэтому
  // зависимость и от сообщений тоже.
  useEffect(() => {
    if (!jump) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-mid="${jump}"]`);
    if (!el) return;
    // Без анимации: сюда пришли прицельно, и проматывать перед человеком
    // полканала ради красоты незачем.
    el.scrollIntoView({ block: 'center' });
    el.classList.add('msg-flash');
    useChatStore.getState().setJump(null);
    const timer = setTimeout(() => el.classList.remove('msg-flash'), 1200);
    return () => clearTimeout(timer);
  }, [jump, messages]);

  // Хоткей поиска. `code`, а не `key`: на кириллице «F» — это буква «А», и
  // привязка к букве работала бы у половины пользователей.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.code !== 'KeyF' || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      e.preventDefault();
      useSearchStore.getState().setOpen(true);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Ушли из текстового канала совсем — панель поиска закрываем. Переход по
  // найденному в соседний канал сюда не попадает: там лента не размонтируется,
  // и результаты остаются на месте, чтобы можно было открыть следующий.
  useEffect(() => () => useSearchStore.getState().setOpen(false), []);

  // Обработчики строки сообщения — стабильные (useCallback): ими живёт memo у
  // Message. Новая реплика меняет лишь свои пропсы, а не пропсы всей ленты.
  const startReply = useCallback((m: ChatMessage) => {
    if (!m.id || !m.name) return;
    setReply({ id: m.id, name: m.name, text: m.text.slice(0, 140) });
    setEditingId(null);
    inputRef.current?.focus();
  }, []);

  const submitEdit = useCallback((id: string, newText: string) => {
    getSocket().emit('chat-edit', { id, text: newText });
    setEditingId(null);
  }, []);

  const deleteMessage = useCallback((m: ChatMessage) => {
    if (m.id) setPendingDelete(m);
  }, []);

  const banAuthor = useCallback(
    (m: ChatMessage, everywhere: boolean) => {
      if (m.id) setPendingBan({ message: m, everywhere, server: channelServer?.name ?? '' });
    },
    [channelServer?.name],
  );

  const startEdit = useCallback((m: ChatMessage) => setEditingId(m.id ?? null), []);
  const cancelEdit = useCallback(() => setEditingId(null), []);

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
        // Лента — единственный прокручиваемый контейнер, у которого есть
        // поведение (подгрузка вверх), и e2e должен находить именно его, а не
        // угадывать по классам вёрстки.
        data-feed
        className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-4 pb-2 pt-4"
      >
        {/* Верх ленты отвечает на вопрос «а что было раньше?» — и три ответа
            на него разные: выше есть ещё, выше начало канала, выше уже
            удалено ретенцией. Рисовать их одинаково значит врать. */}
        {more ? (
          <div className="px-4 pb-3 pt-7 text-center text-[13px] leading-[1.5] text-text-muted">
            {loadingMore ? t('chat.history.loading') : '⋯'}
          </div>
        ) : (
          <div className="px-4 pb-3 pt-7 text-center text-[13px] leading-[1.5] text-text-muted">
            {rt('chat.start', {
              channel: <b className="text-text-header">#{textLabel}</b>,
            })}
            {retentionDays > 0 && (
              <div className="pt-1 text-text-muted/70">
                {t('chat.history.edge', { days: retentionDays })}
              </div>
            )}
          </div>
        )}
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
              onStartEdit={startEdit}
              onSubmitEdit={submitEdit}
              onCancelEdit={cancelEdit}
              moderated={moderated}
              owner={owner}
              onDelete={deleteMessage}
              onBan={banAuthor}
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

      {/* «Вниз к новым» — когда лента прокручена вверх. У ленты, стоящей в
          прошлом, кнопка нужна и у самого низа окна: низ окна — это не конец
          канала, и без неё оттуда некуда возвращаться. */}
      <AnimatePresence>
        {(!atBottom || moreAfter) && (
          <motion.button
            type="button"
            onClick={jumpToBottom}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.14 }}
            className={cn(
              'absolute z-20 flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] shadow-lg backdrop-blur transition-colors',
              // Открытый поиск занимает правый край ленты — кнопка уходит от
              // него влево, иначе она оказывается под панелью и по ней нечем
              // попасть. На мобиле панель во весь экран, и ленты не видно вовсе.
              searchOpen ? 'right-[396px] max-md:right-5' : 'right-5',
              hasNew
                ? 'border-accent-strong/40 bg-accent-strong/90 text-bg-app hover:brightness-95'
                : 'border-line bg-bg-panel/95 text-text hover:bg-bg-active',
            )}
            style={{ bottom: pending.length || reply ? 132 : 84 }}
          >
            {t(moreAfter ? 'chat.jump.present' : hasNew ? 'chat.jump.new' : 'chat.jump.bottom')}
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

      <BanAuthorDialog target={pendingBan} onOpenChange={(open) => !open && setPendingBan(null)} />

      <SearchPanel />
    </div>
  );
}
