import { create } from 'zustand';
import { loadHosts, saveHosts, type RemoteHost } from '@/lib/hosts';

/**
 * Список «других хостов» рейки. Источник правды — localStorage (lib/hosts);
 * стор — реактивное зеркало, чтобы рейка перерисовывалась на добавление/
 * удаление. Гидрация — отдельным действием из useEffect (SSR-безопасно).
 */
interface HostsState {
  hosts: RemoteHost[];
  hydrated: boolean;
  hydrate: () => void;
  addHost: (host: RemoteHost) => void;
  removeHost: (url: string) => void;
}

export const useHostsStore = create<HostsState>((set, get) => ({
  hosts: [],
  hydrated: false,
  hydrate: () => {
    if (get().hydrated) return;
    set({ hosts: loadHosts(), hydrated: true });
  },
  addHost: (host) => {
    // Повторное добавление того же origin — обновляем подпись, не плодим дубли.
    const hosts = [...get().hosts.filter((h) => h.url !== host.url), host];
    saveHosts(hosts);
    set({ hosts });
  },
  removeHost: (url) => {
    const hosts = get().hosts.filter((h) => h.url !== url);
    saveHosts(hosts);
    set({ hosts });
  },
}));
