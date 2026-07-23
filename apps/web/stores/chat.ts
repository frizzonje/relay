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
  reset: () => void;
  addMessage: (m: ChatMessage) => void;
  setHistory: (list: ChatMessage[]) => void;
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
  reset: () => set({ messages: [], roster: [], typing: [] }),
  addMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
  setHistory: (list) => set({ messages: list }),
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
  applyDelete: (id) =>
    set((s) => ({ messages: s.messages.filter((m) => m.id !== id) })),
}));
