import { MAIN_SERVER_ID, type ChannelType, type QuotaScope, type VoiceMode } from '@relay/shared';
import { toast } from 'sonner';
import { getSocket } from '@/lib/socket';
import { request } from '@/lib/request';
import { useServersStore } from '@/stores/servers';
import { tx } from '@/lib/i18n';

/**
 * Действия над реестром каналов. Сервер — единственный источник правды: мы лишь
 * шлём намерение, а обновлённый список прилетает событием `channels` всем сразу
 * (см. SocketProvider). Оптимистично ничего не рисуем — так у всех один порядок.
 * Канал создаётся в активном сервере (открытом в рейке).
 *
 * Удаление и переименование возвращают ack: отказ сервера («в канале люди»,
 * «канал по умолчанию», «это не ваш канал») человек должен увидеть, а не
 * гадать, почему строка осталась на месте.
 */

/**
 * Завести канал в открытом сервере. Возвращает true, если сервер согласился;
 * при отказе сам показывает тост с причиной — до 1.0 отказ был молчанием, и
 * человек, упёршийся в потолок или в занятое имя, видел ровно ничего.
 */
export async function createChannel(
  type: ChannelType,
  name: string,
  mode?: VoiceMode,
): Promise<boolean> {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const serverId = useServersStore.getState().activeServerId;
  // Набор главного сервера фиксирован — интерфейс сюда и не ведёт, но если
  // дорога всё же нашлась, объясняем, а не глотаем.
  if (serverId === MAIN_SERVER_ID) {
    toast(tx('channels.mainFixed'));
    return false;
  }
  // Владельцем канала сервер запишет личность за этим сокетом (см. lib/socket)
  // — менять канал сможет только она.
  const res = await request('channel-create', {
    serverId,
    type,
    name: trimmed,
    ...(mode ? { mode } : {}),
  });
  if (res?.ok) return true;
  toast(res ? refusalText(res.error, undefined, res) : tx('channels.noAnswer'));
  return false;
}

/** Человеческое объяснение отказа — одно на заведение, удаление и правку. */
function refusalText(
  error: string,
  occupants?: number,
  quota?: { scope?: QuotaScope; limit?: number },
): string {
  if (error === 'occupied') {
    return occupants
      ? tx('channels.refusal.occupiedCount', { count: occupants })
      : tx('channels.refusal.occupied');
  }
  if (error === 'forbidden') return tx('channels.refusal.forbidden');
  if (error === 'not-owner') return tx('channels.refusal.notOwner');
  if (error === 'bad-name') return tx('channels.refusal.badName');
  if (error === 'exists') return tx('channels.refusal.exists');
  // Потолок сервера человек чинит сам — удалит ненужный канал; потолок
  // инсталляции не чинится ничем, кроме доступа к машине, и обещать обратное
  // нельзя.
  if (error === 'limit') {
    const count = quota?.limit ?? 0;
    return quota?.scope === 'install'
      ? tx('channels.refusal.limitInstall', { count })
      : tx('channels.refusal.limitServer', { count });
  }
  return tx('channels.refusal.gone');
}

/**
 * Удалить канал. Возвращает true, если сервер согласился; при отказе сам
 * показывает тост с причиной — вызывающему остаётся только закрыть диалог.
 */
export async function deleteChannel(id: string): Promise<boolean> {
  if (!id) return false;
  const res = await request('channel-delete', { id });
  if (res?.ok) return true;
  toast(res ? refusalText(res.error, res.occupants) : tx('channels.noAnswer'));
  return false;
}

/**
 * Переименовать канал (имя, не адрес). Пустое имя не отправляем вовсе; длину
 * режет сервер по настройке `spaces.channelNameMaxLength`, как и при создании.
 */
export async function renameChannel(id: string, name: string): Promise<boolean> {
  const trimmed = name.trim();
  if (!id || !trimmed) return false;
  const res = await request('channel-rename', { id, name: trimmed });
  if (res?.ok) return true;
  toast(res ? refusalText(res.error) : tx('channels.noAnswer'));
  return false;
}

/** Живой срез канала для диалога удаления. null — сервер не ответил/не знает. */
export async function channelStats(
  id: string,
): Promise<{ occupants: number; messages: number } | null> {
  const res = await request('channel-stats', { id });
  return res?.ok ? { occupants: res.occupants, messages: res.messages } : null;
}

/**
 * Сменить транспорт голосового канала. Сервер пустит только создателя — у
 * дефолтных каналов режим не меняется вовсе (там всегда p2p).
 */
export function setChannelMode(id: string, mode: VoiceMode): void {
  if (!id) return;
  getSocket().emit('channel-mode', { id, mode });
}
