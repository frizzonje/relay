import { Logger } from '@nestjs/common';
import type { AppServer, AppSocket } from './socket-data';
import type { VoicePresenceEntry } from './protocol';
import { ANON_NAME } from './protocol';

/**
 * С этого начинается имя голосовой комнаты беседы.
 *
 * Префикс здесь не украшение. Адрес беседы — это ещё и слаг её текстовой
 * ленты, а комнаты socket.io у ленты и у эфира общие: назови мы комнату
 * разговора самим адресом, `peer-left` и весь сигналинг звонка уезжали бы
 * каждому, кто просто открыл переписку.
 *
 * Двойник строки живёт в `@relay/shared` (`CALL_ROOM_PREFIX`), а совпадение
 * стережёт контрактный тест: разъехавшись, половины посадили бы двоих в разные
 * комнаты — и принятый вызов кончался бы тишиной.
 */
export const CALL_ROOM_PREFIX = 'voice:';

/** Комната беседы по её адресу (`DmService.address`). */
export function callRoom(address: string): string {
  return CALL_ROOM_PREFIX + address;
}

/**
 * Комната беседы это или обычный голосовой канал.
 *
 * Проверяется форма целиком, а не один префикс: «voice:болталка» — законное
 * имя комнаты, и пустив его за ту же дверь, мы заперли бы обычный эфир
 * правилами разговора двоих (тот же довод, что у `isDmSlug`).
 */
export function isCallRoom(room: string): boolean {
  return /^voice:dm-[0-9a-f]{24}$/.test(room);
}

/**
 * Что голосовая сессия спрашивает у того, чем не владеет.
 *
 * Список короткий намеренно: это и есть граница. Личность, гостевой контур и
 * реестр каналов живут своей жизнью, а разговору от них нужно ровно четыре
 * ответа — и один хук на случай, когда грейс истёк и уходить пора не только
 * из эфира.
 */
export interface VoiceSurroundings {
  /** Отпечаток ключа — если сокет предъявил личность. Едет в presence. */
  fingerprintOf(sock: AppSocket): string | undefined;
  /**
   * Id личности за сокетом — тот же ответ, что у присутствия и у дозвона:
   * гость по инвайту личности не предъявлял, даже если в его вкладке лежит
   * кука. По нему и только по нему решается, кто из двоих вошёл в комнату
   * беседы: сокет, устройство и вкладка тут ни при чём — вызов принадлежал
   * человеку.
   */
  identityOf(sock: AppSocket): string | undefined;
  /** Гость ли: пришёл по инвайту, без личности и без реестра. */
  isGuest(sock: AppSocket): boolean;
  /** Комната гостя — или `undefined`, если сокет пришёл не по инвайту. */
  guestRoomOf(sock: AppSocket): string | undefined;
  /** Слушатель: право говорить выдано не всякому гостю. */
  isListener(sock: AppSocket): boolean;
  /** Голосовые каналы, видимые этому сокету (правило белого списка). */
  visibleVoiceSlugs(sock: AppSocket): Set<string>;
  /** Грейс истёк — что ещё закрыть за этим сокетом (лента и её ростер). */
  onGraceExpired(sock: AppSocket): void;
  /**
   * Сокет вошёл в эфир или вышел из него.
   *
   * За голосом следит не только этот класс: глобальное присутствие личности
   * («в голосе») считается по тем же комнатам. Уведомляем отсюда, а не из
   * обработчиков `join`/`leave`, потому что выходов больше, чем событий: из
   * эфира вынимают ещё и бан с сервера, и истёкший грейс, — и присутствие,
   * знающее только про два события из четырёх, докладывало бы «в голосе» про
   * человека, которого оттуда только что вынесли.
   */
  onVoiceChanged(sock: AppSocket): void;
}

/**
 * Владелец голосовой сессии: комната, транспорт, пропуск в медиасервер, мут и
 * глушилка — вместе со всем, что должно меняться с ними заодно.
 *
 * До этого класса те же пять полей правились из четырнадцати мест, и цена
 * известна поимённо: забытый `sfuPassRoom` при выходе оставлял человека
 * помеченным «через медиасервер» в канале, из которого он ушёл, — и исправный
 * p2p выглядел расщеплённым. Ошибка была не в логике выхода, а в том, что
 * «выйти» нигде не было записано целиком.
 *
 * Здесь оно записано целиком. Три инварианта, которыми оплачен стабильный
 * разговор, дальше видны в одном файле:
 *
 * 1. **Выход стирает пропуск.** Пропуск описывает СЛЕДУЮЩИЙ вход; переживи он
 *    выход — соврал бы про транспорт (см. `leave`, `forgetPass`).
 * 2. **Грейс длиннее окна восстановления.** 24 с против 20 с у
 *    `connectionStateRecovery`: моргание сети не должно выкидывать из канала, и
 *    порядок здесь именно такой, а не наоборот (см. `hold`).
 * 3. **Прошлый сокет того же устройства уходит сам.** Перезагрузка страницы —
 *    это новый socket.id, старый висел бы весь грейс, и всё это время человека
 *    двоило бы у остальных (см. `evictGhost`).
 * 4. **Комната беседы держит ровно двоих, названных её адресом.** Она не канал
 *    реестра, и запирать её нечем, кроме этого списка: без него в разговор
 *    двоих входил бы всякий, кто угадал имя комнаты. Открывает её принятый
 *    вызов, кончает — уход любого из двоих, и медиасервера у неё не бывает
 *    никогда (см. `openCallRoom`, `mayEnterCallRoom`, `endCall`,
 *    `transportFor`).
 */
export class VoiceSessions {
  /**
   * Грейс на возвращение перед тем, как остальным скажут об уходе. Он ОБЯЗАН
   * быть длиннее окна `connectionStateRecovery` (20 с) — иначе socket.io ещё
   * восстанавливает сессию, а комнату мы уже распустили.
   */
  static readonly LEAVE_GRACE_MS = 24_000;

  /**
   * Сколько открытая комната беседы ждёт, пока в неё войдут.
   *
   * Не грейс и не таймаут разговора: это срок жизни ОТКРЫТОЙ, но так и не
   * занятой комнаты — обе вкладки закрыли в ту же секунду, в которую нажали
   * «принять». Без него запись о такой беседе лежала бы в памяти до
   * перезапуска процесса. Занятую комнату он не трогает: её убирает `endCall`,
   * а подметание пропускает всё, где ещё кто-то есть (см. `openCallRoom`).
   */
  static readonly CALL_ROOM_OPEN_MS = 60_000;

  /** Пачка событий за окно = один emit с итоговым состоянием. */
  private static readonly PRESENCE_DEBOUNCE_MS = 80;

  /** Отложенные выходы по socket.id: вернулся вовремя — отменяем. */
  private readonly pendingLeave = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * clientId (стабильный id устройства) → кто от него сейчас в эфире. По этой
   * карте и выгоняется «призрак» прошлой вкладки.
   */
  private readonly members = new Map<string, { id: string; room: string }>();

  /**
   * Открытые комнаты бесед: имя комнаты → две личности, которым она открыта, и
   * когда её открыли. Эта карта и есть замок разговора (инвариант 4): нет
   * записи — нет и комнаты, кто бы её ни назвал.
   */
  private readonly talks = new Map<string, { members: [string, string]; at: number }>();

  private presenceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly serverOf: () => AppServer,
    private readonly around: VoiceSurroundings,
    private readonly logger: Logger,
  ) {}

  private get server(): AppServer {
    return this.serverOf();
  }

  // ── Чтение ────────────────────────────────────────────────────────────────

  /** Голосовой канал этого сокета — или `undefined`, если он не в эфире. */
  roomOf(client: AppSocket): string | undefined {
    return client.data.room;
  }

  /** Имя, под которым сокет говорит в эфире. */
  nameOf(client: AppSocket): string | undefined {
    return client.data.name;
  }

  /** Канал, на который выписан пропуск в медиасервер. */
  passRoom(client: AppSocket): string | undefined {
    return client.data.sfuPassRoom;
  }

  /**
   * Как этот сокет ведёт разговор.
   *
   * Клиент называет транспорт сам — сервер знает лишь режим канала, а решение
   * принимает клиент, и оно может законно разойтись с режимом (медиасервер не
   * поднялся у него одного, нативный iOS про SFU вовсе не знает). Клиент
   * прошлой версии поля не пришлёт — за него отвечает выданный пропуск: считать
   * такого p2p нельзя, остальные съехали бы в прямые звонки и разъехались бы с
   * ним уже по-настоящему.
   */
  transportFor(client: AppSocket, asked: unknown, room: string): 'p2p' | 'sfu' {
    // Кроме комнаты беседы: двоим медиасервер не нужен никогда, и спрашивать
    // об этом клиента незачем. Слово ему здесь не дают вовсе — попроси он
    // `sfu`, и получил бы пропуск в комнату, которой в реестре нет, а с ним и
    // расщепление на ровном месте.
    if (isCallRoom(room)) return 'p2p';
    if (asked === 'sfu' || asked === 'p2p') return asked;
    return this.passRoom(client) === room ? 'sfu' : 'p2p';
  }

  /** Какими транспортами сейчас звонят в комнате. Больше одного = расщепление. */
  transportsInRoom(room: string): Set<string> {
    const kinds = new Set<string>();
    for (const id of this.server.sockets.adapter.rooms.get(room) ?? []) {
      const sock = this.server.sockets.sockets.get(id);
      if (sock) kinds.add(sock.data.transport === 'sfu' ? 'sfu' : 'p2p');
    }
    return kinds;
  }

  /**
   * Сколько человек уже в комнате — так, как их считает предел на канал.
   *
   * Себя и своего же «призрака» не считаем. Призрак — прошлый сокет того же
   * устройства (перезагрузка страницы, второй таб): он всё равно уйдёт из
   * комнаты через мгновение (см. `evictGhost`), и посчитай мы его — человек,
   * обновивший вкладку, упирался бы в предел, который сам же и занимает.
   *
   * `only` сужает счёт до гостей: у них свой предел, и общий его не заменяет.
   */
  occupants(room: string, client: AppSocket, only?: 'guests'): number {
    const ghost = client.data.clientId ? this.members.get(client.data.clientId)?.id : undefined;
    let count = 0;
    for (const id of this.server.sockets.adapter.rooms.get(room) ?? []) {
      if (id === client.id || id === ghost) continue;
      // В adapter.rooms может висеть id уже отвалившегося сокета (окно
      // connectionStateRecovery) — место он не занимает, как и в `peersIn`.
      const sock = this.server.sockets.sockets.get(id);
      if (!sock) continue;
      if (only === 'guests' && !this.around.isGuest(sock)) continue;
      count += 1;
    }
    return count;
  }

  /** Соседи по комнате, какими их видит новичок: кому слать offer'ы. */
  peersIn(room: string): {
    id: string;
    name: string | undefined;
    fingerprint?: string;
    guest?: true;
    listen?: true;
  }[] {
    // Только реально подключённые: в adapter.rooms может ещё висеть id
    // отвалившегося пира (окно connectionStateRecovery) — ему offer слать некому.
    const ids = this.server.sockets.adapter.rooms.get(room) ?? new Set<string>();
    return [...ids]
      .filter((id) => this.server.sockets.sockets.has(id))
      .map((id) => {
        const sock = this.server.sockets.sockets.get(id);
        const fingerprint = sock ? this.around.fingerprintOf(sock) : undefined;
        return {
          id,
          name: sock?.data.name,
          ...(fingerprint ? { fingerprint } : {}),
          ...(sock && this.around.isGuest(sock) ? { guest: true as const } : {}),
          ...(sock && this.around.isListener(sock) ? { listen: true as const } : {}),
        };
      });
  }

  // ── Вход и выход ──────────────────────────────────────────────────────────

  /**
   * Сокет заходит в голосовой канал.
   *
   * Порядок внутри неслучаен и держится на двух вещах: из прошлой комнаты
   * выходим ДО входа в новую (повторный `join` без `leave` бывает после
   * обрыва), а «призрака» своего же устройства выгоняем ДО сбора списка пиров —
   * иначе новичок получит в соседи сам себя.
   *
   * Возвращает соседей: их собирать надо между выселением призрака и входом в
   * комнату, и это единственный момент, когда список правдив.
   */
  enter(
    client: AppSocket,
    opts: { room: string; name: string | undefined; transport: 'p2p' | 'sfu'; clientId?: string },
  ): ReturnType<VoiceSessions['peersIn']> {
    const { room, name, transport, clientId } = opts;

    this.leave(client);
    if (clientId) this.evictGhost(clientId, client.id);
    // Второе устройство того же человека — не третий в комнате: разговор
    // переезжает к нему, а прошлое устройство уходит из комнаты. Без этого
    // «двое» в беседе держались бы на честном слове клиента (инвариант 4).
    if (isCallRoom(room)) this.evictTwin(client, room);

    const peers = this.peersIn(room);

    // `void` — сигнатура socket.io: `join`/`leave` объявлены `void | Promise<void>`
    // ради асинхронных адаптеров, у встроенного они синхронны.
    void client.join(room);
    client.data.room = room;
    client.data.name = name;
    client.data.transport = transport;
    if (clientId) this.members.set(clientId, { id: client.id, room });
    // Медиасостояние прошлого захода не тащим: клиент пришлёт своё сразу после join.
    client.data.micOn = undefined;
    client.data.deafened = undefined;
    this.around.onVoiceChanged(client);

    return peers;
  }

  /**
   * Сокет выходит из голосового канала. Пусто — значит его там и не было, и
   * тогда это ничего не делает: `leave` зовут и вслепую (бан, кик, повторный
   * `join`), и вслепую он обязан быть безопасным.
   */
  leave(client: AppSocket, opts: { endsCall?: boolean } = {}): void {
    const room = client.data.room;
    if (!room) return;

    this.logger.log(`voice: ${client.data.name || '?'} (${client.id}) left "${room}"`);
    client.to(room).emit('peer-left', { id: client.id });
    void client.leave(room);
    client.data.room = undefined;
    client.data.transport = undefined;
    // Пропуск выписан на комнату, из которой мы только что вышли: дальше он
    // способен только соврать про транспорт. Инвариант 1.
    client.data.sfuPassRoom = undefined;
    const clientId = client.data.clientId;
    if (clientId && this.members.get(clientId)?.id === client.id) {
      this.members.delete(clientId);
    }
    this.broadcast();
    this.around.onVoiceChanged(client);
    // Ушёл один — разговора больше нет. `endsCall: false` говорят те два
    // выхода, которые уходом человека не являются: прошлая вкладка того же
    // устройства и его же второе устройство (см. `evictGhost`, `evictTwin`).
    if (opts.endsCall !== false) this.endCall(room);
  }

  /**
   * Убрать прошлый сокет того же устройства из эфира. Два случая:
   * — сокет ещё жив (второй таб, сессия сохранена CSR) — штатный `leave`;
   * — сокет уже отвалился (перезагрузка) — шлём `peer-left` по его id в ЕГО
   *   комнату, чтобы плитку сняли сразу, не дожидаясь грейса.
   * В обоих отменяем отложенный выход.
   */
  private evictGhost(clientId: string, keepId: string): void {
    const ghost = this.members.get(clientId);
    if (!ghost || ghost.id === keepId) return;
    const timer = this.pendingLeave.get(ghost.id);
    if (timer) {
      clearTimeout(timer);
      this.pendingLeave.delete(ghost.id);
    }
    const sock = this.server.sockets.sockets.get(ghost.id);
    if (sock) {
      // Живой сокет: штатный выход сам снимет запись из members. Разговора он
      // не кончает — это прошлая вкладка ТОГО ЖЕ устройства, а не второй
      // участник, который ушёл.
      this.leave(sock, { endsCall: false });
    } else {
      // Отвалившийся: сокета уже нет — сами уведомляем комнату и чистим карту.
      this.server.to(ghost.room).emit('peer-left', { id: ghost.id });
      this.members.delete(clientId);
      this.broadcast();
    }
  }

  // ── Комната беседы ────────────────────────────────────────────────────────

  /**
   * Принятый вызов открыл комнату беседы. Возвращает её имя — тем же, кто её
   * открыл, оно и уезжает обеим сторонам.
   *
   * Открывает её дозвон и тут же о ней забывает: дальше двоими владеет
   * комната, а не вызов. Дверь обязана открыться РАНЬШЕ, чем оба узнают адрес,
   * — иначе первый же вошедший упрётся в «такой беседы нет».
   *
   * Заодно подметаем открытые, но так и не занятые: обе вкладки закрыли сразу
   * после «принять», и запись о такой беседе иначе лежала бы до перезапуска
   * процесса. Занятых подметание не касается — разговор длиной в час законен, а
   * пустоту комнаты считаем по живым сокетам: id отвалившегося висит в
   * `adapter.rooms` ещё окно `connectionStateRecovery`, и по нему комната
   * выглядела бы занятой (тот же довод, что в `peersIn`).
   */
  openCallRoom(room: string, members: [string, string]): string {
    const stale = Date.now() - VoiceSessions.CALL_ROOM_OPEN_MS;
    for (const [name, open] of this.talks) {
      if (open.at > stale || !this.emptyRoom(name)) continue;
      this.talks.delete(name);
    }
    this.talks.set(room, { members, at: Date.now() });
    return room;
  }

  /**
   * Вправе ли сокет войти в эту комнату — вопрос, который задают только
   * комнате беседы (инвариант 4). Обычный голосовой канал отвечает «да»: его
   * дверь стережёт контур (`mayEnter`), и двух замков на ней не нужно.
   *
   * Отказов ровно два и они разные по смыслу, но один по ответу: комнаты нет
   * (её не открывали, либо разговор уже кончился) — и спрашивающий не один из
   * двоих. Разбирать их по-разному значило бы подтверждать постороннему, что
   * беседа с таким адресом существует.
   */
  mayEnterCallRoom(client: AppSocket, room: string): boolean {
    if (!isCallRoom(room)) return true;
    const open = this.talks.get(room);
    if (!open) return false;
    const me = this.around.identityOf(client);
    return !!me && (open.members[0] === me || open.members[1] === me);
  }

  /**
   * Разговор кончился: ушёл один — значит и второй. Комната на одного это не
   * звонок на удержании, а человек, слушающий тишину.
   *
   * Запись снимаем ПЕРВОЙ, и это не уборка ради порядка: `leave` ниже позовёт
   * этот же метод, и без снятой записи два участника кончали бы разговор друг
   * другу по кругу. Она же и запирает комнату обратно — вернуться в кончившийся
   * разговор нельзя даже тому, кто в нём был.
   *
   * Сказать и вывести — оба обязательны. Один вывод для вкладки не событие: она
   * осталась бы с экраном звонка и открытым микрофоном. Одно событие без вывода
   * оставило бы в комнате того, кто его не разобрал (старый клиент, нативка), —
   * и присутствие честно докладывало бы «в голосе» про человека, с которым уже
   * некому говорить.
   */
  private endCall(room: string): void {
    if (!this.talks.delete(room)) return;
    for (const id of [...(this.server.sockets.adapter.rooms.get(room) ?? [])]) {
      const sock = this.server.sockets.sockets.get(id);
      if (!sock) continue;
      sock.emit('call-over', { room });
      this.leave(sock, { endsCall: false });
    }
  }

  /**
   * Другое устройство той же личности уходит из комнаты беседы: разговор
   * переехал к новому, а не стал разговором троих. Прошлому говорим то же, что
   * и оставшемуся при уходе собеседника, — для него этот разговор кончился.
   */
  private evictTwin(client: AppSocket, room: string): void {
    const me = this.around.identityOf(client);
    if (!me) return;
    for (const id of [...(this.server.sockets.adapter.rooms.get(room) ?? [])]) {
      if (id === client.id) continue;
      const sock = this.server.sockets.sockets.get(id);
      if (!sock || this.around.identityOf(sock) !== me) continue;
      sock.emit('call-over', { room });
      this.leave(sock, { endsCall: false });
    }
  }

  /** Пуста ли комната: id отвалившегося сокета за жильца не считаем. */
  private emptyRoom(room: string): boolean {
    for (const id of this.server.sockets.adapter.rooms.get(room) ?? []) {
      if (this.server.sockets.sockets.has(id)) return false;
    }
    return true;
  }

  // ── Обрыв и возвращение ───────────────────────────────────────────────────

  /**
   * Связь оборвалась. Не выходим из комнат сразу: даём socket.io шанс
   * восстановить сессию (тот же id, те же комнаты). Не вернулся за грейс —
   * тогда уже выходим и уведомляем остальных. Инвариант 2.
   */
  hold(client: AppSocket): void {
    const id = client.id;
    const timer = setTimeout(() => {
      this.pendingLeave.delete(id);
      this.leave(client);
      this.around.onGraceExpired(client);
    }, VoiceSessions.LEAVE_GRACE_MS);
    timer.unref?.();
    this.pendingLeave.set(id, timer);
  }

  /**
   * Сессия восстановлена (тот же id) — отменяем отложенный выход. Эфир и
   * текстовые каналы не трогаем: остальные нас и не «теряли».
   */
  resume(client: AppSocket): void {
    const pending = this.pendingLeave.get(client.id);
    if (!pending) return;
    clearTimeout(pending);
    this.pendingLeave.delete(client.id);
  }

  // ── Пропуск в медиасервер ─────────────────────────────────────────────────

  /** Пропуск выдан: за ним этот сокет пойдёт в медиасервер. */
  grantPass(client: AppSocket, room: string): void {
    client.data.sfuPassRoom = room;
  }

  /**
   * Пропуска нет — и прошлый стереть.
   *
   * Отказ обязан стирать прошлый пропуск, и это не уборка ради порядка: пропуск
   * — единственное, чем сервер догадывается о транспорте клиента, который его
   * не называет. Не сотри мы его, человек, ушедший из sfu-канала в обычный,
   * остался бы помечен «через медиасервер», и весь канал, работающий прекрасно,
   * получил бы красное «тебя не слышат» на пустом месте.
   */
  forgetPass(client: AppSocket): void {
    client.data.sfuPassRoom = undefined;
  }

  // ── Мут и глушилка ────────────────────────────────────────────────────────

  /**
   * Клиент сообщил своё медиасостояние. Возвращает `true`, если мут или
   * глушилка действительно сменились: presence несёт только их, и гнать на
   * весь сервер повтор того же состояния (или камеру с экраном) незачем.
   */
  setMedia(client: AppSocket, micOn: unknown, deafened: unknown): boolean {
    const prevMic = client.data.micOn;
    const prevDeafened = client.data.deafened;
    client.data.micOn = micOn !== false;
    client.data.deafened = deafened === true;
    return client.data.micOn !== prevMic || client.data.deafened !== prevDeafened;
  }

  /** Мут и глушилка этого сокета — как их видит `media-update`. */
  mediaOf(client: AppSocket): { micOn?: boolean; deafened?: boolean } {
    return { micOn: client.data.micOn, deafened: client.data.deafened };
  }

  /**
   * Человек переименовался, и он сидит в эфире: подписи плиток у собеседников
   * рисуются по имени ТОГО сокета, что в комнате. Возвращает `true`, если имя
   * и правда сменилось, — по нему решается, нужна ли рассылка presence.
   */
  rename(sock: AppSocket, name: string): boolean {
    const room = sock.data.room;
    if (!room || sock.data.name === name) return false;
    sock.data.name = name;
    // От имени того сокета, который в комнате и сидит: id в событии — это id
    // плитки, и подставить сюда id переименовавшегося устройства значит
    // переименовать не ту плитку (или ничью).
    sock.to(room).emit('peer-renamed', { id: sock.id, name });
    return true;
  }

  // ── Присутствие ───────────────────────────────────────────────────────────

  /** Кто сейчас в каких голосовых каналах. */
  presence(): Record<string, VoicePresenceEntry[]> {
    const presence: Record<string, VoicePresenceEntry[]> = {};
    for (const [id, sock] of this.server.sockets.sockets) {
      const room = sock.data.room;
      if (!room) continue;
      // Слушателю микрофон выставляем сами: он его и не включал, но клиент
      // прошлой версии по умолчанию считает микрофон включённым, а показать
      // «говорит» тому, кого физически не слышно, — худшее из вранья.
      const listen = this.around.isListener(sock);
      const fingerprint = this.around.fingerprintOf(sock);
      (presence[room] ??= []).push({
        id,
        name: sock.data.name || ANON_NAME,
        ...(fingerprint ? { fingerprint } : {}),
        micOn: !listen && sock.data.micOn !== false,
        deafened: sock.data.deafened === true,
        transport: sock.data.transport === 'sfu' ? 'sfu' : 'p2p',
        ...(this.around.isGuest(sock) ? { guest: true } : {}),
        ...(listen ? { listen: true } : {}),
      });
    }
    return presence;
  }

  /**
   * Присутствие в форме, пригодной этому сокету. Правило белого списка: комната
   * едет к нему, только если за ней стоит видимый ему канал реестра. Слаг канала
   * закрытого сервера — такой же секрет, как и сам канал (по нему заходят: `join`
   * берёт слаг, а не id), а комната, которой в реестре нет вовсе, — вообще не
   * канал: `join` пускает в любой слаг, и рассылка такой строки означала бы, что
   * каждый участник может нарисовать остальным на главном сервере «эфир» с
   * произвольным названием. Своя комната — исключение: в ней человек сидит, и
   * не показать её ему было бы враньём.
   *
   * Гостю едет срез ровно его комнаты: реестра у него нет вовсе, и состав
   * остальных каналов за инвайт утекать не должен.
   */
  presenceFor(
    client: AppSocket,
    presence: Record<string, VoicePresenceEntry[]>,
  ): Record<string, VoicePresenceEntry[]> {
    const guestRoom = this.around.guestRoomOf(client);
    if (guestRoom !== undefined) {
      return guestRoom in presence ? { [guestRoom]: presence[guestRoom] } : {};
    }
    const own = client.data.room ?? null;
    const visible = this.around.visibleVoiceSlugs(client);
    return Object.fromEntries(
      Object.entries(presence).filter(([room]) => room === own || visible.has(room)),
    );
  }

  /** Срез присутствия для одного сокета — собранный прямо сейчас, без дебаунса. */
  snapshotFor(client: AppSocket): Record<string, VoicePresenceEntry[]> {
    return this.presenceFor(client, this.presence());
  }

  /**
   * Разослать присутствие. Коалесцирующий (trailing-edge) дебаунс: таймер уже
   * взведён — ничего не делаем. Рассылка пер-сокетная, потому что срез у
   * каждого свой (см. `presenceFor`).
   */
  broadcast(): void {
    if (this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      const presence = this.presence();
      for (const sock of this.server.sockets.sockets.values()) {
        sock.emit('voice-presence', this.presenceFor(sock, presence));
      }
    }, VoiceSessions.PRESENCE_DEBOUNCE_MS);
    this.presenceTimer.unref?.();
  }
}
