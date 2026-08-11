'use client';

import { useEffect, type ReactNode } from 'react';
import { toast } from 'sonner';
import { getSocket } from '@/lib/socket';
import { initVoice } from '@/lib/voice';
import { initHotkeys } from '@/lib/hotkeys';
import { initDesktopBridge } from '@/lib/desktop';
import { useUiStore, myName } from '@/stores/ui';
import { useChatStore } from '@/stores/chat';
import { useUnreadStore, LAST_READ_KEY } from '@/stores/unread';
import { useChannelsStore } from '@/stores/channels';
import { useServersStore } from '@/stores/servers';
import { forgetServerPassword, storedServerPasswords, unlockServer } from '@/lib/servers';
import { notifyMessage } from '@/lib/notify';
import { tx } from '@/lib/i18n';

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
    const unread = useUnreadStore.getState;

    // «Печатает…»: держим по тегу таймер угасания. Каждый пинг chat-typing его
    // продлевает; истёк — убираем имя из списка. Отдельная функция сброса нужна
    // при смене канала/реконнекте, чтобы чужой индикатор не «прилип».
    const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const TYPING_TTL_MS = 4500;
    function pushTyping() {
      chat().setTyping([...typingTimers.keys()]);
    }
    function noteTyping(name: string) {
      const prev = typingTimers.get(name);
      if (prev) clearTimeout(prev);
      typingTimers.set(
        name,
        setTimeout(() => {
          typingTimers.delete(name);
          pushTyping();
        }, TYPING_TTL_MS),
      );
      pushTyping();
    }
    function stopTyping(name: string) {
      const t = typingTimers.get(name);
      if (!t) return;
      clearTimeout(t);
      typingTimers.delete(name);
      pushTyping();
    }
    function clearTyping() {
      typingTimers.forEach((t) => clearTimeout(t));
      typingTimers.clear();
      chat().setTyping([]);
    }
    /** Слаг открытого сейчас текстового канала (для отметок «прочитано»). */
    const openSlug = () => ui().textRoom;

    // Смотрим ли мы прямо сейчас в открытый канал. Только тогда входящие
    // считаются прочитанными: свёрнутое окно, соседняя вкладка, сетка голоса
    // поверх чата и отскролленная вверх лента — всё это «не смотрим», и
    // сообщения копятся в непрочитанные, как в Discord.
    function watching(): boolean {
      if (!openSlug() || ui().view !== 'text') return false;
      if (typeof document !== 'undefined') {
        if (document.visibilityState !== 'visible' || !document.hasFocus()) return false;
      }
      return unread().atBottom;
    }

    // Переход «смотрю ↔ отвернулся». Отвернулись — фиксируем линию «новые» на
    // текущей отметке; вернулись — гасим точку. Держим прошлое состояние, чтобы
    // не дёргать стор на каждом чихе UI.
    let watched = false;
    function syncWatch() {
      const slug = openSlug();
      const now = watching();
      if (now === watched) return;
      watched = now;
      if (!slug) return;
      if (now) unread().readNow(slug);
      else unread().pauseAt(slug);
    }

    // Навешиваем mesh-WebRTC обработчики (peers/offer/answer/ice/voice-presence,
    // reconnect, замер пинга) — один раз на приложение, до connect().
    initVoice();
    // Глобальные горячие клавиши канала (по умолчанию пусто — всё выключено).
    initHotkeys();
    // Десктоп-оболочка (Tauri): глобальный PTT-хоткей ↔ микрофон, статус в трее.
    // Вне Tauri — no-op. Асинхронный (ждёт навешивания слушателей), не блокируем.
    void initDesktopBridge();

    socket.on('chat', (msg) => {
      const slug = openSlug();
      if (!slug) return;
      chat().addMessage(msg);
      // Автор прислал сообщение — печатать он закончил.
      if (msg.name) stopTyping(msg.name);
      // Звук открытого канала берём отсюда, а не из `chat-activity`: только тут
      // видно автора. Своя же реплика звенеть не должна — её только что
      // отправили с этой клавиатуры; служебные строки «вошёл/вышел» — тоже.
      if (!msg.system && msg.name !== myName()) notifyMessage(slug);
      // «Прочитано» не трогаем: следом прилетит `chat-activity` про это же
      // сообщение — там одна общая ветка для открытого канала и всех прочих.
    });
    socket.on('chat-history', (list) => {
      if (!openSlug() || !Array.isArray(list)) return;
      chat().setHistory(list);
    });
    socket.on('chat-roster', (names) => {
      if (!openSlug() || !Array.isArray(names)) return;
      chat().setRoster(names);
    });
    socket.on('chat-reaction', ({ id, reactions }) => {
      if (!openSlug() || !id) return;
      chat().applyReaction(id, reactions ?? {});
    });
    socket.on('chat-edited', ({ id, text, editedTs }) => {
      if (!openSlug() || !id) return;
      chat().applyEdit(id, text, editedTs);
    });
    socket.on('chat-deleted', ({ id }) => {
      if (!openSlug() || !id) return;
      chat().applyDelete(id);
    });
    socket.on('chat-typing', ({ name }) => {
      if (!openSlug() || !name || name === myName()) return;
      noteTyping(name);
    });
    // Лёгкий пинг активности любого канала. Активность отмечаем всегда, а гасим
    // её только если в этот канал сейчас реально смотрят.
    socket.on('chat-activity', ({ slug, ts }) => {
      if (!slug || typeof ts !== 'number') return;
      unread().noteActivity(slug, ts);
      if (slug === openSlug()) {
        if (watching()) unread().readNow(slug);
        return; // звук открытого канала уже сыграл обработчик `chat`
      }
      // Закрытый сейчас канал: писать в него мы не могли, значит сообщение
      // чужое — автора для этого спрашивать не у кого и не нужно.
      notifyMessage(slug);
    });

    // Канал закрылся под нами: его удалили (или он не пережил наш реконнект).
    // Сервер уже выписал нас из комнаты — закрываем ленту и говорим почему,
    // иначе на экране остался бы канал-призрак, в котором можно писать в пустоту.
    socket.on('chat-closed', ({ slug }) => {
      if (!slug || slug !== ui().textRoom) return;
      const label = ui().textLabel || slug;
      ui().leaveText();
      toast(tx('channels.deleted', { name: label }));
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
      if (!Array.isArray(list)) return;
      // Прежний список нужен ниже: по нему узнаём, к какому серверу принадлежал
      // открытый канал, если он из нового списка пропал.
      const before = useChannelsStore.getState().channels;
      useChannelsStore.getState().setChannels(list);

      // Снимок активности текстовых каналов: сервер кладёт в реестр время
      // последнего сообщения. Благодаря ему точки горят сразу после загрузки
      // страницы — сравниваем с отметкой чтения, пережившей перезагрузку.
      unread().seedActivity(
        list
          .filter((c) => c?.type === 'text' && typeof c.lastTs === 'number')
          .map((c) => ({ slug: c.slug, ts: c.lastTs as number })),
      );
      const open = openSlug();
      if (open && watching()) unread().readNow(open);

      // Открытый текстовый канал пропал из реестра — закрываем ленту, иначе
      // человек продолжит писать в канал-призрак, которого больше нет ни у кого.
      // Страховка к событию `chat-closed`: оно точнее, но до старых вкладок и
      // клиентов не долетит.
      //
      // Пропажа законна ровно в одном случае: канал жил на закрытом сервере,
      // который мы ещё не разблокировали (первые мгновения после реконнекта,
      // пока не прошла авто-разблокировка) — такой список просто неполон.
      // Проверяем именно сервер этого канала, а не «есть ли вообще запертые
      // серверы»: чужой замок, который мы никогда не откроем, иначе отключал бы
      // выход насовсем — и канал-призрак жил бы на экране до перезагрузки.
      const room = ui().textRoom;
      if (!room || list.some((c) => c?.type === 'text' && c.slug === room)) return;
      const { servers, unlockedIds } = useServersStore.getState();
      const home = before.find((c) => c.type === 'text' && c.slug === room)?.serverId;
      const locked = servers.some(
        (s) => s.locked && !unlockedIds.includes(s.id) && (!home || s.id === home),
      );
      if (!locked) ui().leaveText();
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
        if (s.unlockTargetId === id) s.setUnlockError('unlockServer.error.wrongPassword');
      }
    });

    socket.on('connect', () => {
      // Авто-разблокировка закрытых серверов сохранёнными паролями (после reconnect
      // сокет-сессия новая — разблокировки надо повторить).
      for (const { id, password } of storedServerPasswords()) unlockServer(id, password);
      const room = ui().textRoom;
      if (room) {
        // У сокета новый id, история придёт заново — чистим ленту перед подпиской.
        clearTyping();
        chat().reset();
        socket.emit('chat-join', { room, name: myName() });
      }
    });

    // Смена открытого текстового канала: подписка/отписка на сервере. Плюс
    // пересчёт «смотрю ли я в канал» — он зависит ещё и от `view` (сетка голоса
    // закрывает собой чат), поэтому слушаем стор целиком.
    const unsub = useUiStore.subscribe((state, prev) => {
      if (state.textRoom !== prev.textRoom) {
        clearTyping();
        if (state.textRoom) {
          chat().reset();
          // Вход в канал: линия «новые» встаёт на прежней отметке чтения, точка гаснет.
          unread().openChannel(state.textRoom);
          unread().setAtBottom(true);
          // Честное состояние, а не оптимистичное `true`: иначе syncWatch ниже
          // увидит переход «смотрел → отвернулся» и pauseAt тут же затрёт
          // линию «новые», которую только что поставил openChannel.
          watched = watching();
          socket.emit('chat-join', { room: state.textRoom, name: myName() });
        } else {
          socket.emit('chat-leave');
          chat().reset();
          watched = false;
        }
      }
      syncWatch();
    });

    // Прокрутка ленты меняет «смотрю ли я»: отскроллен вверх — не читаем.
    const unsubUnread = useUnreadStore.subscribe((state, prev) => {
      if (state.atBottom !== prev.atBottom) syncWatch();
    });

    // Свернули окно / ушли на другую вкладку — новые копятся; вернулись — читаем.
    const onFocusChange = () => syncWatch();
    // Соседняя вкладка что-то дочитала — подхватываем её отметки.
    const onStorage = (e: StorageEvent) => {
      if (e.key === LAST_READ_KEY) unread().adoptLastRead(e.newValue);
    };
    if (typeof window !== 'undefined') {
      document.addEventListener('visibilitychange', onFocusChange);
      window.addEventListener('focus', onFocusChange);
      window.addEventListener('blur', onFocusChange);
      window.addEventListener('storage', onStorage);
    }

    if (!socket.connected) socket.connect();

    return () => {
      unsub();
      unsubUnread();
      if (typeof window !== 'undefined') {
        document.removeEventListener('visibilitychange', onFocusChange);
        window.removeEventListener('focus', onFocusChange);
        window.removeEventListener('blur', onFocusChange);
        window.removeEventListener('storage', onStorage);
      }
      clearTyping();
      socket.off('chat');
      socket.off('chat-history');
      socket.off('chat-roster');
      socket.off('chat-reaction');
      socket.off('chat-edited');
      socket.off('chat-deleted');
      socket.off('chat-typing');
      socket.off('chat-activity');
      socket.off('chat-closed');
      socket.off('servers');
      socket.off('server-unlock-result');
      socket.off('channels');
      socket.off('connect');
    };
  }, []);

  return <>{children}</>;
}
