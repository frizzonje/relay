import type { ChannelType, VoiceMode } from '@relay/shared';
import { getSocket } from '@/lib/socket';
import { useServersStore } from '@/stores/servers';

/**
 * Действия над реестром каналов. Сервер — единственный источник правды: мы лишь
 * шлём намерение, а обновлённый список прилетает событием `channels` всем сразу
 * (см. SocketProvider). Оптимистично ничего не рисуем — так у всех один порядок.
 * Канал создаётся в активном сервере (открытом в рейке).
 */
export function createChannel(type: ChannelType, name: string, mode?: VoiceMode): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  const serverId = useServersStore.getState().activeServerId;
  getSocket().emit('channel-create', { serverId, type, name: trimmed, ...(mode ? { mode } : {}) });
}

export function deleteChannel(id: string): void {
  if (!id) return;
  getSocket().emit('channel-delete', { id });
}

/**
 * Сменить транспорт голосового канала. Сервер пустит только для созданных
 * участниками каналов — у дефолтных режим не меняется (там всегда p2p).
 */
export function setChannelMode(id: string, mode: VoiceMode): void {
  if (!id) return;
  getSocket().emit('channel-mode', { id, mode });
}
