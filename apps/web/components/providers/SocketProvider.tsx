'use client';

import { useEffect, type ReactNode } from 'react';
import { getSocket } from '@/lib/socket';
import { initVoice } from '@/lib/voice';
import { initDesktopBridge } from '@/lib/desktop';
import { useUiStore, myName } from '@/stores/ui';
import { useChatStore } from '@/stores/chat';
import { useChannelsStore } from '@/stores/channels';
import { useServersStore } from '@/stores/servers';
import { forgetServerPassword, storedServerPasswords, unlockServer } from '@/lib/servers';

/**
 * Поднимает единственный socket.io-клиент и навешивает глобальную логику чата
 * в одном месте:
 *
 *  • chat/chat-history/chat-roster → пишем в chat-стор (если есть открытый канал);
 *  • смена textRoom → chat-join нового / chat-leave прежнего (голос не трогаем);
 *  • connect → переподписываемся на текущий канал (после обрыва история
 *    подтянется заново, поэтому сначала сбрасываем ленту).
 */
export function SocketProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const socket = getSocket();
    const chat = useChatStore.getState;
    const ui = useUiStore.getState;

    // Навешиваем mesh-WebRTC обработчики (peers/offer/answer/ice/voice-presence,
    // reconnect, замер пинга) — один раз на приложение, до connect().
    initVoice();
    // Десктоп-оболочка (Tauri): глобальный PTT-хоткей ↔ микрофон, статус в трее.
    // Вне Tauri — no-op.
    initDesktopBridge();

    socket.on('chat', (msg) => {
      if (!ui().textRoom) return;
      chat().addMessage(msg);
    });
    socket.on('chat-history', (list) => {
      if (!ui().textRoom || !Array.isArray(list)) return;
      chat().setHistory(list);
    });
    socket.on('chat-roster', (names) => {
      if (!ui().textRoom || !Array.isArray(names)) return;
      chat().setRoster(names);
    });
    socket.on('chat-reaction', ({ id, reactions }) => {
      if (!ui().textRoom || !id) return;
      chat().applyReaction(id, reactions ?? {});
    });

    // Реестр серверов — сервер шлёт полный список на connect и при изменениях.
    socket.on('servers', (list) => {
      if (!Array.isArray(list)) return;
      useServersStore.getState().setServers(list);
      // Пароли серверов, которых больше нет (удалили), выметаем из localStorage.
      const ids = new Set(list.map((s) => s?.id));
      for (const { id } of storedServerPasswords()) {
        if (!ids.has(id)) forgetServerPassword(id);
      }
    });

    // Реестр каналов — сервер шлёт полный список на connect и при изменениях.
    // Для закрытых серверов приходит уже отфильтрованный (свой) список.
    socket.on('channels', (list) => {
      if (Array.isArray(list)) useChannelsStore.getState().setChannels(list);
    });

    // Ответ на ввод пароля закрытого сервера. Успех — помечаем разблокированным;
    // если модалка ждала именно его — закрываем и открываем сервер. Неверный —
    // пишем ошибку в модалку (или молча, если это была авто-разблокировка) и
    // забываем сохранённый пароль.
    socket.on('server-unlock-result', ({ id, ok }) => {
      const s = useServersStore.getState();
      if (ok) {
        s.markUnlocked(id);
        if (s.unlockTargetId === id) {
          s.closeUnlock();
          s.setActiveServer(id);
        }
      } else {
        forgetServerPassword(id);
        if (s.unlockTargetId === id) s.setUnlockError('Неверный пароль — попробуй ещё раз.');
      }
    });

    socket.on('connect', () => {
      // Авто-разблокировка закрытых серверов сохранёнными паролями (после reconnect
      // сокет-сессия новая — разблокировки надо повторить).
      for (const { id, password } of storedServerPasswords()) unlockServer(id, password);
      const room = ui().textRoom;
      if (room) {
        // У сокета новый id, история придёт заново — чистим ленту перед подпиской.
        chat().reset();
        socket.emit('chat-join', { room, name: myName() });
      }
    });

    // Смена открытого текстового канала: подписка/отписка на сервере.
    const unsub = useUiStore.subscribe((state, prev) => {
      if (state.textRoom === prev.textRoom) return;
      if (state.textRoom) {
        chat().reset();
        socket.emit('chat-join', { room: state.textRoom, name: myName() });
      } else {
        socket.emit('chat-leave');
        chat().reset();
      }
    });

    if (!socket.connected) socket.connect();

    return () => {
      unsub();
      socket.off('chat');
      socket.off('chat-history');
      socket.off('chat-roster');
      socket.off('chat-reaction');
      socket.off('servers');
      socket.off('server-unlock-result');
      socket.off('channels');
      socket.off('connect');
    };
  }, []);

  return <>{children}</>;
}
