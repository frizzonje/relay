import { getSocket } from '@/lib/socket';

/**
 * Действия над реестром серверов. Как и каналы — сервер единственный источник
 * правды: шлём намерение, обновлённый список прилетает событием `servers` всем
 * сразу. id генерируем на клиенте (crypto.randomUUID), чтобы тут же открыть
 * новый сервер и создать в нём первый канал, не дожидаясь ответа сокета.
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
  });
}

export function deleteServer(id: string): void {
  if (!id) return;
  getSocket().emit('server-delete', { id });
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
