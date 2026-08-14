import { create } from 'zustand';

/**
 * Ключ владельца, пойманный из адресной строки, и то, чем всё кончилось.
 *
 * Ключ живёт в памяти вкладки, а не в хранилище: он одноразовый, и пережить
 * перезагрузку ему незачем — а вот остаться в localStorage навсегда очень даже
 * есть куда.
 */
interface OwnerState {
  /** `null` — экран закрыт. Иначе ключ, который сейчас предъявляем. */
  claiming: string | null;
  claim: (token: string) => void;
  close: () => void;
}

export const useOwnerStore = create<OwnerState>((set) => ({
  claiming: null,
  claim: (token) => set({ claiming: token }),
  close: () => set({ claiming: null }),
}));
