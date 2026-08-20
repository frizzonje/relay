import type {
  QuotaScope,
  ServerCreateResult,
  ServerDeleteResult,
  ServerStatsResult,
} from '@relay/shared';
import { toast } from 'sonner';
import { getSocket } from '@/lib/socket';
import { ask } from '@/lib/channels';
import { tx } from '@/lib/i18n';

/**
 * Действия над реестром серверов. Как и каналы — сервер единственный источник
 * правды: шлём намерение, обновлённый список прилетает событием `servers` всем
 * сразу. id генерируем на клиенте (crypto.randomUUID), чтобы тут же открыть
 * новый сервер и создать в нём первый канал, не дожидаясь ответа сокета.
 *
 * Владение считает сервер: устройство называет себя один раз в handshake
 * сокета (см. lib/socket), и сервер, созданный этим браузером, удалить может
 * только он — каналы внутри тоже. Заслон от случайного сноса, не личность
 * (см. audit B2); в самих сообщениях id устройства не ездит.
 */
export async function createServer(server: {
  id: string;
  name: string;
  emoji?: string;
  password?: string;
}): Promise<ServerCreateResult | null> {
  const name = server.name.trim().slice(0, 32);
  if (!server.id || !name) return { ok: false, error: 'bad-name' };
  const res = await ask<ServerCreateResult>('server-create', {
    id: server.id,
    name,
    emoji: server.emoji,
    password: server.password || undefined,
  });
  // null — сокет промолчал. Диалогу это надо отличать от отказа: там
  // «попробуйте ещё раз», здесь «так нельзя».
  return res;
}

/**
 * Почему сервер не завёлся — человеческими словами. Отдельно от отказа в
 * удалении: там «не ваш» и «внутри люди», здесь потолки и занятый адрес, и
 * общий текст на оба случая врал бы в обе стороны.
 */
export function createRefusalText(
  res: { error: string; scope?: QuotaScope; limit?: number } | null,
): string {
  if (!res) return tx('server.noAnswer');
  if (res.error === 'limit') {
    const count = res.limit ?? 0;
    // Личный потолок человек чинит сам — удалит свой ненужный сервер. Потолок
    // инсталляции не чинится ничем, кроме доступа к машине.
    return res.scope === 'install'
      ? tx('server.refusal.limitInstall', { count })
      : tx('server.refusal.limitPerson', { count });
  }
  if (res.error === 'exists') return tx('server.refusal.exists');
  if (res.error === 'bad-name') return tx('server.refusal.badName');
  return tx('server.refusal.forbidden');
}

/**
 * Удалить сервер. Возвращает true, если сервер согласился; при отказе сам
 * показывает тост с причиной. Удаление уносит каналы и переписку — спрашивает
 * отдельный диалог (DeleteServerDialog), сюда приходит уже подтверждённое.
 */
export async function deleteServer(id: string): Promise<boolean> {
  if (!id) return false;
  const res = await ask<ServerDeleteResult>('server-delete', { id });
  if (res?.ok) return true;
  toast(res ? serverRefusalText(res.error, res.occupants) : tx('server.noAnswer'));
  return false;
}

function serverRefusalText(error: string, occupants?: number): string {
  if (error === 'not-owner') return tx('server.refusal.notOwner');
  if (error === 'occupied') {
    return occupants
      ? tx('server.refusal.occupiedCount', { count: occupants })
      : tx('server.refusal.occupied');
  }
  if (error === 'forbidden') return tx('server.refusal.forbidden');
  return tx('server.refusal.gone');
}

/**
 * Живой срез сервера для диалога удаления: сколько каналов и сообщений
 * исчезнет вместе с ним и сколько человек сидит в его эфирах. null — сервер
 * не ответил или это не наше владение.
 */
export async function serverStats(
  id: string,
): Promise<{ channels: number; messages: number; occupants: number } | null> {
  if (!id) return null;
  const res = await ask<ServerStatsResult>('server-stats', { id });
  return res?.ok
    ? { channels: res.channels, messages: res.messages, occupants: res.occupants }
    : null;
}

/** Попытка разблокировать закрытый сервер паролем (ответ придёт server-unlock-result). */
export function unlockServer(id: string, password: string): void {
  if (!id) return;
  // Пароль дальше этого вызова не идёт: разблокировку переживает пропуск,
  // который придёт в ответе (см. lib/unlock-tokens). Раньше он оставался в
  // localStorage до конца жизни браузера — общий секрет всех, кто ходит в этот
  // сервер, в хранилище, доступном любому XSS (audit S5).
  getSocket().emit('server-unlock', { id, password });
}

// ===== Пароли закрытых серверов, оставшиеся от прежних версий =====
// Писать сюда больше нечего: разблокировку держит пропуск (lib/unlock-tokens).
// Читать — приходится: у того, кто обновился, пароли в хранилище уже лежат, и
// оставить их там значило бы оставить и дыру, ради которой всё это менялось.
// Поэтому на первом же подключении они разменивают себя на пропуска и
// стираются (см. SocketProvider), а этот блок исчезнет вместе с последней
// инсталляцией, которая их помнит.

const PW_PREFIX = 'relay-server-pw:';

export function forgetServerPassword(id: string): void {
  try {
    localStorage.removeItem(PW_PREFIX + id);
  } catch {
    /* no-op */
  }
}

/** Пароли, сохранённые прежними версиями, — их меняют на пропуска и стирают. */
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
