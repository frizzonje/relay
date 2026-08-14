import { create } from 'zustand';
import { amIOwner } from '@/lib/owner';

/**
 * Ключ владельца, пойманный из адресной строки, и то, чем всё кончилось.
 *
 * Ключ живёт в памяти вкладки, а не в хранилище: он одноразовый, и пережить
 * перезагрузку ему незачем — а вот остаться в localStorage навсегда очень даже
 * есть куда.
 *
 * Здесь же ответ на «владелец ли я» — вопрос, который иначе задавали бы два
 * разных экрана по отдельности, каждый своим запросом: карточка личности рисует
 * по нему значок, а лента — пункт «забанить на всей инсталляции».
 */
interface OwnerState {
  /** `null` — экран закрыт. Иначе ключ, который сейчас предъявляем. */
  claiming: string | null;
  /** Владелец инсталляции. `false` до первого ответа сервера — и это честно. */
  owner: boolean;
  claim: (token: string) => void;
  close: () => void;
  /** Спросить сервер заново. Зовётся на входе и после взятия власти. */
  refresh: () => Promise<void>;
}

export const useOwnerStore = create<OwnerState>((set) => ({
  claiming: null,
  owner: false,
  claim: (token) => set({ claiming: token }),
  close: () => set({ claiming: null }),
  refresh: async () => set({ owner: await amIOwner() }),
}));
