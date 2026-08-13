import { create } from 'zustand';

/**
 * Открыт ли экран «впустить устройство» и с каким кодом.
 *
 * Стор здесь ради одного: экран зовут из двух мест — из панели устройств и из
 * ссылки, снятой камерой телефона (`#pair=…`, ловит AppShell), — а окно должно
 * быть одно. Два смонтированных диалога дрались бы за фокус.
 */
interface PairingState {
  /** `null` — закрыт. Пустая строка — открыт без кода, человек введёт его сам. */
  admitting: string | null;
  admit: (code?: string) => void;
  close: () => void;
}

export const usePairingStore = create<PairingState>((set) => ({
  admitting: null,
  admit: (code = '') => set({ admitting: code }),
  close: () => set({ admitting: null }),
}));
