import type { ServerDeleteResult, ServerStatsResult } from '@relay/shared';
import { toast } from 'sonner';
import { getSocket } from '@/lib/socket';
import { loadClientId } from '@/lib/identity';
import { ask } from '@/lib/channels';
import { tx } from '@/lib/i18n';

/**
 * Действия над реестром серверов. Как и каналы — сервер единственный источник
 * правды: шлём намерение, обновлённый список прилетает событием `servers` всем
 * сразу. id генерируем на клиенте (crypto.randomUUID), чтобы тут же открыть
 * новый сервер и создать в нём первый канал, не дожидаясь ответа сокета.
 *
 * С каждым действием едет clientId — метка устройства. Сервер запоминает её
 * как владельца и отдаёт управление только ему: сервер, созданный этим
 * браузером, удалить может только он (каналы внутри — тоже только он;
 * заслон от случайного сноса, не личность — см. audit B2).
 */
export function createServer(server: {
  id: string;
  name: string;
  emoji?: string;
  password?: string;
}): void {
  const name = server.name.trim().slice(0, 32);
  if (!server.id || !name) return;
  getSocket().emit('server-create', {
    id: server.id,
    name,
    emoji: server.emoji,
    password: server.password || undefined,
    clientId: loadClientId(),
  });
}

/**
 * Удалить сервер. Возвращает true, если сервер согласился; при отказе сам
 * показывает тост с причиной. Удаление уносит каналы и переписку — спрашивает
 * отдельный диалог (DeleteServerDialog), сюда приходит уже подтверждённое.
 */
export async function deleteServer(id: string): Promise<boolean> {
  if (!id) return false;
  const res = await ask<ServerDeleteResult>('server-delete', { id, clientId: loadClientId() });
  if (res?.ok) return true;
  toast(res ? serverRefusalText(res.error) : tx('server.noAnswer'));
  return false;
}

function serverRefusalText(error: string): string {
  if (error === 'not-owner') return tx('server.refusal.notOwner');
  if (error === 'forbidden') return tx('server.refusal.forbidden');
  return tx('server.refusal.gone');
}

/**
 * Живой срез сервера для диалога удаления: сколько каналов и сообщений
 * исчезнет вместе с ним. null — сервер не ответил или не наше владение.
 */
export async function serverStats(
  id: string,
): Promise<{ channels: number; messages: number } | null> {
  if (!id) return null;
  const res = await ask<ServerStatsResult>('server-stats', { id, clientId: loadClientId() });
  return res?.ok ? { channels: res.channels, messages: res.messages } : null;
}

/** Попытка разблокировать закрытый сервер паролем (ответ придёт server-unlock-result). */
export function unlockServer(id: string, password: string): void {
  if (!id) return;
  // Запоминаем оптимистично: на успех пароль останется (авто-разблокировка после
  // reload), на неверный — SocketProvider его забудет.
  rememberServerPassword(id, password);
  getSocket().emit('server-unlock', { id, password });
}

// ===== Пароли закрытых серверов в localStorage =====
// Храним введённые верные пароли, чтобы автоматически разблокировать серверы
// после перезагрузки/reconnect (сокет-сессия недолговечна, а доступ — нет).
// Это client-side удобство; сервер всё равно проверяет пароль на каждый unlock.

const PW_PREFIX = 'relay-server-pw:';

export function rememberServerPassword(id: string, password: string): void {
  try {
    localStorage.setItem(PW_PREFIX + id, password);
  } catch {
    /* приватный режим/квота — не критично */
  }
}

export function forgetServerPassword(id: string): void {
  try {
    localStorage.removeItem(PW_PREFIX + id);
  } catch {
    /* no-op */
  }
}

/** Все сохранённые пароли — для авто-разблокировки на connect. */
export function storedServerPasswords(): { id: string; password: string }[] {
  const out: { id: string; password: string }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(PW_PREFIX)) {
        const password = localStorage.getItem(key);
        if (password) out.push({ id: key.slice(PW_PREFIX.length), password });
      }
    }
  } catch {
    /* no-op */
  }
  return out;
}
