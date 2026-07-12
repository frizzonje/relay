import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@relay/shared';

export type RelaySocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Единственный socket.io-клиент на всё приложение. В проде фронт и бэк живут
 * на одном origin за Caddy — кука `relay_pass` уезжает в handshake сама. Для
 * локального превью можно указать прямой адрес API через
 * `NEXT_PUBLIC_SOCKET_URL` (CORS на гейтвее открыт).
 */
let socket: RelaySocket | null = null;

export function getSocket(): RelaySocket {
  if (!socket) {
    const url = process.env.NEXT_PUBLIC_SOCKET_URL;
    socket = io(url || undefined, {
      autoConnect: false,
      transports: ['websocket', 'polling'],
    });
  }
  return socket;
}
