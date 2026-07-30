import type {
  ChannelDeleteResult,
  ChannelRenameResult,
  ChannelStatsResult,
  ChannelType,
  VoiceMode,
} from '@relay/shared';
import { toast } from 'sonner';
import { getSocket } from '@/lib/socket';
import { MAIN_SERVER_ID } from '@/lib/constants';
import { useServersStore } from '@/stores/servers';
import { tx } from '@/lib/i18n';

/**
 * Действия над реестром каналов. Сервер — единственный источник правды: мы лишь
 * шлём намерение, а обновлённый список прилетает событием `channels` всем сразу
 * (см. SocketProvider). Оптимистично ничего не рисуем — так у всех один порядок.
 * Канал создаётся в активном сервере (открытом в рейке).
 *
 * Удаление и переименование возвращают ack: отказ сервера («в канале люди»,
 * «канал по умолчанию») человек должен увидеть, а не гадать, почему строка
 * осталась на месте.
 */

/** Ack может не прийти вовсе (обрыв) — не ждём вечно. */
const ACK_TIMEOUT_MS = 6000;

export function createChannel(type: ChannelType, name: string, mode?: VoiceMode): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  const serverId = useServersStore.getState().activeServerId;
  // Набор главного сервера фиксирован (сервер откажет молча) — интерфейс сюда
  // и не ведёт, но если дорога всё же нашлась, объясняем, а не глотаем.
  if (serverId === MAIN_SERVER_ID) {
    toast(tx('channels.mainFixed'));
    return;
  }
  getSocket().emit('channel-create', { serverId, type, name: trimmed, ...(mode ? { mode } : {}) });
}

/** Человеческое объяснение отказа — то же самое и для удаления, и для правки. */
function refusalText(error: string, occupants?: number): string {
  if (error === 'occupied') {
    return occupants
      ? tx('channels.refusal.occupiedCount', { count: occupants })
      : tx('channels.refusal.occupied');
  }
  if (error === 'forbidden') return tx('channels.refusal.forbidden');
  if (error === 'bad-name') return tx('channels.refusal.badName');
  return tx('channels.refusal.gone');
}

/**
 * Удалить канал. Возвращает true, если сервер согласился; при отказе сам
 * показывает тост с причиной — вызывающему остаётся только закрыть диалог.
 */
export async function deleteChannel(id: string): Promise<boolean> {
  if (!id) return false;
  const res = await ask<ChannelDeleteResult>('channel-delete', { id });
  if (res?.ok) return true;
  toast(res ? refusalText(res.error, res.occupants) : tx('channels.noAnswer'));
  return false;
}

/** Переименовать канал (имя, не адрес). Пустое имя не отправляем вовсе. */
export async function renameChannel(id: string, name: string): Promise<boolean> {
  const trimmed = name.trim().slice(0, 32);
  if (!id || !trimmed) return false;
  const res = await ask<ChannelRenameResult>('channel-rename', { id, name: trimmed });
  if (res?.ok) return true;
  toast(res ? refusalText(res.error) : tx('channels.noAnswer'));
  return false;
}

/** Живой срез канала для диалога удаления. null — сервер не ответил/не знает. */
export async function channelStats(
  id: string,
): Promise<{ occupants: number; messages: number } | null> {
  const res = await ask<ChannelStatsResult>('channel-stats', { id });
  return res?.ok ? { occupants: res.occupants, messages: res.messages } : null;
}

/**
 * Сменить транспорт голосового канала. Сервер пустит только для созданных
 * участниками каналов — у дефолтных режим не меняется (там всегда p2p).
 */
export function setChannelMode(id: string, mode: VoiceMode): void {
  if (!id) return;
  getSocket().emit('channel-mode', { id, mode });
}

/** Событие с ack и тайм-аутом; null — ответа не дождались. */
function ask<T>(event: string, payload: unknown): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: T | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => done(null), ACK_TIMEOUT_MS);
    // Типы событий сокета сужены до конкретных пар payload/ack — здесь же
    // событие приходит строкой, поэтому вызов идёт мимо перегрузок.
    (getSocket().emit as (e: string, p: unknown, cb: (res: T) => void) => void)(
      event,
      payload,
      done,
    );
  });
}
