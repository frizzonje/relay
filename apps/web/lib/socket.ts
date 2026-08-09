import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@relay/shared';
import { loadClientId } from '@/lib/identity';

export type RelaySocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Единственный socket.io-клиент на всё приложение. В проде фронт и бэк живут
 * на одном origin за Caddy — кука `relay_pass` уезжает в handshake сама. Для
 * локального превью можно указать прямой адрес API через
 * `NEXT_PUBLIC_SOCKET_URL` (CORS на гейтвее открыт).
 */
let socket: RelaySocket | null = null;

/**
 * Гостевой токен из адреса `/invite/<token>` — гость предъявляет его в
 * handshake вместо куки (отдельное поле `guest`, чтобы не пересекаться с
 * `auth.token` обычного пропуска). Вне инвайт-страницы — null.
 */
export function guestTokenFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  const m = /^\/invite\/([^/]+)/.exec(window.location.pathname);
  return m ? decodeURIComponent(m[1]) : null;
}

export function getSocket(): RelaySocket {
  if (!socket) {
    const url = process.env.NEXT_PUBLIC_SOCKET_URL;
    socket = io(url || undefined, {
      autoConnect: false,
      transports: ['websocket', 'polling'],
      // auth-функция вычисляется на каждый connect (в т.ч. reconnect): на
      // инвайт-странице гость шлёт токен, в остальном приложении — пусто
      // (авторизация по куке relay_pass, как раньше).
      //
      // clientId — стабильный id этого браузера. Он не пропуск и никого не
      // удостоверяет; по нему сервер решает, чьи серверы и каналы показывать
      // управляемыми (audit B2), и выгоняет «призрака» прошлой вкладки из
      // эфира. Место ему именно здесь: одно объявление на соединение вместо
      // поля в каждом сообщении.
      auth: (cb) => {
        const guest = guestTokenFromLocation();
        cb({ clientId: loadClientId(), ...(guest ? { guest } : {}) });
      },
    });
  }
  return socket;
}
