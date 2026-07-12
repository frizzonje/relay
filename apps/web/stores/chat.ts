import { create } from 'zustand';
import type { ChatMessage, ReactionMap } from '@relay/shared';

/**
 * Состояние открытого текстового канала: лента сообщений и состав.
 * Сообщения копятся глобально — даже пока смотришь голос, входящие
 * в подписанный канал не теряются.
 * Сброс — при смене канала (chat-join) и при реконнекте (история приходит заново).
 */
interface ChatState {
  messages: ChatMessage[];
  roster: string[];
  reset: () => void;
  addMessage: (m: ChatMessage) => void;
  setHistory: (list: ChatMessage[]) => void;
  setRoster: (names: string[]) => void;
  applyReaction: (id: string, reactions: ReactionMap) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  roster: [],
  reset: () => set({ messages: [], roster: [] }),
  addMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
  setHistory: (list) => set({ messages: list }),
  setRoster: (names) => set({ roster: names }),
  applyReaction: (id, reactions) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, reactions } : m)),
    })),
}));
