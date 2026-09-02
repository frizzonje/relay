import { randomUUID } from 'node:crypto';
import type { AppServer, AppSocket } from './socket-data';
import type { PresenceState } from './presence';
import type { CallPerson, CallReplyResult, CallStartResult } from './protocol';
import {
  settled as ringSettled,
  step as ringStep,
  missed as ringMissed,
  type Ring,
  type RingEvent,
} from './ring-machine';

/** Личность в вызове: чем её адресовать внутри и как показать снаружи. */
export interface RingPerson extends CallPerson {
  id: string;
}

/**
 * Что владелец вызовов спрашивает у того, чем не владеет.
 *
 * Четыре из пяти вопросов — про настройки, и все читаются В МОМЕНТ вопроса, а
 * не при сборке: у всей группы `calls` в каталоге стоит `applies: 'now'`, и
 * снятая однажды копия действовала бы до перезапуска процесса — то есть панель
 * говорила бы «сохранено», а звонок звонил бы по вчерашнему числу.
 */
export interface RingSurroundings {
  /** Личность за сокетом. Пусто у гостя по инвайту и у неопознанного клиента. */
  identityOf(sock: AppSocket): RingPerson | undefined;
  /** Где эта личность на всю инсталляцию — отсюда и берётся «занят разговором». */
  stateOf(identityId: string): PresenceState;
  /** Сколько звонить, прежде чем сказать обоим «не ответили». */
  ringTimeoutMs(): number;
  /** Считать ли занятым того, кто сидит в голосовом канале. */
  busyWhenInVoice(): boolean;
  /** Оставляют ли пропущенные след в переписке. */
  marksMissed(): boolean;
  /**
   * Принятый вызов открывает голосовую комнату беседы; вернуть её адрес.
   *
   * Зовётся ровно в миг ответа и ровно один раз — дальше двоими владеет
   * комната, а не вызов (инвариант 4). Адрес считается из id двух личностей, а
   * id в протоколе не появляется вовсе, — значит назвать комнату обоим обязан
   * сервер: вывести её клиенту не из чего.
   */
  openRoom(fromId: string, toId: string): string;
}

/** Живой вызов: сама машина плюс всё, что к ней не относится. */
interface Live {
  ring: Ring;
  /**
   * Кто звонит и кому — снимком на момент набора, а не ссылкой на живой сокет.
   *
   * Снимок нужен ровно для того случая, ради которого вызов вообще существует
   * отдельно от сокета: собеседник пропал, не ответив. В этот момент сокетов у
   * него уже нет, спросить его лицо и подпись не у кого, — а сказать звонящему,
   * КТО пропал, всё равно надо. Переименование посреди сорокапятисекундного
   * дозвона снимок переживёт устаревшим, и это правильная цена.
   */
  from: RingPerson;
  to: RingPerson;
  video: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/** На провод уезжает лицо и подпись: id личности в протоколе не появляется. */
function shown(who: RingPerson): CallPerson {
  return { fingerprint: who.fingerprint, nick: who.nick };
}

/**
 * Владелец живых вызовов: дозвон между двумя людьми — от «позвонить» до ответа
 * и ни секундой дальше.
 *
 * Вызов не принадлежит ни сокету, ни комнате, и оба варианта пробовать не надо.
 * Сокет рвётся посреди дозвона, а вызов обязан пережить закрытую вкладку на
 * ноутбуке, пока звонит телефон. Комнаты же ещё нет вовсе: она заводится
 * ПОСЛЕ ответа, и повесить на неё то, что решает, быть ли ей, невозможно.
 *
 * Разбор гонок сюда не входит: он в чистой машине (`./ring-machine`), которую
 * можно прогнать сотней случаев за миллисекунду. Здесь — четыре инварианта,
 * которых машина знать не может, потому что для каждого нужно видеть всю
 * инсталляцию сразу:
 *
 * 1. **Личность участвует не более чем в одном живом вызове — с любой
 *    стороны.** Из этого правила бесплатно выпадает встречный звонок: двое,
 *    набравшие друг друга в одну секунду, не остаются в двух вызовах, потому
 *    что второй набор упирается в «собеседник уже в вызове». Правило
 *    симметрично по построению — очередь событий в процессе одна, «второй»
 *    определён однозначно, и обе стороны после отказа смотрят на один и тот же
 *    уцелевший вызов: набравший вторым видит входящий от первого и может его
 *    принять (см. `busy`, `start`).
 * 2. **Вызов принадлежит личности, а не устройству.** Звонок доходит до всех
 *    её сокетов, ответ с одного гасит входящий на остальных, а обрыв ОДНОГО
 *    сокета не значит ничего, пока остался хоть один (см. `announce`,
 *    `dropSocket`).
 * 3. **Мёртвый вызов уходит из памяти ровно одним путём.** `forget` — и только
 *    он — снимает таймер и обе метки занятости. Забытый таймер здесь
 *    оборачивается не утечкой, а звонком: сработав, он сказал бы обоим «не
 *    ответили» посреди уже идущего разговора.
 * 4. **Принятый вызов владельцу больше не принадлежит.** `settled('accepted')`
 *    истинно, и вызов выбрасывается в тот же миг: дальше двоими владеет
 *    голосовая комната, и тянуться сюда, чтобы закончить живой разговор,
 *    нельзя. Здесь заканчивается ДОЗВОН, а не беседа. Единственное, что вызов
 *    делает на прощание, — открывает комнату и называет её обоим (`openRoom`):
 *    сам он в неё уже не заглядывает.
 *
 * Гостя по инвайту в вызовах нет ни одной стороной: личности он не предъявлял,
 * адресовать его нечем, и правило это стоит одной строкой — нет `identityOf`,
 * нет и вызова.
 */
export class Rings {
  /** Живые вызовы по их id. Мёртвых здесь не бывает — см. инвариант 3. */
  private readonly live = new Map<string, Live>();

  /**
   * Кто сейчас занят вызовом: identityId → id этого вызова. Обе стороны стоят
   * здесь одинаково — «занят» не различает, звонишь ты или звонят тебе.
   */
  private readonly byIdentity = new Map<string, string>();

  constructor(
    private readonly serverOf: () => AppServer,
    private readonly around: RingSurroundings,
  ) {}

  private get server(): AppServer {
    return this.serverOf();
  }

  // ── Чтение ────────────────────────────────────────────────────────────────

  /**
   * Кто стоит за этим отпечатком — среди тех, кто сейчас на связи.
   *
   * Ищется по живым сокетам, а не в базе, и это не оптимизация, а ответ на два
   * вопроса разом: до кого звонить и чем его показать. Не нашли — значит
   * звонить некуда, и это тот же самый ответ, который дало бы присутствие
   * (`stateOf` вне `online`/`in-voice`): картина присутствия считается по этим
   * же живым сокетам, так что разъехаться два ответа не могут. Спрашиваем
   * здесь, потому что нужны ещё id личности и подпись, а их присутствие не
   * знает.
   */
  whoIs(fingerprint: string): RingPerson | undefined {
    for (const sock of this.server.sockets.sockets.values()) {
      const who = this.around.identityOf(sock);
      if (who?.fingerprint === fingerprint) return who;
    }
    return undefined;
  }

  /**
   * Занята ли личность. Два непохожих случая под одним словом, и оба честны для
   * звонящего: человек уже в вызове (инвариант 1) либо говорит в голосовом
   * канале, а инсталляция считает это занятостью (`calls.busyWhenInVoice`).
   *
   * Второе спрашивается у присутствия, а не у голосовых комнат: «в голосе» —
   * свойство личности, а не сокета, и человек, говорящий с телефона, занят и
   * при открытом ноутбуке.
   */
  busy(identityId: string): boolean {
    if (this.byIdentity.has(identityId)) return true;
    return this.around.busyWhenInVoice() && this.around.stateOf(identityId) === 'in-voice';
  }

  // ── Ход вызова ────────────────────────────────────────────────────────────

  /**
   * Позвонить. Отказывает единственной причиной, которую знает только владелец:
   * кто-то из двоих уже в вызове.
   *
   * Звонящего проверяем по метке занятости, а не через `busy`: сидеть в
   * голосовом канале и звонить оттуда человеку — законно, а вот вести два
   * дозвона сразу — нет. Занятость собеседника, наоборот, полная: он тот, кому
   * сейчас зазвонит.
   */
  start(from: RingPerson, to: RingPerson, video: boolean): CallStartResult {
    if (this.byIdentity.has(from.id) || this.busy(to.id)) return { ok: false, error: 'busy' };
    const at = Date.now();
    // Часы дозвона заводит сама машина: `startedAt` ставит переход `call`, а не
    // этот файл, — иначе начало вызова считалось бы в двух местах.
    const ring = ringStep(
      { id: randomUUID(), from: from.id, to: to.id, state: 'idle', startedAt: at },
      { type: 'call', at },
    );
    const live: Live = { ring, from, to, video, timer: this.armTimeout(ring.id) };
    this.live.set(ring.id, live);
    this.byIdentity.set(from.id, ring.id);
    this.byIdentity.set(to.id, ring.id);
    this.announce(live, at);
    return { ok: true, ringId: ring.id };
  }

  /** Принять входящий. Право есть только у того, кому звонят. */
  accept(identityId: string, ringId: string): CallReplyResult {
    return this.press(identityId, ringId, 'to', 'accept');
  }

  /** Отклонить входящий. Тоже только собеседник: у звонящего своя кнопка. */
  decline(identityId: string, ringId: string): CallReplyResult {
    return this.press(identityId, ringId, 'to', 'decline');
  }

  /** Отбой звонящего — передумал, не дождавшись ответа. */
  cancel(identityId: string, ringId: string): CallReplyResult {
    return this.press(identityId, ringId, 'from', 'cancel');
  }

  /**
   * Сокет ушёл. Человек ушёл вместе с ним, только если это было его последнее
   * устройство: закрытая вкладка на ноутбуке не должна гасить вызов, который
   * звонит в телефоне (инвариант 2).
   *
   * Грейса здесь нет, и это отличие от голосовой сессии намеренное. Там
   * `LEAVE_GRACE_MS` (24 с) переживает моргание сети, не разваливая разговор;
   * здесь ждать нельзя — оба конца смотрят на экран прямо сейчас, а любой
   * осмысленный грейс сравним со всем дозвоном целиком. Цена честная:
   * перезагрузка страницы посреди набора вызов отменяет.
   *
   * Зовётся из `handleDisconnect`, то есть ПОСЛЕ того, как socket.io убрал
   * сокет из своей карты, — иначе `socketsOf` досчитал бы уходящего и вызов
   * пережил бы уход обоих.
   */
  dropSocket(client: AppSocket): void {
    const who = this.around.identityOf(client);
    if (!who) return;
    const live = this.ringOf(who.id);
    if (!live || this.socketsOf(who.id).length) return;
    // Звонящий пропал — это отбой: он сам перестал звонить. Пропавший
    // собеседник — `peer-gone`, и машина делает из этого `failed`: вызов не
    // «отменён», а сорвался, и отметку о пропущенном он оставляет.
    const type: RingEvent['type'] = live.ring.from === who.id ? 'cancel' : 'peer-gone';
    this.advance(live, { type, at: Date.now() });
  }

  // ── Как это устроено внутри ───────────────────────────────────────────────

  private ringOf(identityId: string): Live | undefined {
    const id = this.byIdentity.get(identityId);
    return id ? this.live.get(id) : undefined;
  }

  /**
   * Нажатая кнопка. Чужой `ringId`, чужая сторона и уже закончившийся вызов
   * отвечают одинаково — «такого вызова нет»: разбирать эти случаи по-разному
   * значило бы подтверждать постороннему, что вызов с таким id существует.
   */
  private press(
    identityId: string,
    ringId: string,
    side: 'from' | 'to',
    type: RingEvent['type'],
  ): CallReplyResult {
    const live = this.live.get(ringId);
    if (!live || live.ring[side] !== identityId) return { ok: false, error: 'unknown' };
    this.advance(live, { type, at: Date.now() });
    return { ok: true };
  }

  /**
   * Прогнать событие через машину и рассказать о результате.
   *
   * Сравнение по ссылке — вся проверка «а к месту ли событие»: машина возвращает
   * ТОТ ЖЕ объект, когда событие в этом состоянии не значит ничего, и второй
   * «принять» с другого устройства гаснет здесь, не породив рассылки. Проверять
   * «а не кончился ли уже вызов» отдельно не нужно и нельзя: это правило стоит
   * первой строкой самой машины, одно на все шесть исходов.
   */
  private advance(live: Live, event: RingEvent): void {
    const next = ringStep(live.ring, event);
    if (next === live.ring) return;
    live.ring = next;
    if (ringSettled(next.state)) this.forget(live);
    this.announce(live, event.at);
  }

  /**
   * Единственный путь вызова из памяти (инвариант 3): снимается таймер и обе
   * метки занятости — иначе человек, чей вызов кончился, до перезапуска
   * процесса числился бы занятым и не мог бы ни позвонить, ни принять.
   */
  private forget(live: Live): void {
    clearTimeout(live.timer);
    this.live.delete(live.ring.id);
    for (const id of [live.ring.from, live.ring.to]) {
      if (this.byIdentity.get(id) === live.ring.id) this.byIdentity.delete(id);
    }
  }

  /**
   * Будильник на «не ответили». Живёт в записи вызова и снимается в `forget` —
   * то есть на любом пути наружу, включая ответ, отбой и обрыв.
   *
   * Длительность спрашивается в момент завода, а не при сборке: параметр
   * `applies: 'now'`, и уже звонящий вызов честно доживает по старому числу —
   * менять правила посреди дозвона было бы хуже, чем доиграть по прежним.
   */
  private armTimeout(ringId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const live = this.live.get(ringId);
      if (live) this.advance(live, { type: 'timeout', at: Date.now() });
    }, this.around.ringTimeoutMs());
    timer.unref?.();
    return timer;
  }

  /** Все сокеты этой личности: звонят человеку, а не выбранной вкладке. */
  private socketsOf(identityId: string): AppSocket[] {
    const out: AppSocket[] = [];
    for (const sock of this.server.sockets.sockets.values()) {
      if (this.around.identityOf(sock)?.id === identityId) out.push(sock);
    }
    return out;
  }

  /**
   * Рассказать о вызове обеим сторонам. Три события, и у каждого своя работа:
   *
   * `call-incoming` — «у тебя звонит», на все устройства собеседника.
   * `call-state` — вызов ЖИВ (звонит или принят); принятие им же гасит входящий
   * на тех устройствах, которые не отвечали.
   * `call-ended` — вызов кончился, не став разговором; уходит обеим сторонам,
   * потому что «не ответили» собеседник обязан узнать не меньше звонящего.
   *
   * Каждый вызов кончается ровно одним из двух: `call-state` с `accepted` либо
   * `call-ended`. Третьего нет, и клиенту не приходится гадать, ждать ли ещё.
   */
  private announce(live: Live, at: number): void {
    const { ring } = live;
    if (ring.state === 'ringing') {
      for (const sock of this.socketsOf(ring.to)) {
        sock.emit('call-incoming', {
          ringId: ring.id,
          from: shown(live.from),
          at,
          video: live.video,
        });
      }
      // Звонящему — на все его устройства, а не только на нажавшее: набрав с
      // ноутбука, человек обязан видеть свой же дозвон и в телефоне. Собеседнику
      // тот же факт уже уехал входящим, и второе событие о нём было бы шумом.
      for (const sock of this.socketsOf(ring.from)) {
        sock.emit('call-state', {
          ringId: ring.id,
          state: 'ringing',
          peer: shown(live.to),
          at,
          video: live.video,
        });
      }
      return;
    }
    if (ring.state === 'accepted') {
      // Дверь в разговор открываем ДО рассылки и тут же о ней забываем: узнай
      // оба адрес раньше, чем комната заведена, первый же вошедший упёрся бы в
      // «такой беседы нет». Здесь заканчивается дозвон — и начинается комната.
      const room = this.around.openRoom(ring.from, ring.to);
      this.send(live, 'call-state', (peer) => ({
        ringId: ring.id,
        state: 'accepted',
        peer,
        at,
        video: live.video,
        room,
      }));
      return;
    }
    // Отметку в переписке пишет не этот класс — он лишь считает, будет ли она:
    // `missed` из машины (только «не ответили» и «не в сети») плюс настройка.
    const missed = ringMissed(ring.state) && this.around.marksMissed();
    this.send(live, 'call-ended', (peer) => ({
      ringId: ring.id,
      state: ring.state,
      peer,
      at,
      missed,
    }));
  }

  /**
   * Одно событие обеим сторонам, но не одно и то же: `peer` — это ВТОРАЯ
   * сторона глазами получателя. Разошли мы всем одинаковый снимок, каждый
   * увидел бы в поле «собеседник» в том числе и себя.
   */
  private send(live: Live, event: string, make: (peer: CallPerson) => unknown): void {
    for (const sock of this.socketsOf(live.ring.from)) sock.emit(event, make(shown(live.to)));
    for (const sock of this.socketsOf(live.ring.to)) sock.emit(event, make(shown(live.from)));
  }
}
