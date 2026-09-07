'use client';

import { useEffect, type ReactNode } from 'react';
import { toast } from 'sonner';
import type {
  CallEndedRelay,
  CallIncomingRelay,
  CallStateRelay,
  VoiceRefusedRelay,
} from '@relay/shared';
import { getSocket } from '@/lib/socket';
import { initVoice, relabelSelf } from '@/lib/voice';
import { initCall } from '@/lib/call';
import { initHotkeys } from '@/lib/hotkeys';
import { initDesktopBridge } from '@/lib/desktop';
import { isNarrowNow } from '@/lib/use-mobile';
import { useUiStore, myName } from '@/stores/ui';
import { useChatStore } from '@/stores/chat';
import { useUnreadStore, LAST_READ_KEY } from '@/stores/unread';
import { useDmStore } from '@/stores/dm';
import { usePresenceStore } from '@/stores/presence';
import { useRingStore } from '@/stores/ring';
import { useChannelsStore } from '@/stores/channels';
import { useIdentityStore } from '@/stores/identity';
import { useContractStore } from '@/stores/contract';
import { useModerationStore } from '@/stores/moderation';
import { useConfigStore } from '@/stores/config';
import { useAdminStore } from '@/stores/admin';
import { usePinsStore } from '@/stores/pins';
import { useServersStore } from '@/stores/servers';
import { forgetServerPassword, storedServerPasswords, unlockServer } from '@/lib/servers';
import {
  dropUnlockToken,
  hasUnlockToken,
  saveUnlockToken,
  unlockTokenIds,
} from '@/lib/unlock-tokens';
import { notifyDirect, notifyMention, notifyMessage } from '@/lib/notify';
import { showDmToast } from '@/components/dm/DmToast';
import { useNotifyStore } from '@/stores/notify';
import { adoptPrefs, onPref } from '@/lib/prefs';
import { tx } from '@/lib/i18n';
import { chatRefusalKey, voiceRefusalKey } from '@/lib/refusals';

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
    const ring = useRingStore.getState;
    const pins = usePinsStore.getState;
    const dm = useDmStore.getState;

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
    /**
     * Слаг открытой сейчас ленты — канала или беседы (для отметок «прочитано»).
     * `textRoom`/`dmRoom` — взаимоисключающие поля одной сцены (см. `Scene` в
     * stores/ui.ts: `openText`/`openDm` и все прочие переходы обнуляют
     * противоположное поле), так что порядок здесь на практике не решает
     * ничего — оба разом не бывают заполнены. `textRoom` — первым просто по
     * преемственности: до задачи 11 это был единственный вариант, и весь
     * остальной код ниже уже настроен на его приоритет.
     */
    const openSlug = () => ui().textRoom ?? ui().dmRoom;

    /**
     * Список переписок с сервера. Спрашиваем на каждом connect — так же, как
     * текстовый канал переподписывается после обрыва: у сокета новый id, и без
     * переспроса список остался бы тем, что помнит эта вкладка, а не тем, что
     * на сервере. Сам запрос живёт в сторе: повторить его умеет и экран, когда
     * ответа не пришло (см. `reload` в stores/dm.ts).
     */

    // Смотрим ли мы прямо сейчас в открытый канал. Только тогда входящие
    // считаются прочитанными: свёрнутое окно, соседняя вкладка, сетка голоса
    // поверх чата и отскролленная вверх лента — всё это «не смотрим», и
    // сообщения копятся в непрочитанные, как в Discord.
    function watching(): boolean {
      if (!openSlug() || (ui().view !== 'text' && ui().view !== 'dm')) return false;
      // На узком экране вид не отвечает на вопрос «что перед глазами»: панели
      // показываются по одной, и шаг назад к списку меняет только `mobilePanel`
      // — `view` остаётся прежним. Без этой строки реплика, пришедшая человеку,
      // который смотрит на список, считалась бы прочитанной: ни звука, ни
      // облачка, ни точки — то есть незаметно вовсе.
      if (isNarrowNow() && ui().mobilePanel !== 'stage') return false;
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
    // Голосовая жизнь вызова: принятый вызов сажает эту вкладку в комнату
    // беседы, уход собеседника её оттуда выводит. Вешается тем же порядком и по
    // той же причине — до connect(), один раз на приложение.
    initCall();
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
    socket.on('chat-history', (page) => {
      // Страница подписана каналом: ответ мог обогнать переключение, и чужая
      // лента, подставленная в открытый канал, выглядела бы как чужая переписка.
      if (!page || !Array.isArray(page.messages) || page.slug !== openSlug()) return;
      chat().setHistory(page.messages, page.more === true);
      // Сколько здесь закреплено — числом для шапки. Сам список спрашивают,
      // только когда его открывают (см. stores/pins).
      pins().setCount(typeof page.pins === 'number' ? page.pins : 0);
    });
    socket.on('chat-roster', (people) => {
      if (!openSlug() || !Array.isArray(people)) return;
      chat().setRoster(people);
    });
    // Глобальное присутствие личности (не путать с ростером выше — тот про
    // «кто в этом канале», это про «где вообще этот человек», см.
    // stores/presence.ts). Снимок приходит один раз на подключение, дельта —
    // сколько угодно раз за сессию; открытого канала для них не требуется.
    socket.on('presence', (people) => {
      if (!Array.isArray(people)) return;
      usePresenceStore.getState().applySnapshot(people);
    });
    socket.on('presence-update', (changed) => {
      if (!Array.isArray(changed)) return;
      usePresenceStore.getState().applyDelta(changed);
    });
    // Обрыв сокета — самая частая причина, по которой присутствие может
    // соврать: сервер разошлёт честный `offline` про НАС остальным, а вот
    // КОМУ ЭТОТ КЛИЕНТ доверял секунду назад — остаётся висеть в сторе как
    // было, и зелёная точка «в сети» продолжает утверждать то, что уже могло
    // перестать быть правдой. План резервирует зелёный ровно под «дозвон
    // возможен» — врущая зелёная точка посреди обрыва прямо этому противоречит.
    // Сервер шлёт полный снимок заново на каждом подключении (см. `presence`
    // выше), так что сброс здесь не теряет данные навсегда — только держит
    // немой промежуток честным, а не оптимистичным.
    // Тем же обрывом кончается и дозвон, и это не догадка клиента: вызов
    // звонящего сервер закрывает в тот же миг, как ушло его последнее
    // устройство, без грейса (§4.2), а `call-ended{cancelled}` про это уезжает
    // в уже мёртвый сокет. На переподключении вызовы заново не рассылаются, а
    // таймаут дозвона клиент намеренно не считает у себя — значит некому,
    // кроме этой строки, снять экран, пульсирующий «дозваниваемся» на вызове,
    // которого больше нет (см. `lost` в stores/ring.ts).
    const onDisconnect = () => {
      usePresenceStore.getState().reset();
      ring().lost();
    };
    socket.on('disconnect', onDisconnect);
    socket.on('chat-reaction', ({ id, reactions }) => {
      if (!openSlug() || !id) return;
      chat().applyReaction(id, reactions ?? {});
    });
    socket.on('chat-edited', ({ id, text, editedTs, mentions }) => {
      if (!openSlug() || !id) return;
      chat().applyEdit(id, text, editedTs, mentions);
    });
    socket.on('chat-deleted', ({ id }) => {
      if (!openSlug() || !id) return;
      chat().applyDelete(id);
    });
    socket.on('chat-pinned', ({ id, pinned, count }) => {
      if (!openSlug() || !id) return;
      pins().applyPinned(id, pinned === true, typeof count === 'number' ? count : 0);
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

    // Тебя назвали. Событие приходит раньше пинга активности (тот копится 80 мс
    // на сервере), поэтому время канала отмечаем прямо здесь — иначе «дочитал»
    // в открытом канале означало бы «дочитал до предыдущей реплики», и вызов
    // остался бы висеть непрочитанным в канале, в который человек смотрит.
    socket.on('mention', ({ slug, ts }) => {
      if (!slug || typeof ts !== 'number') return;
      unread().noteActivity(slug, ts);
      if (slug === openSlug() && watching()) {
        unread().readNow(slug);
        return;
      }
      unread().noteMention(slug);
      notifyMention(slug);
    });

    // Снимок счётчиков: сколько раз тебя звали в каждом канале и не прочитано.
    // Считает его сервер — по базе и отметкам чтения, то есть с оглядкой на все
    // твои устройства сразу.
    socket.on('mentions', ({ counts }) => {
      if (counts && typeof counts === 'object') unread().seedMentions(counts);
    });

    // Экран исходящего вызова (задача 6 плана B, `stores/ring.ts`): `initCall`
    // выше вешает свою пару обработчиков этих же событий для КОМНАТЫ разговора
    // — здесь то же самое для ВЫЗОВА, до ответа. Оба слушателя независимы, у
    // каждого свой вопрос («сесть ли в комнату» и «что написать на экране
    // дозвона») и оба фильтруют события по своему `ringId`/`room`, так что
    // держать их в одном месте незачем и негде: `lib/call.ts` не знает про
    // экран, а этот стор не трогает ни микрофон, ни сокет напрямую.
    //
    // Обработчики названы по имени не для красоты: снимаются они таким же
    // именным `off` (см. уборку эффекта). `socket.off(event)` без второго
    // аргумента снимает ВСЕ обработчики события — вместе с теми, что повесил
    // `initCall`, а он защищён «один раз на приложение» и обратно их не
    // навесит. В строгом режиме React (`next.config.mjs`) каждое монтирование
    // — это монтирование, уборка и монтирование заново, так что после первого
    // же кадра в dev принятый вызов не сажал бы в комнату никого.
    const onCallState = (payload: CallStateRelay) => ring().applyState(payload);
    const onCallEnded = (payload: CallEndedRelay) => ring().applyEnded(payload);
    socket.on('call-state', onCallState);
    socket.on('call-ended', onCallEnded);
    // Тост входящего (задача 7 плана B): открывает `incoming` в том же сторе,
    // а системное окошко (`notifyCall`) зовёт ТОЛЬКО `IncomingToast.tsx` —
    // это единственный владелец, потому что только он знает момент, когда
    // вызов закончился, и может закрыть своё же окошко (`cancelled` в
    // `lib/notify.ts` иначе никогда не взводится: вызванный здесь и
    // отброшенный хэндл не даёт закрыть то, что он мог успеть показать).
    // Второй `notifyCall` на тот же вызов был обнаружен ревью как
    // непреднамеренное дублирование, а не подстраховка. Второй входящий во
    // время разговора сюда не доедет вовсе: сервер отвечает на такой
    // `call-start` отказом `busy` раньше, чем что-либо зазвонит (§4.2,
    // доказано в `ring.handlers.test.ts` → «второй входящий во время
    // разговора»), так что городить здесь счётчик «уже показываем один тост»
    // незачем — второго не бывает.
    const onCallIncoming = (payload: CallIncomingRelay) => ring().applyIncoming(payload);
    socket.on('call-incoming', onCallIncoming);

    // В беседе написали. Летит обоим участникам (см. DmActivityRelay), поэтому
    // своя же реплика — не повод звенеть самому себе.
    socket.on('dm-activity', (relay) => {
      dm().applyActivity(relay);
      // dm-стор держит свою активность отдельно от unread-стора (см. её
      // комментарий в stores/dm.ts — она про строку в списке переписок).
      // `openChannel`/`readNow` ниже сверяются со СВОИМ `activity[slug]`, и без
      // этой строки видели бы беседу так, будто в ней никогда не писали, —
      // «дочитал» не сдвигался бы, а линия «новые» вставала бы у самого начала
      // при каждом входе.
      unread().noteActivity(relay.slug, relay.ts);
      // Смотрим прямо в эту беседу — читаем её тут же и звеним самому себе не
      // о чем, ровно как канал, в который сейчас смотрят (см. `mention` ниже).
      if (relay.slug === openSlug() && watching()) {
        unread().readNow(relay.slug);
        return;
      }
      // Звук и вспышка — тем же путём, что и упоминание в канале: личная
      // реплика ничем не тише той, где тебя назвали (см. notify.ts). Следом —
      // облачко в углу: точка в списке говорит только «где-то непрочитано», а
      // кто написал и о чём, до сих пор приходилось выяснять руками.
      if (!relay.previewMine) {
        notifyDirect(relay.slug);
        showDmToast(relay);
      }
    });

    // Канал закрылся под нами: его удалили (или он не пережил наш реконнект).
    // Сервер уже выписал нас из комнаты — закрываем ленту и говорим почему,
    // иначе на экране остался бы канал-призрак, в котором можно писать в пустоту.
    socket.on('chat-closed', ({ slug, reason }) => {
      if (!slug || slug !== ui().textRoom) return;
      const label = ui().textLabel || slug;
      ui().leaveText();
      // Бан и удаление канала выглядят на экране одинаково — лента закрылась, —
      // но означают разное, и человеку важнее второе: канал цел, ушёл он.
      toast(
        reason === 'banned'
          ? tx('moderation.banned.channel')
          : tx('channels.deleted', { name: label }),
      );
    });

    // Настройки инсталляции — снимком, на подключении и при каждой правке
    // владельца. Реактивно: настройка, доезжающая только после перезагрузки
    // вкладки, — половина настройки.
    socket.on('settings', (snapshot) => useConfigStore.getState().apply(snapshot));

    // Правка из ДРУГОЙ сессии владельца — в открытую здесь панель. Событие не
    // дублирует `settings`: тот везёт только помеченное в каталоге `client`, а
    // панели нужно всё, что она показывает. Своей правки вторым эхом не
    // приходит — сервер её себе не шлёт (§9.6 протокола).
    socket.on('admin-changed', (relay) => useAdminStore.getState().applyRemote(relay));

    // Сказанное не приняли — и человек обязан узнать причину, а не тишину.
    //
    // События ленты ответа не ждут, поэтому до этапа C всякий отказ выглядел
    // одинаково: «нажал, и ничего не произошло». Причины разные намеренно —
    // «правку выключили» и «правка протухла» человек чинит по-разному.
    socket.on('chat-refused', ({ reason }) => {
      if (!reason) return;
      toast(tx(chatRefusalKey(reason)));
    });

    // То же в голосе: ни `join`, ни `media-update` ответа не ждут, а `join`
    // вдобавок неотличим для клиента от удавшегося — без этой строки выключенная
    // владельцем камера выглядела бы сломанной кнопкой, а полный канал тишиной.
    //
    // Кроме одной причины. `not-in-call` — отказ во входе в комнату БЕСЕДЫ, и
    // хозяин у него один: `lib/call.ts` (см. `voice-refused` там). Стучится в
    // такую комнату только он — в реестре каналов её нет, и щелчком по каналу
    // такого `join` не получить, — а значит отказ приходит либо законной
    // стороне разговора, у которой сторож (`CALL_ROOM_SEAT_MS`) закрыл комнату,
    // пока висел первый в жизни системный запрос доступа к микрофону, либо на
    // опоздавший `join` того, кто из разговора уже вышел.
    //
    // Молчания из этого не выходит: `lib/call.ts` и снимает экран звонка с
    // отпущенным микрофоном, и говорит словами — «разговор не собрался,
    // садились слишком долго». Сказать это может только он: строка честна
    // ровно для той вкладки, что в комнате беседы сидела, а здесь мы знаем
    // один лишь код причины и обвинили бы законную сторону разговора в том,
    // что разговор не её.
    //
    // Сверять комнату здесь (`callRoom()`) нельзя, и это не осторожность:
    // порядок обработчиков одного события между двумя модулями не гарантия, а
    // `lib/call.ts` подписывается раньше (`initCall` выше по этому же эффекту)
    // и к нашему приходу комнату уже обнулит — проверка молча оказалась бы
    // всегда-истинной.
    const onVoiceRefused = ({ reason }: VoiceRefusedRelay) => {
      if (!reason || reason === 'not-in-call') return;
      toast(tx(voiceRefusalKey(reason)));
    };
    socket.on('voice-refused', onVoiceRefused);

    // Реестр серверов — сервер шлёт полный список на connect и при изменениях.
    socket.on('servers', (list) => {
      if (!Array.isArray(list)) return;
      useServersStore.getState().setServers(list);
      // Пропуска и пароли серверов, которых больше нет (удалили), выметаем из
      // localStorage: предъявлять их некому, а ездить в handshake они будут.
      const ids = new Set(list.map((s) => s?.id));
      for (const { id } of storedServerPasswords()) {
        if (!ids.has(id)) forgetServerPassword(id);
      }
      // Пропуск выметаем и тогда, когда сервер на месте, а разблокировки по
      // пропуску нет: он мёртв — протух, пароль сменили или его вовсе сняли.
      // Живой пропуск в этом списке всегда виден флагом `unlocked`: реестр
      // собирается после разбора handshake.
      for (const id of unlockTokenIds()) {
        const srv = list.find((s) => s?.id === id);
        if (!srv || !srv.unlocked) dropUnlockToken(id);
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
    // забываем сохранённое.
    socket.on('server-unlock-result', ({ id, ok, token }) => {
      const s = useServersStore.getState();
      if (ok) {
        // Пропуск пришёл — дальше разблокировка едет в handshake и успевает
        // до первой рассылки реестра. Пароль в хранилище с этого момента лишний.
        if (token) {
          saveUnlockToken(id, token);
          forgetServerPassword(id);
        }
        s.markUnlocked(id);
        if (s.unlockTargetId === id) {
          s.closeUnlock();
          s.setActiveServer(id);
        }
      } else {
        forgetServerPassword(id);
        dropUnlockToken(id);
        if (s.unlockTargetId === id) s.setUnlockError('unlockServer.error.wrongPassword');
      }
    });

    // Личное состояние человека: отметки чтения и настройки. Приходит снимком
    // на входе (`full`) и правкой, когда он что-то сделал на другом своём
    // устройстве. Без личности не приходит вовсе — тогда всё как раньше,
    // в localStorage этого браузера.
    socket.on('reads', ({ marks, full }) => {
      if (!marks || typeof marks !== 'object') return;
      // Своё, о чём сервер ещё не знает: этот браузер читал каналы до того, как
      // у человека появился ключ. Догоняем — но только по снимку.
      for (const { slug, ts } of unread().adoptMarks(marks, { full })) {
        socket.emit('read-mark', { slug, ts });
      }
      // Канал, дочитанный на другом устройстве, гаснет и здесь — но линия
      // «новые» в открытой ленте остаётся там, где стояла: она про этот экран.
    });

    socket.on('prefs', ({ values, full }) => {
      if (values && typeof values === 'object') adoptPrefs(values, { full });
    });

    // Имя сменили на другом устройстве этого же человека. Имя принадлежит
    // личности, а не вкладке: не приняв его здесь, эта вкладка до перезахода
    // подписывала бы его реплики прежним именем — и спорила бы с собственным
    // ростером, где сервер уже написал новое.
    socket.on('renamed', ({ name }) => {
      if (typeof name !== 'string') return;
      useIdentityStore.getState().adoptNick(name);
      // И подпись своей плитки, если мы сейчас в эфире: остальным сервер уже
      // разослал новое имя, и одна плитка со старым — это спор с самим собой.
      relabelSelf(name);
    });

    // Бан на всю инсталляцию приходит двумя путями, и оба нужны. Живым
    // событием — пока сокет ещё держится, чтобы экран сменился на глазах; и
    // отказом двери при следующей попытке — там сокет не подключается вовсе, и
    // без разбора причины человек видел бы вечное «переподключаюсь».
    socket.on('banned', () => useModerationStore.getState().setBanned(true));
    socket.on('connect_error', (err: Error) => {
      if (err?.message === 'banned') useModerationStore.getState().setBanned(true);
      // Дверь не пустила из-за версии контракта. Сторону сервер называет сам:
      // «обнови приложение» и «этот relay старее твоего приложения» — советы
      // разным людям (см. OutdatedGate).
      if (err?.message === 'client-outdated') useContractStore.getState().setOutdated('client');
      if (err?.message === 'server-outdated') useContractStore.getState().setOutdated('server');
      // Обслуживание. Текст владельца приезжает рядом с ошибкой — другого пути
      // к отвергнутому нет: сокета у него не будет, пока обслуживание идёт.
      if (err?.message === 'maintenance') {
        const data = (err as Error & { data?: { message?: unknown } }).data;
        const text = typeof data?.message === 'string' ? data.message : '';
        useContractStore.getState().setMaintenance(text);
      }
      // Адрес закрыт списком владельца. Слово своё, не банное: попавший под
      // маску мог не делать ничего, и экран у него тоже свой (см. BlockedGate).
      if (err?.message === 'blocked') useContractStore.getState().setBlocked(true);
    });

    // Названо по имени по той же причине, что и обработчики вызова выше:
    // `connect` и `disconnect` слушает ещё и `initVoice` (переподписка на
    // голосовой канал после обрыва), и безымянный `socket.off('connect')`
    // уносил бы заодно и его — навсегда, у него тот же замок «один раз на
    // приложение».
    const onConnect = () => {
      // Дверь открылась — обслуживание кончилось, пока мы стучались.
      if (useContractStore.getState().maintenance !== null) {
        useContractStore.setState({ maintenance: null });
      }
      // И адрес открыт: владелец снял маску, пока клиент переподключался.
      if (useContractStore.getState().blocked) useContractStore.setState({ blocked: false });
      // Дверь открылась — значит бана уже нет: разбанили, пока мы стучались.
      useModerationStore.getState().setBanned(false);
      // Разблокировки едут в handshake пропусками (см. lib/socket) и успевают
      // до первой рассылки реестра. Сюда доходят только серверы без пропуска —
      // пароли, сохранённые прошлой версией клиента. Разблокируем ими один
      // раз: в ответ придёт пропуск, а пароль будет стёрт.
      //
      // Переигрывать пароли здесь и раньше было единственным механизмом — и
      // именно он опаздывал. Ответ на `server-unlock` ждёт scrypt (намеренно
      // дорогой, да ещё и в очереди на два места), а `join` в голосовой канал
      // уходит сразу же — и отбивался, потому что сокет к тому моменту ещё
      // заперт. Пропуск в handshake эту гонку убирает совсем.
      for (const { id, password } of storedServerPasswords()) {
        if (!hasUnlockToken(id)) unlockServer(id, password);
      }
      const room = ui().textRoom;
      if (room) {
        // У сокета новый id, история придёт заново — чистим ленту перед подпиской.
        clearTyping();
        chat().reset();
        socket.emit('chat-join', { room, name: myName() });
      }
      // Та же страховка, что и у канала выше: обрыв сорвал бы сокет и с
      // беседы, а без переспроса `dm-join` лента осталась бы висеть подписанной
      // на комнату, которой сокет больше не в курсе.
      const dmRoom = ui().dmRoom;
      if (dmRoom) {
        clearTyping();
        chat().reset();
        socket.emit('dm-join', { slug: dmRoom }, (res) => {
          if (res.ok || ui().dmRoom !== dmRoom) return;
          ui().leaveDm();
          toast(tx('dm.join.forbidden'));
        });
      }
      // Раздел ЛС открыт — список переписок тоже пережил обрыв только на этой
      // вкладке, сервер о нём знать не обязан.
      // Список переписок спрашиваем всегда, а не только при раскрытом разделе:
      // из него же берутся лица в рейке тулбара, а они видны с первого кадра —
      // при раскрытом разделе список приходил бы вовремя, а на каналах рейка
      // стояла бы пустой до первого захода в ЛС.
      dm().reload();
    };
    socket.on('connect', onConnect);

    // Смена открытого текстового канала: подписка/отписка на сервере. Плюс
    // пересчёт «смотрю ли я в канал» — он зависит ещё и от `view` (сетка голоса
    // закрывает собой чат), поэтому слушаем стор целиком.
    const unsub = useUiStore.subscribe((state, prev) => {
      if (state.textRoom !== prev.textRoom) {
        clearTyping();
        if (state.textRoom) {
          chat().reset();
          // Закреплённое — канала, а не человека: список прежнего, оставшийся
          // на экране, читался бы как закреплённое нового.
          pins().enterChannel();
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
          pins().reset();
          watched = false;
        }
      }
      // Раздел ЛС открыли — подтягиваем список переписок; закрыли и снова
      // открыли — тоже: за это время могла прийти беседа с другого устройства.
      if (state.dmSection && !prev.dmSection) dm().reload();
      // Смена открытой беседы — тот же ход, что у textRoom выше, только вход
      // отдан отдельному `dm-join` (проверка «ты одна из сторон» ему дороже
      // видимости в реестре), а выход — общему `chat-leave`: беседа и канал
      // делят одну и ту же комнату сокета.
      if (state.dmRoom !== prev.dmRoom) {
        clearTyping();
        if (state.dmRoom) {
          const slug = state.dmRoom;
          // Смена одной беседы на другую — свежая лента для новой стороны:
          // без сброса здесь сообщения ПРЕЖНЕГО собеседника оставались бы на
          // экране до тех пор, пока не приедет `chat-history` новой беседы
          // (ChatPanel ничего не увидит, что попросило бы его их спрятать —
          // `textRoom` в обеих сценах и так null). Тот же ход, что ниже у
          // текстового канала, здесь важнее вдвойне: это ветка про то, кто
          // что видит.
          chat().reset();
          // Закреплённого в беседе не бывает вовсе (сервер отказывает, см.
          // задачу 7) — не «сбросить список канала», а закрыть саму панель:
          // оставленная открытой, она повисла бы пустой над личной перепиской.
          pins().reset();
          // dm-стор держит свою активность отдельно (см. её комментарий) —
          // синхронизируем разовым снимком, иначе unread-стор не знает
          // времени последней реплики этой беседы и посчитает «дочитал» по
          // нулю (см. тот же приём в обработчике `dm-activity`).
          unread().noteActivity(slug, dm().activity[slug] ?? 0);
          // Вход в беседу: линия «новые» встаёт на прежней отметке чтения,
          // точка гаснет — ровно как у канала (см. комментарий ниже).
          unread().openChannel(slug);
          unread().setAtBottom(true);
          // Честное состояние, а не оптимистичное `true` — по той же причине,
          // что и у канала: иначе syncWatch ниже перезатрёт только что
          // поставленную линию «новые».
          watched = watching();
          socket.emit('dm-join', { slug }, (res) => {
            // Отказали (не сторона беседы) или адрес не существует — а сцена
            // уже могла уехать дальше, пока шёл ответ: тогда закрывать нечего.
            if (res.ok || ui().dmRoom !== slug) return;
            // Та же фигура, что у `chat-closed` ниже: беседа не откроется
            // никогда, значит держать на ней экран — значит держать пустоту.
            ui().leaveDm();
            toast(tx('dm.join.forbidden'));
          });
        } else {
          chat().reset();
          pins().reset();
          watched = false;
          if (!state.textRoom) {
            // Без общего перехода в текстовый канал: тот уже сделал свой
            // `chat-join` блоком выше, и `chat-leave` здесь выгнал бы сокет
            // из комнаты, в которую он только что вошёл этим же переходом.
            socket.emit('chat-leave');
          }
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

    // Личность узнаётся один раз, миддлварой на подключении, — а рождается она
    // на первом заходе уже ПОСЛЕ того, как сокет подключился. Без этой
    // переподписки первое соединение человека остаётся безымянным до
    // перезагрузки страницы: его сервер записался бы на устройство, а реплики
    // ушли бы в ленту без лица.
    // Звук каналов поменяли на другом устройстве — список в сторе обязан это
    // заметить: иначе сайдбар остался бы с прежними значками до перезагрузки.
    const unsubSound = onPref('sound', (value) => useNotifyStore.getState().adoptLoud(value));

    let known = useIdentityStore.getState().me?.id ?? null;
    const unsubIdentity = useIdentityStore.subscribe((state) => {
      const id = state.me?.id ?? null;
      if (id === known) return;
      known = id;
      if (!id || !socket.connected) return;
      socket.disconnect();
      socket.connect();
    });

    if (!socket.connected) socket.connect();

    return () => {
      unsub();
      unsubIdentity();
      unsubSound();
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
      socket.off('presence');
      socket.off('presence-update');
      // Именной `off` — снимаем СВОЙ обработчик, а не все чужие заодно (см.
      // комментарий у `onCallState`/`onConnect` выше).
      socket.off('disconnect', onDisconnect);
      socket.off('chat-reaction');
      socket.off('chat-edited');
      socket.off('chat-deleted');
      socket.off('chat-pinned');
      socket.off('chat-typing');
      socket.off('chat-activity');
      socket.off('chat-closed');
      socket.off('mention');
      socket.off('mentions');
      socket.off('call-state', onCallState);
      socket.off('call-ended', onCallEnded);
      socket.off('call-incoming', onCallIncoming);
      // Тоже именной, и здесь это не стиль: на `voice-refused` висит ещё и
      // обработчик `lib/call.ts`, а тот вешается один раз на приложение и
      // назад не вернётся. Голый `socket.off('voice-refused')` снял бы его
      // заодно — и законный участник, которому сторож закрыл комнату, остался
      // бы с открытым микрофоном под экраном звонка, которого некому снять.
      socket.off('voice-refused', onVoiceRefused);
      socket.off('dm-activity');
      socket.off('admin-changed');
      socket.off('reads');
      socket.off('prefs');
      socket.off('renamed');
      socket.off('servers');
      socket.off('server-unlock-result');
      socket.off('channels');
      socket.off('connect', onConnect);
    };
  }, []);

  return <>{children}</>;
}
