import type { Logger } from '@nestjs/common';
import type { AppSocket } from './socket-data';
import type { ChatSessions } from './chat-sessions';
import type { IdentityService } from '../identity/identity.service';
import type { Mentions } from './mentions';
import type { Perimeter } from './perimeter';
import type { PrefsService } from '../identity/prefs.service';
import type { ReadsService } from '../identity/reads.service';
import type { RegistryService } from './registry.service';
import type { VoiceSessions } from './voice-sessions';
import { LIMIT, trimmed, type PrefsSetPayload, type ReadMarkPayload } from './protocol';

/**
 * То, что принадлежит человеку, а не браузеру: докуда он дочитал, как настроил
 * себе приложение и как его зовут.
 *
 * Признак, по которому эти три события собраны вместе, один и тот же во всех
 * трёх: **у них адресат — личность, а не сокет**. Прочитано на десктопе —
 * прочитано и в телефоне; переименовался с телефона — сменилась подпись в
 * канале, где сидит десктоп. Поэтому все три заканчиваются обходом ВСЕХ
 * сокетов этой личности, и поэтому же ни один из них ничего не делает без неё:
 * у гостя по инвайту и у браузера, не осилившего ключ, общего между
 * устройствами нет, и их непрочитанное остаётся в localStorage, как и было.
 */
export class PersonalHandlers {
  constructor(
    private readonly registry: RegistryService,
    private readonly chats: ChatSessions,
    private readonly voice: VoiceSessions,
    private readonly identities: IdentityService,
    private readonly reads: ReadsService,
    private readonly prefs: PrefsService,
    private readonly perimeter: Perimeter,
    private readonly mentions: Mentions,
    private readonly logger: Logger,
  ) {}

  /**
   * Отдать сокету то, что принадлежит человеку, а не браузеру: докуда дочитаны
   * каналы и его настройки.
   *
   * Без личности не шлём ничего — и это не забывчивость. У гостя по инвайту и у
   * браузера, который не смог родить ключ, личности нет, а значит нет и общего
   * между устройствами: их непрочитанное остаётся в localStorage, как и было.
   */
  async send(client: AppSocket): Promise<void> {
    const me = this.perimeter.speaker(client);
    if (!me) return;
    try {
      const [marks, values] = await Promise.all([
        this.reads.marks(me.id),
        this.prefs.values(me.id),
      ]);
      // `full` — «это весь список». По нему клиент понимает, что может отдать
      // серверу то, что прочитал и настроил без личности, а не только принять.
      client.emit('reads', { marks: this.marksBySlug(marks), full: true });
      client.emit('prefs', { values, full: true });
      // Упоминания — после отметок чтения и не случайно: счётчик считается
      // «сколько раз назвали после того, как канал дочитан», и клиенту он
      // приезжает уже посчитанным, поверх известных ему отметок.
      await this.mentions.sendSnapshot(client);
    } catch (e) {
      // Личное — не то, без чего приложение не работает: без отметок канал
      // просто выглядит непрочитанным. Падать на этом (и уж тем более рвать
      // подключение) хуже, чем показать точку лишний раз.
      this.logger.error(`не удалось отдать личное состояние: ${e}`);
    }
  }

  /**
   * Отметки чтения так, как их зовёт клиент: по слагам. Хранятся они по id
   * канала — переименование не должно зажигать «непрочитано» у всех разом, — а
   * в протоколе канал всю жизнь звался слагом, и заводить ради этого второе имя
   * канала на проводе незачем. Каналы, которых уже нет, отпадают сами.
   */
  private marksBySlug(marks: Map<string, number>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const channel of this.registry.channels) {
      const ts = marks.get(channel.id);
      if (ts) out[channel.slug] = ts;
    }
    return out;
  }


  /**
   * «Этот канал дочитан до этого момента».
   *
   * Отметка растёт и только растёт (см. `reads.service`), поэтому опоздавшее
   * сообщение с устройства, которое проснулось со старым снимком, ничего не
   * ломает: оно просто не делает ничего. Ответа клиент не ждёт — у него уже
   * погашена точка, и переспрашивать сервер, засчитал ли он прочтение, значило
   * бы держать индикатор в зависимости от сети.
   */
  async readMark(
    client: AppSocket,
    payload: ReadMarkPayload,
  ): Promise<void> {
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return;
    const me = this.perimeter.speaker(client);
    if (!me) return;
    const slug = trimmed(payload?.slug, LIMIT.slug);
    const ts = typeof payload?.ts === 'number' ? payload.ts : 0;
    const channel = this.registry.channels.find((c) => c.type === 'text' && c.slug === slug);
    // Канал, которого этот сокет не видит, ему и не дочитать: иначе отметки
    // становятся способом перебирать слаги закрытых серверов.
    if (!channel || !this.perimeter.canSee(client, channel)) return;
    const mark = await this.reads.mark(me.id, channel.id, ts);
    if (mark === null) return;
    // Прочитано на десктопе — прочитано и в браузере, прямо сейчас. Это и есть
    // весь смысл переезда: догонять его перезагрузкой страницы было бы почти
    // тем же самым, что и не переезжать.
    this.tellOtherDevices(client, me.id, 'reads', { marks: { [slug]: mark } });
  }

  /**
   * Настройка человека. Что можно писать — решает `prefs.service`, здесь только
   * доставка: отказ (чужой ключ, слишком большое значение) остаётся молчанием.
   * Клиент шлёт лишь то, что сам же и понимает, а живого человека за неверным
   * ключом нет — объяснять некому.
   */
  async setPref(
    client: AppSocket,
    payload: PrefsSetPayload,
  ): Promise<void> {
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return;
    const me = this.perimeter.speaker(client);
    if (!me) return;
    const key = payload?.key;
    if (!(await this.prefs.set(me.id, key, payload?.value))) return;
    this.tellOtherDevices(client, me.id, 'prefs', { values: { [key as string]: payload?.value } });
  }

  /** Остальным устройствам того же человека — но не тому, кто это и сделал. */
  private tellOtherDevices(client: AppSocket, identityId: string, event: string, data: unknown): void {
    for (const sock of this.perimeter.socketsOf(identityId)) {
      if (sock.id !== client.id) sock.emit(event, data);
    }
  }

  /**
   * Человек переименовался. От личности это не «зовите меня так», а «сходите
   * перечитайте»: имя меняется обычным HTTP (`POST /api/identity/nick`), сокет
   * узнаёт о смене последним и берёт новое имя из базы, а не из тела события.
   * Иначе одним `rename` можно было бы назваться кем угодно посреди разговора —
   * и лицо рядом с ником перестало бы что-либо значить.
   */
  async rename(
    client: AppSocket,
    payload: { name?: unknown },
  ) {
    if (!this.perimeter.allow(client)) return;
    const speaker = this.perimeter.speaker(client);
    const name = speaker
      ? ((await this.identities.nickOf(speaker.id)) ?? speaker.nick)
      : trimmed(payload?.name, LIMIT.tag);
    if (!name) return;

    // Имя принадлежит личности, а не сокету, — значит и менять его надо у всех
    // сокетов этой личности. Иначе человек, переименовавшийся с телефона,
    // остаётся прежним для комнаты, в которой сидит его же десктоп: подписи
    // плиток, ростер и presence там нарисованы по данным ТОГО сокета, а он о
    // смене не узнаёт до перезахода. У того, кто вошёл без ключа, устройство
    // ровно одно — им и ограничиваемся.
    const targets = speaker ? this.perimeter.socketsOf(speaker.id) : [client];
    const rosters = new Set<string>();
    let presence = false;

    for (const sock of targets) {
      const own = this.perimeter.speaker(sock);
      if (own) own.nick = name;

      if (this.voice.rename(sock, name)) presence = true;

      const staleRoster = this.chats.rename(sock, name);
      if (staleRoster) rosters.add(staleRoster);

      // Самому устройству-инициатору говорить нечего: оно и так знает.
      if (sock.id !== client.id) sock.emit('renamed', { name });
    }

    for (const room of rosters) this.chats.emitRoster(room);
    if (presence) this.voice.broadcast();
  }

}
