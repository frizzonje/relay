import { create } from 'zustand';
import type { ChatMessage, MentionRef, ReactionMap } from '@relay/shared';

/**
 * Состояние открытого текстового канала: лента сообщений, состав и кто печатает.
 * Сообщения копятся глобально — даже пока смотришь голос, входящие
 * в подписанный канал не теряются.
 * Сброс — при смене канала (chat-join) и при реконнекте (история приходит заново).
 */
interface ChatState {
  messages: ChatMessage[];
  roster: string[];
  /** Теги тех, кто прямо сейчас печатает в открытом канале (кроме тебя). */
  typing: string[];
  /**
   * Выше показанного есть ещё. С 1.0 история не влезает в один снимок, и это
   * единственное, чем «дальше ничего нет» отличается от «дальше не загружено».
   */
  more: boolean;
  /** Страница уже запрошена — чтобы не запросить её же ещё пять раз при скролле. */
  loadingMore: boolean;
  /**
   * Ниже показанного тоже есть ещё — то есть человек смотрит не живой конец
   * канала, а его прошлое: так бывает после перехода из поиска. У обычной ленты
   * это всегда `false`, и «вниз» означает просто прокрутку.
   */
  moreAfter: boolean;
  loadingAfter: boolean;
  /**
   * К какой реплике прокрутиться и подсветить её. Живёт в сторе, а не в
   * компоненте, потому что путь сюда идёт снаружи ленты — из результатов
   * поиска, иногда вместе со сменой канала.
   */
  jump: string | null;
  reset: () => void;
  addMessage: (m: ChatMessage) => void;
  setHistory: (list: ChatMessage[], more: boolean) => void;
  /** Страница сверху: приезжает при подгрузке вверх. */
  prependHistory: (list: ChatMessage[], more: boolean) => void;
  /** Страница снизу — только когда лента стоит в прошлом. */
  appendHistory: (list: ChatMessage[], moreAfter: boolean) => void;
  /** Окно вокруг найденного: заменяет ленту целиком, «ещё» с обеих сторон. */
  setWindow: (list: ChatMessage[], more: boolean, moreAfter: boolean) => void;
  setJump: (id: string | null) => void;
  setLoadingMore: (value: boolean) => void;
  setLoadingAfter: (value: boolean) => void;
  setRoster: (names: string[]) => void;
  setTyping: (names: string[]) => void;
  applyReaction: (id: string, reactions: ReactionMap) => void;
  /** Правка: текст, время и упоминания новой редакции (имя могли и убрать). */
  applyEdit: (id: string, text: string, editedTs: number, mentions?: MentionRef[]) => void;
  applyDelete: (id: string) => void;
  /** Реплику закрепили или открепили — пометка в ленте. */
  applyPinned: (id: string, pinned: boolean) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  roster: [],
  typing: [],
  more: false,
  loadingMore: false,
  moreAfter: false,
  loadingAfter: false,
  jump: null,
  reset: () =>
    set({
      messages: [],
      roster: [],
      typing: [],
      more: false,
      loadingMore: false,
      moreAfter: false,
      loadingAfter: false,
      jump: null,
    }),
  // Новая реплика в ленту, стоящую в прошлом, не попадает: она не «следующая»
  // за показанным, между ними лежит непрогруженное. Ждать её человеку не надо —
  // канал у него не заканчивается на видимом, о чём и говорит `moreAfter`.
  addMessage: (m) => set((s) => (s.moreAfter ? s : { messages: [...s.messages, m] })),
  // Живая последняя страница — это и есть «вернулись к последним»: ни низа за
  // горизонтом, ни цели перехода, которой в новой ленте может уже не быть.
  setHistory: (list, more) =>
    set({
      messages: list,
      more,
      loadingMore: false,
      moreAfter: false,
      loadingAfter: false,
      jump: null,
    }),
  appendHistory: (list, moreAfter) =>
    set((s) => {
      const known = new Set(s.messages.map((m) => m.id));
      const fresh = list.filter((m) => !m.id || !known.has(m.id));
      return { messages: [...s.messages, ...fresh], moreAfter, loadingAfter: false };
    }),
  setWindow: (list, more, moreAfter) =>
    set({ messages: list, more, moreAfter, loadingMore: false, loadingAfter: false }),
  setJump: (id) => set({ jump: id }),
  setLoadingAfter: (value) => set({ loadingAfter: value }),
  prependHistory: (list, more) =>
    set((s) => {
      // Страница могла обогнать удаление или прийти дважды по двойному клику:
      // склеиваем по id, а не по длине.
      const known = new Set(s.messages.map((m) => m.id));
      const fresh = list.filter((m) => !m.id || !known.has(m.id));
      return { messages: [...fresh, ...s.messages], more, loadingMore: false };
    }),
  setLoadingMore: (value) => set({ loadingMore: value }),
  setRoster: (names) => set({ roster: names }),
  setTyping: (names) => set({ typing: names }),
  applyReaction: (id, reactions) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, reactions } : m)),
    })),
  applyEdit: (id, text, editedTs, mentions) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === id ? { ...m, text, editedTs, mentions: mentions ?? [] } : m,
      ),
    })),
  applyDelete: (id) => set((s) => ({ messages: s.messages.filter((m) => m.id !== id) })),
  // Пометки нет вовсе, а не `pinned: false`: у реплики её либо видно, либо нет,
  // и второе значение «выключено» отличалось бы от «не приходило» только тем,
  // что о нём надо помнить в каждой проверке.
  applyPinned: (id, pinned) =>
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.id !== id) return m;
        if (pinned) return { ...m, pinned: true as const };
        const { pinned: _was, ...rest } = m;
        return rest;
      }),
    })),
}));
