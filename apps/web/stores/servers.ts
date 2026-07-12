import { create } from 'zustand';
import type { Server } from '@relay/shared';
import { DEFAULT_SERVERS, MAIN_SERVER_ID } from '@/lib/constants';

/**
 * Реестр серверов (гильдий) — зеркало серверного списка, как stores/channels.
 * Сид (только главный) виден мгновенно; на connect и при любом изменении
 * SocketProvider заменит список целиком. `activeServerId` — чисто клиентский
 * выбор: какой сервер сейчас открыт в сайдбаре (сокет об этом не знает).
 *
 * Закрытые (под паролем) серверы приходят с флагом `locked`. `unlockedIds` —
 * те, к которым мы ввели верный пароль в этой сессии (сервер разблокировал наш
 * сокет и прислал их каналы). `unlockTargetId`/`unlockError` обслуживают модалку
 * ввода пароля.
 */
interface ServersState {
  servers: Server[];
  activeServerId: string;
  unlockedIds: string[];
  unlockTargetId: string | null;
  unlockError: string | null;
  setServers: (servers: Server[]) => void;
  setActiveServer: (id: string) => void;
  markUnlocked: (id: string) => void;
  openUnlock: (id: string) => void;
  closeUnlock: () => void;
  setUnlockError: (message: string | null) => void;
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
    })),
  setActiveServer: (id) => set({ activeServerId: id }),
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
export function isServerUnlocked(server: Pick<Server, 'id' | 'locked'>, unlockedIds: string[]): boolean {
  return !server.locked || unlockedIds.includes(server.id);
}
