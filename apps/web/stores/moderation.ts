import { create } from 'zustand';

/**
 * Тебя забанили на всей инсталляции.
 *
 * Отдельный флаг, а не тост: сокет после этого не подключается вовсе, и всё
 * приложение вокруг — рейка, каналы, композер — превращается в декорацию,
 * которая молча не работает. Человек имеет право знать, что произошло, а не
 * смотреть на вечное «переподключаюсь».
 *
 * Живёт в памяти вкладки. Пережить перезагрузку ему незачем: дверь спросят
 * заново, и ответит на это сервер, а не запись в localStorage.
 */
interface ModerationState {
  banned: boolean;
  setBanned: (banned: boolean) => void;
}

export const useModerationStore = create<ModerationState>((set) => ({
  banned: false,
  setBanned: (banned) => set({ banned }),
}));
