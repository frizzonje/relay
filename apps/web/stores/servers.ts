import { create } from 'zustand';
import type { MessageKey } from '@/lib/i18n/translate';
import type { Server } from '@relay/shared';
import { DEFAULT_SERVERS, MAIN_SERVER_ID } from '@/lib/constants';

/**
 * Реестр серверов (гильдий) — зеркало серверного списка, как stores/channels.
 * Сид (только главный) виден мгновенно; на connect и при любом изменении
 * SocketProvider заменит список целиком. `activeServerId` — чисто клиентский
 * выбор: какой сервер сейчас открыт в сайдбаре (сокет об этом не знает).
 *
 * Закрытые (под паролем) серверы приходят с флагом `locked`. `unlockedIds` —
 * те, что открыты нашему сокету прямо сейчас. Список ведёт сервер: он же
 * присылает `unlocked` у записи и знает про пропуска, уехавшие в handshake
 * (см. lib/unlock-tokens). Считать по памяти вкладки нельзя — перезагрузка её
 * стирает, а пропуск живёт, и на открытом сервере снова висел бы замок с
 * требованием пароля. `unlockTargetId`/`unlockError` обслуживают модалку ввода.
 */
interface ServersState {
  servers: Server[];
  activeServerId: string;
  unlockedIds: string[];
  unlockTargetId: string | null;
  unlockError: MessageKey | null;
  setServers: (servers: Server[]) => void;
  setActiveServer: (id: string) => void;
  markUnlocked: (id: string) => void;
  openUnlock: (id: string) => void;
  closeUnlock: () => void;
  setUnlockError: (message: MessageKey | null) => void;
}

export const useServersStore = create<ServersState>((set) => ({
  servers: DEFAULT_SERVERS,
  activeServerId: MAIN_SERVER_ID,
  unlockedIds: [],
  unlockTargetId: null,
  unlockError: null,
  setServers: (servers) =>
    set((s) => ({
      servers,
      // Активный сервер удалили (или его нет в новом списке) — откат на главный.
      activeServerId: servers.some((sv) => sv.id === s.activeServerId)
        ? s.activeServerId
        : MAIN_SERVER_ID,
      // Разблокировки берём из того же списка: их считает сервер под наш сокет.
      // Опоздать этот ответ не может — реестр он собирает уже после того, как
      // разобрал пропуска из handshake и принял введённый пароль, а порядок
      // сообщений в сокете сохраняется.
      unlockedIds: servers.filter((sv) => sv.unlocked).map((sv) => sv.id),
    })),
  setActiveServer: (id) => set({ activeServerId: id }),
  // Пароль только что приняли (`server-unlock-result`). Ждать следующей
  // рассылки реестра незачем: она едет на правку реестра, а не на наш пароль.
  markUnlocked: (id) =>
    set((s) => ({
      unlockedIds: s.unlockedIds.includes(id) ? s.unlockedIds : [...s.unlockedIds, id],
      unlockError: null,
    })),
  openUnlock: (id) => set({ unlockTargetId: id, unlockError: null }),
  closeUnlock: () => set({ unlockTargetId: null, unlockError: null }),
  setUnlockError: (message) => set({ unlockError: message }),
}));

/** Сервер доступен, если он не под паролем или мы уже ввели верный пароль. */
export function isServerUnlocked(
  server: Pick<Server, 'id' | 'locked'>,
  unlockedIds: string[],
): boolean {
  return !server.locked || unlockedIds.includes(server.id);
}
