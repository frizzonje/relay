import { create } from 'zustand';
import type { ChannelType } from '@relay/shared';

/**
 * UI-стор каркаса. Голос и текст — независимые подключения; `view` — лишь то,
 * что показано на экране. Открытие текстового канала не трогает голос и
 * наоборот. Сокет-эффекты (chat-join/leave) навешаны на изменения `textRoom`
 * в SocketProvider — стор остаётся «чистым».
 */
export type ShellView = 'lobby' | 'voice' | 'text';

/**
 * Активная мобильная панель. На узком экране колонки десктопа (рейка+сайдбар /
 * сцена / состав) не помещаются рядом — показываем по одной, переключение снизу
 * таб-баром. На десктопе (`md:`) значение игнорируется: видны все колонки сразу.
 */
export type MobilePanel = 'nav' | 'stage' | 'people';

interface UiState {
  view: ShellView;
  textRoom: string | null;
  textLabel: string;
  voiceRoom: string | null;
  voiceLabel: string;
  /** Тег пользователя (myName). Меняется только пока ты нигде не подключён. */
  callsign: string;
  setCallsign: (name: string) => void;
  /** Модалка создания направления — общая для рейки и сайдбара. */
  createChannelOpen: boolean;
  createChannelType: ChannelType;
  openCreateChannel: (type: ChannelType) => void;
  setCreateChannelOpen: (open: boolean) => void;
  /** Какая панель открыта на мобиле (см. MobilePanel). */
  mobilePanel: MobilePanel;
  setMobilePanel: (panel: MobilePanel) => void;
  /** Bottom sheet быстрого входа по коду/ссылке (мобильный доступ к лобби). */
  joinByCodeOpen: boolean;
  setJoinByCodeOpen: (open: boolean) => void;
  openText: (slug: string, label: string) => void;
  /** Закрыть текстовый канал: уходим к сетке (если в голосе) или в лобби. */
  leaveText: () => void;
  openVoice: (room: string, label: string) => void;
  goLobby: () => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  view: 'lobby',
  textRoom: null,
  textLabel: '',
  voiceRoom: null,
  voiceLabel: '',
  callsign: '',
  setCallsign: (name) => set({ callsign: name }),
  createChannelOpen: false,
  createChannelType: 'voice',
  openCreateChannel: (type) => set({ createChannelType: type, createChannelOpen: true }),
  setCreateChannelOpen: (open) => set({ createChannelOpen: open }),
  // Стартуем со списка каналов — как в мобильном Discord: сперва выбор, потом сцена.
  mobilePanel: 'nav',
  setMobilePanel: (panel) => set({ mobilePanel: panel }),
  joinByCodeOpen: false,
  setJoinByCodeOpen: (open) => set({ joinByCodeOpen: open }),
  openText: (slug, label) => set({ view: 'text', textRoom: slug, textLabel: label }),
  leaveText: () =>
    set({
      textRoom: null,
      textLabel: '',
      view: get().voiceRoom ? 'voice' : 'lobby',
    }),
  openVoice: (room, label) => set({ view: 'voice', voiceRoom: room, voiceLabel: label }),
  goLobby: () => set({ view: 'lobby' }),
}));

/** Имя для сокета/чата — пустой тег превращаем в «Аноним» (как myName()). */
export function myName(): string {
  return useUiStore.getState().callsign.trim() || 'Аноним';
}
