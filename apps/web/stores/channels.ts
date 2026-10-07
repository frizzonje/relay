import { create } from 'zustand';
import { DEFAULT_CHANNELS, type Channel } from '@relay/shared';

/**
 * Реестр направлений — зеркало серверного списка. Сид (DEFAULT_CHANNELS) виден
 * мгновенно и до прихода `channels`-события, и если API недоступен. Как только
 * сервер пришлёт актуальный список (на connect и при любом изменении),
 * SocketProvider заменит его целиком.
 */
interface ChannelsState {
  channels: Channel[];
  setChannels: (channels: Channel[]) => void;
}

export const useChannelsStore = create<ChannelsState>((set) => ({
  channels: [...DEFAULT_CHANNELS],
  setChannels: (channels) => set({ channels }),
}));
