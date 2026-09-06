import { create } from 'zustand';
import type {
  CallEndedRelay,
  CallPerson,
  CallRefusal,
  CallStateRelay,
  DmOpenResult,
} from '@relay/shared';
import { settled as ringSettled, step, type Ring, type RingState } from '@relay/shared';
import { ask } from '@/lib/channels';
import { cancelCall, dialCall, hangUp as hangUpCall, ownedCall } from '@/lib/call';
import { useSetting } from '@/stores/config';
import { useUiStore } from '@/stores/ui';
import type { MessageKey } from '@/lib/i18n';

/**
 * Экран исходящего вызова (задача 6 плана B).
 *
 * Границы ответственности зеркальны `lib/call.ts`: тот владеет РАЗГОВОРОМ
 * (комнатой беседы) и решает, кому сидеть в mesh; этот стор владеет ВЫЗОВОМ —
 * тем, что написано на экране «дозваниваемся», пока ответа ещё нет. Как
 * только `call-state` приносит `accepted`, вызов кончается и начинается
 * разговор — экран гаснет, а комнату досаживает уже `lib/call.ts` (см. его
 * `seat()`). Ни один emit сюда не дублируется: и «позвонить», и «отбой» этот
 * стор просит сделать `lib/call.ts` (`dialCall`/`hangUp`) — здесь только то,
 * что этот файл не может знать сам: как называется вызов на экране и когда
 * экран убрать.
 *
 * Машина состояний — `packages/shared/src/ring.ts`, буквально: тот же `step`,
 * которым водит вызов гейтвей. Дозвон отсюда сперва проходит через `call`
 * (шлём `call-start`), а конец — через `accept`/`decline`/`cancel`/`timeout`/
 * `busy`/`peer-gone`, ровно как и на сервере. Так гонки (отбой и приём
 * впритык, опоздавший таймаут) разбираются одним и тем же кодом, а не двумя
 * похожими, которые однажды разойдутся.
 */

/** Отказ ДО того, как что-либо зазвонило (ack `call-start`, кроме двух пунктов ниже). */
type RingRefusal = Exclude<CallRefusal, 'busy' | 'offline'>;

/** Что нарисовано на экране исходящего вызова. */
export interface OutgoingScreen {
  peer: CallPerson;
  video: boolean;
  /**
   * Машина дозвона. `id` пуст, пока не пришёл ack `call-start`, — экран уже
   * открыт (см. `start`), а вызов на сервере, может, ещё не заведён.
   */
  ring: Ring;
  /**
   * Заполнено, только если экран открыт отказом, который случился РАНЬШЕ, чем
   * что-либо зазвонило (`disabled`/`forbidden`/`rate`). `busy` и `offline` в
   * эту переменную не попадают: они — настоящие исходы машины (`busy`,
   * `failed`), и подпись для них берётся из той же таблицы, что и у обычного
   * `call-ended` (см. `outgoingCaption`, пункты 2 и 3 брифа задачи 6).
   */
  refusal: RingRefusal | null;
}

interface RingStoreState {
  /** Пусто — экран дозвона не открыт. */
  outgoing: OutgoingScreen | null;
  /** Позвонить: открывает экран, шлёт `call-start` через `lib/call.ts`. */
  start: (peer: CallPerson, video?: boolean) => Promise<void>;
  /** Рассылка `call-state`: живой вызов (у ДРУГОГО устройства той же личности) либо разговор начался. */
  applyState: (payload: CallStateRelay) => void;
  /** Вызов кончился, не став разговором. */
  applyEnded: (payload: CallEndedRelay) => void;
  /**
   * Отбой самим звонящим. Тот же путь, что и «Закрыть» на уже завершённом
   * экране: `endRing()` безопасен и там, и там — рабочему вызову он шлёт
   * `call-cancel`, у мёртвого не найдёт ни номера, ни `mine`, ни `room` и
   * промолчит.
   */
  hangUp: () => void;
  /**
   * «Написать вместо звонка»: тот же отбой, что у кнопки «Отбой» (вызывается
   * ОДНИМ и тем же `hangUpCall()`, а не второй копией), и следом переход в
   * переписку. Экран закрывается до запроса `dm-open`, а не после: человек
   * уже сказал «хватит звонить», и ждать ответа сервера, чтобы это признать,
   * незачем.
   */
  writeInstead: () => void;
  /**
   * Сокет оборвался. Экран гаснет молча — и это не перестраховка: вызов
   * звонящего сервер кончает В ТОТ ЖЕ МИГ, как ушло его последнее устройство,
   * без грейса (§4.2 протокола, `RingDesk.dropSocket`). Свой же
   * `call-ended{cancelled}` он при этом шлёт в сокет, которого уже нет, — эхо,
   * которого эта вкладка не увидит никогда, а на переподключении вызовы
   * заново не рассылаются. Оставь экран как есть — и он будет пульсировать
   * «дозваниваемся» на вызове, которого больше нет, ровно в том состоянии,
   * ради честности которого он и заведён. Ничего не шлём: слать некуда.
   */
  lost: () => void;
  /** Сброс между тестами / выходом из инсталляции. */
  reset: () => void;
}

/**
 * Кончить дозвон и на сервере, и на экране. Экран открывается двумя путями, и
 * бросают вызов они по-разному:
 *
 *  • **набрали здесь** — вызовом владеет `lib/call.ts` (его `mine`), и только
 *    он знает, чем именно этот вызов бросить: у принятого и уже посаженного
 *    разговора это выход из комнаты, а не `call-cancel`;
 *  • **набрали на соседнем устройстве** — `call-state{ringing}` уходит на все
 *    устройства звонящего (§4.2), и экран открылся здесь по нему (см.
 *    `applyState`). У этой вкладки нет ни `mine`, ни комнаты, и `hangUpCall()`
 *    промолчал бы: экран бы погас, а у собеседника продолжало бы звонить.
 *    Поэтому называем вызов по имени — `cancelCall(id)`; право на отбой
 *    сервер проверяет по личности, и второе устройство звонящего для него
 *    законная сторона.
 *
 * Номера может не быть вовсе (ack `call-start` ещё не пришёл) — тогда бросать
 * нечего и незачем: вернувшийся ack отобьёт вызов сам (см. `start`).
 */
function endRing(current: OutgoingScreen | null): void {
  const id = current?.ring.id;
  if (id && ownedCall() !== id) {
    cancelCall(id);
    return;
  }
  hangUpCall();
}

/** Пустая машина в состоянии дозвона — общий старт и для набора, и для чужой рассылки. */
function ringingRing(id: string, to: string, at: number): Ring {
  return step({ id, from: '', to, state: 'idle', startedAt: at }, { type: 'call', at });
}

/**
 * Каким `RingEvent` кончить локальную машину, чтобы получить нужный
 * `CallEndedRelay.state`. `cancelled` сюда не входит: `applyEnded` решает его
 * раньше и отдельно (закрывает экран молча, см. её комментарий) — держать тут
 * ещё и мёртвую строку под него значило бы утверждать, что это состояние сюда
 * когда-нибудь доходит.
 */
const END_EVENT: Record<
  Exclude<CallEndedRelay['state'], 'cancelled'>,
  'decline' | 'timeout' | 'busy' | 'peer-gone'
> = {
  declined: 'decline',
  'no-answer': 'timeout',
  busy: 'busy',
  failed: 'peer-gone',
};

export const useRingStore = create<RingStoreState>((set, get) => ({
  outgoing: null,

  start: async (peer, video = false) => {
    const now = Date.now();
    set({
      outgoing: { peer, video, ring: ringingRing('', peer.fingerprint, now), refusal: null },
    });
    const res = await dialCall(peer.fingerprint, video);
    const current = get().outgoing;
    // Экран уже закрыли (отбой, «написать вместо») раньше, чем пришёл ack, —
    // не дождавшись номера, отбить было нечем (`lib/call.ts` не знает `mine`
    // ДО ack). Номер уже есть — самое время вернуть вызов, которого больше не
    // ждут. Сверка по отпечатку — на случай, если экран успели переоткрыть
    // на другого собеседника: тогда ack тоже не про то, что сейчас на экране.
    if (!current || current.peer.fingerprint !== peer.fingerprint) {
      if (res.ok) hangUpCall();
      return;
    }
    if (res.ok) {
      set({ outgoing: { ...current, ring: { ...current.ring, id: res.ringId } } });
      return;
    }
    set({ outgoing: refuse(current, res.error, now) });
  },

  applyState: (payload) => {
    const current = get().outgoing;
    if (payload.state === 'accepted') {
      // Разговор начался — эту вкладку сажает `lib/call.ts` (`seat()`).
      // Экран дозвона про ожидание ответа, а не про сам разговор.
      if (current?.ring.id === payload.ringId) set({ outgoing: null });
      return;
    }
    // `ringing` уходит на ВСЕ устройства звонящего (протокол §4.2). Свою же
    // попытку `start()` уже нарисовал сам — а личность живёт не более чем в
    // одном вызове разом, так что второй экран здесь означал бы либо эхо того
    // же вызова (id совпадёт — трогать нечего), либо чужую копию поверх уже
    // открытой (не бывает по тому же правилу). Открываем заново только когда
    // на этом устройстве пусто — тогда это другое устройство той же личности
    // начало набор первым.
    if (current) return;
    set({
      outgoing: {
        peer: payload.peer,
        video: payload.video,
        ring: ringingRing(payload.ringId, payload.peer.fingerprint, payload.at),
        refusal: null,
      },
    });
  },

  applyEnded: (payload) => {
    const current = get().outgoing;
    if (!current || current.ring.id !== payload.ringId) return;
    if (payload.state === 'cancelled') {
      // Свой же отбой эхом с сервера (см. `CallEndedRelay`: уходит обеим
      // сторонам) — либо тот же исход на другом нашем устройстве. Экран уже
      // закрыт нажатием кнопки либо не открывался этой вкладкой вовсе;
      // рисовать здесь нечего — «отбой» объясняет себя самим закрытием.
      set({ outgoing: null });
      return;
    }
    set({
      outgoing: {
        ...current,
        ring: step(current.ring, { type: END_EVENT[payload.state], at: payload.at }),
      },
    });
  },

  hangUp: () => {
    endRing(get().outgoing);
    set({ outgoing: null });
  },

  writeInstead: () => {
    const current = get().outgoing;
    if (!current) return;
    endRing(current);
    set({ outgoing: null });
    void ask<DmOpenResult>('dm-open', { fingerprint: current.peer.fingerprint }).then((res) => {
      if (res?.ok) {
        useUiStore
          .getState()
          .openDm(res.conversation.slug, current.peer.fingerprint, current.peer.nick);
      }
    });
  },

  lost: () => set({ outgoing: null }),

  reset: () => set({ outgoing: null }),
}));

/** Отказ ДО дозвона переводит машину в её терминальный исход — тем же `step`, что и настоящий конец. */
function refuse(current: OutgoingScreen, error: CallRefusal, at: number): OutgoingScreen {
  if (error === 'busy') return { ...current, ring: step(current.ring, { type: 'busy', at }) };
  // `offline` (отказ ДО вызова) и `failed` (исход `call-ended`, собеседник
  // пропал ПОСЛЕ того, как уже звонило) — два разных пути к одному и тому же
  // «не в сети» (пункт 3 брифа задачи 6). `peer-gone` — тот же `RingEvent`,
  // которым `applyEnded` превращает `call-ended{failed}` в это же состояние,
  // так что и подпись, и цвет берутся из ОДНОЙ строки таблицы `RING_CAPTION`,
  // а не из двух, которым однажды случится разойтись.
  if (error === 'offline')
    return { ...current, ring: step(current.ring, { type: 'peer-gone', at }) };
  // `disabled` / `forbidden` / `rate` — набора не было вовсе: сервер отказал
  // раньше, чем что-либо зазвонило. Машину не двигаем (она лгала бы, что
  // «дозванивались») — экран решает по `refusal`, что показать.
  return { ...current, ring: { ...current.ring, endedAt: at }, refusal: error };
}

/** Подпись и цвет (класс Tailwind текста) по состоянию. */
interface Caption {
  key: MessageKey;
  color: string;
}

/**
 * Подпись по состоянию машины. `idle`/`accepted`/`cancelled` не рисуются
 * никогда: `idle` — экран мог быть открыт только `refusal`'ом (см. выше),
 * `accepted` и `cancelled` гасят экран раньше первого кадра (см. `applyState`
 * и `hangUp`/`writeInstead`/`applyEnded`). Но `Record` требует прописать все
 * восемь: пропуск ветки здесь значил бы не «подпись не нужна», а «этот код не
 * узнает, что для нового состояния подписи не завели», — а это как раз то,
 * ради чего каталог такой же полный в `ring.ts` (см. его `SETTLED`/`MISSED`).
 */
const RING_CAPTION: Record<RingState, Caption | null> = {
  idle: null,
  ringing: { key: 'call.state.ringing', color: 'text-text-muted' },
  accepted: null,
  declined: { key: 'call.state.declined', color: 'text-danger' },
  'no-answer': { key: 'call.state.noAnswer', color: 'text-danger' },
  // `busy` сегодня приходит только отказом `call-start`, ДО ack (протокол
  // §4.2 говорит это прямо), — исход `call-ended{busy}` мёртв, пока звонящий
  // сам не научится отвечать «занято» на второй входящий. Ветка тут не ради
  // текущего пути, а ради него: `applyEnded` уже умеет её обработать, и
  // подпись под неё готова заранее (пункт 4 брифа задачи 6).
  busy: { key: 'call.state.busy', color: 'text-warn' },
  cancelled: null,
  failed: { key: 'call.state.offline', color: 'text-text-faint' },
};

const REFUSAL_CAPTION: Record<RingRefusal, Caption> = {
  disabled: { key: 'call.refusal.disabled', color: 'text-text-faint' },
  forbidden: { key: 'call.refusal.forbidden', color: 'text-text-faint' },
  rate: { key: 'call.refusal.rate', color: 'text-text-faint' },
};

/**
 * Подпись экрана — единственная точка, которую читают и сам экран
 * (`OutgoingCall.tsx`), и (по отчёту задачи 6) задачи 7 и 10.
 */
export function outgoingCaption(screen: OutgoingScreen): Caption {
  if (screen.refusal) return REFUSAL_CAPTION[screen.refusal];
  // Экран не показывает `idle`/`accepted`/`cancelled` без `refusal` ни при
  // каком реальном пути (см. комментарий у `RING_CAPTION`) — откат на
  // `ringing` тут только затем, чтобы функция была тотальной и honest даже на
  // чужом будущем состоянии, а не молчала пустой строкой.
  return RING_CAPTION[screen.ring.state] ?? (RING_CAPTION.ringing as Caption);
}

/** Живой ли вызов прямо сейчас — решает, пульсируют ли кольца и что значит нижняя кнопка. */
export function outgoingLive(screen: OutgoingScreen): boolean {
  return !screen.refusal && !ringSettled(screen.ring.state);
}

/**
 * Можно ли вообще предложить звонок — общий источник для кнопки в
 * `DmPeerCard`, шапке `DmThread` и мобильной `MobileNav`. Разведи эту
 * проверку по трём местам — и однажды `calls.enabled`/`calls.whoCanCall`
 * погасят кнопку в одном месте, но не в другом.
 *
 * `calls.whoCanCall === 'conversation'` здесь не проверяется: все три места
 * стоят ВНУТРИ уже открытой переписки, и «с кем есть беседа» этим самим
 * фактом уже выполнено. Различать `conversation` и `everyone` тут нечем и
 * незачем.
 */
export function useCallGate(): { allowed: true } | { allowed: false; reasonKey: MessageKey } {
  const enabled = useSetting<boolean>('calls.enabled');
  const whoCanCall = useSetting<'everyone' | 'conversation' | 'nobody'>('calls.whoCanCall');
  if (!enabled) return { allowed: false, reasonKey: 'call.refusal.disabled' };
  if (whoCanCall === 'nobody') return { allowed: false, reasonKey: 'call.refusal.forbidden' };
  return { allowed: true };
}

/** Видео при наборе доступно инсталляции — тот же приём, что и `useCallGate`. */
export function useCallVideoAllowed(): boolean {
  return useSetting<boolean>('calls.videoAllowed');
}
