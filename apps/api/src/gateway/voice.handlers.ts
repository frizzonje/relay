import type { Logger } from '@nestjs/common';
import type { AppServer, AppSocket } from './socket-data';
import type { Directory } from './directory';
import type { Perimeter } from './perimeter';
import type { RegistryService } from './registry.service';
import type { SettingsService } from '../settings/settings.service';
import { isCallRoom, type VoiceSessions } from './voice-sessions';
import { sfuHealthy } from '../sfu/sfu-health';
import { issueSfuToken, sfuSecret } from '../sfu/sfu-token';
import {
  LIMIT,
  optional,
  str,
  trimmed,
  type JoinPayload,
  type SfuTokenPayload,
  type SfuTokenResult,
  type SignalPayload,
  type VoiceDiagPayload,
  type VoiceRefusal,
} from './protocol';

// Строка для лога: без переводов строк (чтобы клиент не подделал чужие записи)
// и лишних пробелов.
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Обработчики разговора: пропуск в медиасервер, вход и выход, негоциация,
 * медиасостояние, вехи в лог.
 *
 * Состояния здесь нет вовсе — оно всё в `VoiceSessions`, и это единственная
 * причина, по которой файл вообще можно читать. Обработчик разбирает то, что
 * прислал клиент, спрашивает контур, можно ли, и зовёт ОДИН метод владельца:
 * порядок «выйти → выселить призрака → собрать соседей → войти» не размазан по
 * `join`, он записан в `enter` целиком.
 *
 * Негоциация (`offer`/`answer`/`ice-candidate`) намеренно проходит мимо
 * лимитера: она бывает легитимно бурстовой и релеится один-в-один, дёшево.
 * Заслон у неё другой и он строже — переслать можно только соседу по своей же
 * комнате (см. `relay`).
 */
export class VoiceHandlers {
  constructor(
    private readonly registry: RegistryService,
    private readonly voice: VoiceSessions,
    private readonly perimeter: Perimeter,
    private readonly directory: Directory,
    private readonly settings: SettingsService,
    private readonly serverOf: () => AppServer,
    private readonly logger: Logger,
  ) {}

  private get server(): AppServer {
    return this.serverOf();
  }

  /**
   * Сказать человеку, почему не вышло. Отдельным событием, потому что ни у
   * `join`, ни у `media-update` ответа нет и завести его поздно, — тот же
   * выбор, что у `chat-refused` и `voice-locked`.
   */
  private refuse(client: AppSocket, reason: VoiceRefusal): void {
    client.emit('voice-refused', { reason });
  }

  // Пропуск на namespace /sfu: короткоживущий подписанный токен + адрес
  // медиасервера. Комнату и peerId берём из состояния сокета, а не из запроса —
  // напроситься в чужой канал или назваться чужим id так нельзя. Гость проходит
  // на общих основаниях: он уже «пришит» к своей комнате.
  async sfuToken(client: AppSocket, payload: SfuTokenPayload): Promise<SfuTokenResult> {
    if (!this.perimeter.allow(client)) return { ok: false, error: 'forbidden' };
    // Отказ обязан стирать прошлый пропуск, и это не уборка ради порядка.
    // Пропуск — единственное, чем сервер догадывается о транспорте клиента,
    // который его не называет (бандл прошлой версии). Не сотри мы его, человек,
    // ушедший из sfu-канала в обычный, остался бы в presence помечен как «через
    // медиасервер» — и весь канал, работающий прекрасно, получил бы красное
    // «тебя не слышат» на пустом месте. Пропуск описывает СЛЕДУЮЩИЙ вход, и
    // отказ в нём — такой же ответ, как выдача.
    const forget = () => this.voice.forgetPass(client);
    // Комната приходит в запросе: клиенту нужно знать транспорт ДО `join`,
    // иначе он пропустит ответный `peers`. Секрета в ней нет — войти в любой
    // голосовой канал он и так вправе, а `peerId` по-прежнему берётся из
    // сокета, так что назваться чужим id нельзя.
    const asked = trimmed(payload?.room, LIMIT.room);
    const room = asked || this.voice.roomOf(client) || '';
    if (!room) {
      forget();
      return { ok: false, error: 'not-in-room' };
    }
    // Гость «пришит» к своему каналу — чужую комнату не спросит.
    if (this.perimeter.isGuest(client) && room !== this.perimeter.guestRoom(client)) {
      forget();
      return { ok: false, error: 'forbidden' };
    }
    // Режим канала — не декорация: пропуск выдаём только тем каналам, что
    // помечены sfu. Дефолтные (всегда p2p) отсюда уходят ни с чем.
    // Пропуск — только в видимый канал: закрытый сервер запирает и медиасервер,
    // иначе пароль обходится одним слагом. Гость идёт по своей комнате: реестра
    // у него нет, а к каналу он уже пришит проверкой выше.
    const channel = (
      this.perimeter.isGuest(client) ? this.registry.channels : this.directory.channelsFor(client)
    ).find((c) => c.type === 'voice' && c.slug === room);
    if (!channel || channel.mode !== 'sfu') {
      forget();
      return { ok: false, error: 'not-sfu' };
    }
    // Здоровье медиасервера — ПОСЛЕ режима канала, и порядок здесь и есть
    // протокол. Клиент выбирает транспорт по ответу: `not-sfu` — звонить
    // напрямую, `unavailable` — канал ждёт медиасервер, а тот лежит, и в p2p
    // никто не уезжает (иначе комната разъезжается по транспортам). Спроси мы
    // здоровье раньше, прямой канал при лежащем медиасервере услышал бы «жди
    // сервер» и не позвонил бы никогда.
    //
    // Не настроен вовсе — другое дело: медиасервера у инсталляции нет и не
    // будет, ждать нечего, и её sfu-каналы (дефолтный «SFU общий» есть у всех)
    // звонят напрямую. `unavailable` — только про настроенный, но лежащий.
    const url = (process.env.SFU_URL ?? '').trim();
    if (!url || !sfuSecret()) {
      forget();
      return { ok: false, error: 'not-sfu' };
    }
    // Настроен — не значит жив: пропуск в лежащий медиасервер — это вход,
    // который гарантированно упадёт. Пинг с коротким кэшем, sfu-health.ts.
    if (!(await sfuHealthy())) {
      this.logger.warn(`sfu-token denied (sfu down) for ${client.id}`);
      forget();
      return { ok: false, error: 'unavailable' };
    }
    // Имя берём из запроса: пропуск спрашивают ДО `join`, и имя на сокете
    // в этот момент ещё пусто (заполняется оно только при пере-выдаче во время
    // звонка). Лимит — тот же, что у `join`.
    const askedName = trimmed(payload?.name, LIMIT.tag);
    const name = askedName || this.voice.nameOf(client) || '';
    // Слушателю пропуск выдаём тот же, но с клеймом: медиасервер откажет ему в
    // produce. Клиент у гостя свой — запрет обязан жить там, где течёт медиа.
    const { token, exp } = issueSfuToken({
      room,
      peerId: client.id,
      name,
      listen: this.perimeter.isListener(client),
    });
    // Запоминаем выдачу: клиент, не умеющий сообщать транспорт в `join` (бандл
    // прошлой версии), иначе сошёл бы за p2p — и остальные съехали бы в прямые
    // звонки, разъехавшись с ним по-настоящему. Пропуск — лучшее, что о таком
    // клиенте известно: за ним идут в медиасервер.
    this.voice.grantPass(client, room);
    this.logger.log(`sfu-token issued to ${name || '?'} (${client.id}) room "${room}"`);
    return { ok: true, token, exp, url };
  }

  // Клиентские вехи звонка (выбор транспорта, фолбэк в p2p, обрывы) — в лог
  // сервера. Все эти решения клиент принимает молча у себя, сервер видит лишь
  // их отсутствие — а «телефон в канале, но не слышно» разбирают назавтра по
  // серверному логу, клиентская консоль к тому моменту мертва. Только лог,
  // никакой логики: верить содержимому на слово нельзя.
  diag(client: AppSocket, payload: VoiceDiagPayload) {
    if (!this.perimeter.allowDiag(client)) return;
    const event = oneLine(str(payload?.event)).slice(0, LIMIT.diagEvent);
    if (!event) return;
    const detail = oneLine(str(payload?.detail)).slice(0, LIMIT.diagDetail);
    const name = this.voice.nameOf(client) || '?';
    this.logger.log(`diag ${name} (${client.id}): ${event}${detail ? ` ${detail}` : ''}`);
  }

  join(client: AppSocket, payload: JoinPayload) {
    if (!this.perimeter.allow(client)) return;
    const room = trimmed(payload?.room, LIMIT.room);
    if (!room) return;
    // Гость «пришит» к каналу из своего токена — другие комнаты недоступны.
    if (this.perimeter.isGuest(client) && room !== this.perimeter.guestRoom(client)) return;
    // Выгнанный не возвращается, пока не истечёт пауза (см. handleGuestKick).
    // Проверяем и здесь, а не только в handshake: сокет мог быть открыт до
    // того, как его выгнали, — тогда `join` был бы дверью с другой стороны.
    if (this.perimeter.isGuest(client) && this.perimeter.guestBanned(client, room)) {
      client.emit('kicked', { room });
      return;
    }
    // Комната беседы — единственная, которой в реестре нет и запирать которую
    // есть за что: в разговоре двоих третьему делать нечего, а имя комнаты
    // защитой не является. Спрашиваем ДО замка закрытого сервера и мимо
    // гостевой ветки: гость личности не предъявлял, и «одним из двоих» быть не
    // может, чей бы инвайт ему ни выписали.
    if (!this.voice.mayEnterCallRoom(client, room)) {
      this.logger.warn(`voice: join to call room "${room}" refused for ${client.id}`);
      // Слышно, как и всякий отказ в голосе: молчащий `return` клиент не
      // отличает от удавшегося входа — он считает себя в разговоре, которого
      // для остальных нет (тот же урок, что у `voice-locked` ниже).
      this.refuse(client, 'not-in-call');
      return;
    }
    // Канал закрытого сервера — только для тех, кто ввёл пароль. Комнату, которой
    // в реестре нет вовсе, пропускаем: это либо канал, удалённый под живым
    // разговором, либо инвайт-комната, и запирать их не за что.
    if (!this.perimeter.isGuest(client) && !this.perimeter.mayEnter(client, room)) {
      this.logger.warn(`voice: join to locked room "${room}" refused for ${client.id}`);
      // Отказ обязан быть слышен. Молчащий `return` клиент не отличал от
      // удавшегося входа: он считал себя в канале, для остальных его там не
      // было, и разъезд по транспортам довершал дело — вместо «введи пароль»
      // человек получал тишину без объяснений.
      client.emit('voice-locked', { room });
      return;
    }
    // Имя называет сервер, если сокет — личность; тело сообщения остаётся
    // именем только у гостя по инвайту.
    const name = this.perimeter.nameFor(client, optional(payload?.name, LIMIT.tag));
    // Устройство: сначала handshake (см. `handleConnection`), и только если
    // там пусто — поле payload. Правило целиком — в `claimDevice`.
    const clientId = this.perimeter.claimDevice(client, payload?.clientId);
    // Транспорт называет сам клиент: сервер знает лишь режим канала, а решение
    // принимает клиент — и оно может разойтись с режимом (медиасервер не
    // поднялся у него одного, нативный iOS про SFU вовсе не знает). Клиент
    // прошлой версии поля не пришлёт — за него отвечает выданный пропуск:
    // считать такого p2p нельзя, остальные съехали бы в прямые звонки и
    // разъехались бы с ним уже по-настоящему.
    const transport = this.voice.transportFor(client, payload?.transport, room);

    // Пределы на канал спрашиваем ПЕРЕД входом: `enter` выводит из прошлой
    // комнаты, и отказ после него выкинул бы человека оттуда, где он сидел, —
    // ровно та ошибка, которую в `chat-join` уже разбирали.
    const full = this.tooCrowded(client, room);
    if (full) {
      this.logger.warn(`voice: join to "${room}" refused for ${client.id} (${full})`);
      this.refuse(client, full);
      return;
    }

    // Вход: выход из прошлой комнаты, выселение «призрака» своего же устройства
    // и сбор соседей — всё это один неделимый порядок, и живёт он в VoiceSessions.
    const peers = this.voice.enter(client, { room, name, transport, clientId });

    // Новичку — список тех, кто уже в канале (он шлёт им offer'ы),
    // остальным — уведомление о пополнении
    client.emit('peers', peers);
    client.to(room).emit('peer-joined', {
      id: client.id,
      name,
      ...(this.perimeter.speaker(client)
        ? { fingerprint: this.perimeter.speaker(client)?.fingerprint }
        : {}),
      ...(this.perimeter.isGuest(client) ? { guest: true } : {}),
      ...(this.perimeter.isListener(client) ? { listen: true } : {}),
    });
    this.voice.broadcast();
    // UA — в лог: «телефон не слышит» первым делом упирается в вопрос, ЧТО это
    // за клиент был (мобильный Safari? нативное приложение? старый бандл?).
    const ua = oneLine(String(client.handshake.headers['user-agent'] ?? '')).slice(0, 120);
    this.logger.log(
      `voice: ${name || '?'} (${client.id}${this.perimeter.isGuest(client) ? ', guest' : ''}) joined "${room}" via ${transport} ua="${ua}"`,
    );
    // Разъехались в транспортах — участники друг друга не слышат вообще.
    // Клиенты разберутся сами (мелкая комната съедет в p2p целиком), но в логе
    // это должно быть видно сразу: снаружи такое выглядит как «он в канале, но
    // молчит», и без строчки в логе разбирается только гаданием.
    const split = this.voice.transportsInRoom(room);
    if (split.size > 1) {
      this.logger.warn(
        `voice: room "${room}" is split across transports: ${[...split].join(' + ')}`,
      );
    }
  }
  /**
   * Не полон ли канал для этого сокета. `undefined` — можно заходить.
   *
   * Пределов два и они складываются: общий на канал и отдельный на гостей по
   * ссылке. Гость упирается в оба, свой — только в общий: ограничение на
   * гостей защищает канал от разошедшейся ссылки, а не от собственных людей.
   *
   * Ноль в любом из них — «без предела» (та же договорённость, что у квот на
   * файлы), и это сегодняшнее поведение: до этапа C в голос пускали всех.
   */
  private tooCrowded(client: AppSocket, room: string): VoiceRefusal | undefined {
    // Комната беседы пределов канала не знает: их считают «сколько человек в
    // канале», а разговор двоих каналом не является. Инсталляция, где предел
    // выставлен единицей, иначе впускала бы в принятый вызов одного из двоих —
    // и второй получал бы «канал полон» на звонок, который сам же и принял.
    if (isCallRoom(room)) return undefined;
    if (this.perimeter.isGuest(client)) {
      const guests = this.settings.get<number>('invites.maxGuestsPerChannel');
      if (guests > 0 && this.voice.occupants(room, client, 'guests') >= guests) {
        return 'guests-full';
      }
    }
    const limit = this.settings.get<number>('spaces.maxVoiceOccupants');
    if (limit > 0 && this.voice.occupants(room, client) >= limit) return 'room-full';
    return undefined;
  }

  leave(client: AppSocket) {
    this.voice.leave(client);
  }
  offer(client: AppSocket, payload: SignalPayload) {
    this.relay(client, 'offer', payload?.to, {
      name: this.voice.nameOf(client),
      sdp: payload?.sdp,
    });
  }
  answer(client: AppSocket, payload: SignalPayload) {
    this.relay(client, 'answer', payload?.to, { sdp: payload?.sdp });
  }
  iceCandidate(client: AppSocket, payload: SignalPayload) {
    this.relay(client, 'ice-candidate', payload?.to, { candidate: payload?.candidate });
  }
  mediaUpdate(
    client: AppSocket,
    payload: { camOn?: unknown; screenOn?: unknown; micOn?: unknown; deafened?: unknown },
  ) {
    if (!this.perimeter.allow(client)) return;
    const room = this.voice.roomOf(client);
    if (!room) return;
    // Камера и демонстрация экрана могут быть выключены на всю инсталляцию.
    // Дорожку останавливает клиент — сервер её не видит, — но помечать плитку
    // «с камерой» и молчать было бы худшим из ответов: человек считал бы, что
    // его видно. Поэтому состояние отвергаем и говорим об этом ему одному.
    let camOn = payload?.camOn === true;
    let screenOn = payload?.screenOn === true;
    if (camOn && !this.settings.get<boolean>('voice.videoEnabled')) {
      camOn = false;
      this.refuse(client, 'video-off');
    }
    if (screenOn && !this.settings.get<boolean>('voice.screenShareEnabled')) {
      screenOn = false;
      this.refuse(client, 'screen-share-off');
    }
    // Мут/глушилку запоминает голосовая сессия — их раздаёт voice-presence
    // (индикаторы в сайдбаре видят и те, кто сам не в эфире).
    const changed = this.voice.setMedia(client, payload?.micOn, payload?.deafened);
    client.to(room).emit('media-update', {
      from: client.id,
      camOn,
      screenOn,
      ...this.voice.mediaOf(client),
    });
    // Presence несёт только мут/глушилку — камеру/экран (или повтор того же
    // состояния) не гоним на весь сервер. Рассылаем лишь при реальной их смене.
    if (changed) this.voice.broadcast();
  }

  // Пересылаем сигнал только участнику той же комнаты, что и отправитель
  private relay(client: AppSocket, event: string, to: unknown, data: Record<string, unknown>) {
    if (typeof to !== 'string') return;
    const room = this.voice.roomOf(client);
    if (!room) return;
    const target = this.server.sockets.sockets.get(to);
    if (!target || this.voice.roomOf(target) !== room) return;
    target.emit(event, { from: client.id, ...data });
  }
}
