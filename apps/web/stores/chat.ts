import { create } from 'zustand';
import type { ChatMessage, ReactionMap } from '@relay/shared';

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
  reset: () => void;
  addMessage: (m: ChatMessage) => void;
  setHistory: (list: ChatMessage[], more: boolean) => void;
  /** Страница сверху: приезжает при подгрузке вверх. */
  prependHistory: (list: ChatMessage[], more: boolean) => void;
  setLoadingMore: (value: boolean) => void;
  setRoster: (names: string[]) => void;
  setTyping: (names: string[]) => void;
  applyReaction: (id: string, reactions: ReactionMap) => void;
  applyEdit: (id: string, text: string, editedTs: number) => void;
  applyDelete: (id: string) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  roster: [],
  typing: [],
  more: false,
  loadingMore: false,
  reset: () => set({ messages: [], roster: [], typing: [], more: false, loadingMore: false }),
  addMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
  setHistory: (list, more) => set({ messages: list, more, loadingMore: false }),
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
  applyEdit: (id, text, editedTs) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, text, editedTs } : m)),
    })),
  applyDelete: (id) => set((s) => ({ messages: s.messages.filter((m) => m.id !== id) })),
}));
