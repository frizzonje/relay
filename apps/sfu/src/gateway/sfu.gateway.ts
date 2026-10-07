import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import type { types } from 'mediasoup';
import { Server, Socket } from 'socket.io';
import {
  Peer,
  PRODUCER_SOURCES,
  type TransportParams,
  ProducerSource,
  producerInfo,
  RoomsService,
} from '../media/rooms.service';
import { verifySfuToken } from '../token';
import type { SfuAck, SfuRequest, SfuRequests, Untrusted } from '@relay/shared';

/** Медиатипы серверной стороны контракта. */
interface ServerMedia {
  rtpCapabilities: types.RtpCapabilities;
  rtpParameters: types.RtpParameters;
  dtlsParameters: types.DtlsParameters;
  iceParameters: types.IceParameters;
  transportParams: TransportParams;
}

type Requests = SfuRequests<ServerMedia>;
/** Тело запроса — форма из контракта, значения не проверены. */
type Body<E extends SfuRequest> = Untrusted<Requests[E][0]>;
/** Ответ на запрос — ровно то, что ждёт клиент. */
type Reply<E extends SfuRequest> = SfuAck<Requests[E][1]>;

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/**
 * Обрывы, после которых socket.io восстанавливает сессию (тот же список, что у
 * него внутри). Остальные причины — уход по чьей-то воле: клиент закрыл сокет
 * сам или его выгнал сервер, — и ждать такого назад незачем.
 */
const RECOVERABLE = new Set(['transport error', 'transport close', 'forced close', 'ping timeout']);

/**
 * Сигналинг медиасервера — отдельный сокет, рядом с основным сокетом api.
 *
 * Живёт на пути `/sfu/` (а не на дефолтном `/socket.io/`): в проде оба сервиса
 * стоят за одним Caddy на одном origin, и различать их надо именно по пути —
 * namespace socket.io для этого не годится, он передаётся уже внутри соединения
 * и прокси его не видит.
 *
 * Хендшейк стандартный для mediasoup, все запросы с ack-ответом:
 *   connect → `welcome` (capabilities роутера + кто уже в комнате)
 *   `create-transport` → `connect-transport` → `produce` / `consume` / `resume`
 *   (и `pause` — придержать подписку, которую зритель сейчас не видит)
 * плюс серверные `peer-joined` / `new-producer` / `producer-closed` / `peer-left`
 * и `snapshot` — тот же снимок комнаты, что в `welcome`, по запросу.
 *
 * Про авторизацию: sfu не знает ни пароля сайта, ни закрытых серверов, ни
 * гостевых ссылок — он проверяет подпись токена от api и пускает ровно в ту
 * комнату, что указана в клейме (см. token.ts).
 */
@WebSocketGateway({
  path: '/sfu/',
  cors: {
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim()) : '*',
  },
  // Сокет сигналинга рвётся от любой смены сетевого пути, а медиа по UDP
  // переживает такое само. Раньше сессия умирала вместе с сокетом — и моргание
  // сети стоило человеку 13–50 секунд тишины и полного перезахода. Теперь
  // socket.io возвращает тот же id с теми же комнатами и доигрывает пропущенные
  // рассылки, а сессию на это время держим мы (`RESUME_GRACE_MS`).
  connectionStateRecovery: { maxDisconnectionDuration: 20_000 },
  // Тихую смерть сети (без разрыва соединения) сокет узнаёт только по
  // сердцебиению, а после него сессию ещё держим. С умолчаниями socket.io
  // (25 + 20 с) замёрзшая плитка ушедшего висела бы у остальных больше
  // минуты; так обрыв замечается за 20 с, а с удержанием выходит не дольше,
  // чем было до удержания.
  pingInterval: 10_000,
  pingTimeout: 10_000,
})
export class SfuGateway implements OnGatewayConnection {
  private readonly logger = new Logger(SfuGateway.name);
  private readonly peers = new Map<string, Peer>();

  /**
   * Сессии, чей сокет оборвался и ещё может вернуться, — по id сокета. Окно
   * длиннее окна восстановления socket.io: сокет, восстановленный на последней
   * его секунде, должен застать свою сессию.
   */
  static readonly RESUME_GRACE_MS = 25_000;
  private readonly parked = new Map<string, { peer: Peer; timer: ReturnType<typeof setTimeout> }>();

  /**
   * Потолок транспортов на участника. Нужно ему ровно два (send и recv), плюс
   * запас на пересборку: клиент строит новые до того, как сервер закроет старые.
   * Портов транспорты больше не едят (все живут на WebRtcServer воркера), но
   * каждый — это ICE/DTLS-состояние в однопоточном воркере, и цикл
   * переподключений у одного клиента иначе раздувал бы его для всей комнаты.
   * Дорожкам отдельный потолок не нужен: на роль их одна (см. `produce`), а
   * ролей четыре.
   */
  private static readonly MAX_TRANSPORTS_PER_PEER = 6;

  /** Не чаще раза в столько ключевой кадр трансляции экрана (см. `produce`). */
  static readonly SCREEN_KEYFRAME_DELAY_MS = 1000;

  @WebSocketServer()
  server!: Server;

  constructor(private readonly rooms: RoomsService) {}

  async handleConnection(client: Socket): Promise<void> {
    // Свой слушатель, а не `handleDisconnect` Nest: тот не называет причину, а
    // от неё зависит всё — моргание сети держим, уход по своей воле нет. И
    // вешаем ДО первого ожидания: обрыв посреди входа тоже надо увидеть.
    client.on('disconnect', (reason: string) => this.onDisconnect(client, reason));

    if (client.recovered) {
      this.resume(client);
      return;
    }

    const claims = verifySfuToken(client.handshake.auth?.token);
    if (!claims) {
      // Отказ обязан попасть в лог: клиент после него молча уедет в p2p, и
      // «телефон видно, но не слышно» иначе разбирается только гаданием.
      this.logger.warn(`connection rejected: bad or expired token (ua="${shortUa(client)}")`);
      client.emit('sfu-error', { error: 'unauthorized' });
      client.disconnect(true);
      return;
    }
    const { router, peer } = await this.rooms.join(claims.room, {
      id: claims.peerId,
      name: claims.name,
      socketId: client.id,
      room: claims.room,
      listen: claims.listen,
    });
    // Сокет мог оборваться, пока заводилась комната, — тогда его `disconnect`
    // уже прошёл мимо (участника ещё не было), и, не убери мы его здесь, он
    // остался бы в комнате призраком: с плиткой у всех и без единой дорожки.
    if (client.disconnected) {
      this.rooms.leave(peer);
      return;
    }
    this.peers.set(client.id, peer);
    await client.join(roomKey(claims.room));
    if (client.disconnected) return; // его обрыв уже разобрал `onDisconnect`
    // Всё, что нужно клиенту, чтобы стартовать: capabilities для device.load()
    // и снимок комнаты, по которому он подпишется на уже идущие дорожки.
    client.emit('welcome', {
      peerId: peer.id,
      routerRtpCapabilities: router.rtpCapabilities,
      peers: this.rooms.producersFor(peer),
    });
    client.to(roomKey(peer.room)).emit('peer-joined', { peerId: peer.id, name: peer.name });
    this.logger.log(
      `peer ${peer.id} (${peer.name || '?'}) joined "${peer.room}" ua="${shortUa(client)}"`,
    );
  }

  /**
   * Восстановленный сокет — продолжение прежней сессии: тот же id, те же
   * комнаты, пропущенное доиграно. Ни нового `welcome`, ни проверки пропуска:
   * пропуск живёт минуту, а звонок — часы, и подлинность здесь доказывает сама
   * восстановленная сессия (её id знает только тот, кому её выдали).
   */
  private resume(client: Socket): void {
    const parked = this.parked.get(client.id);
    if (!parked || !this.rooms.has(parked.peer)) {
      // Окно вышло или место уже занял его же новый вход. Клиент сдастся и
      // войдёт заново — с новым пропуском и с нуля.
      client.emit('sfu-error', { error: 'session-lost' });
      client.disconnect(true);
      return;
    }
    clearTimeout(parked.timer);
    this.parked.delete(client.id);
    this.peers.set(client.id, parked.peer);
    this.logger.log(`peer ${parked.peer.id} resumed in "${parked.peer.room}"`);
  }

  private onDisconnect(client: Socket, reason: string): void {
    const peer = this.peers.get(client.id);
    if (!peer) return;
    this.peers.delete(client.id);
    if (!RECOVERABLE.has(reason)) {
      this.release(peer);
      return;
    }
    // Транспорты и дорожки не трогаем: медиа, скорее всего, идёт и сейчас.
    // Остальным тоже ничего не говорим — для них никто никуда не уходил.
    const timer = setTimeout(() => {
      this.parked.delete(client.id);
      this.release(peer);
    }, SfuGateway.RESUME_GRACE_MS);
    timer.unref?.();
    this.parked.set(client.id, { peer, timer });
    this.logger.log(`peer ${peer.id} lost signaling (${reason}) in "${peer.room}", holding`);
  }

  /** Участник ушёл насовсем: снять его и сказать комнате. */
  private release(peer: Peer): void {
    // Ушёл ли он на самом деле. Быстрый перезаход (прыжки по каналам, круг
    // ожидания вернувшегося сервера) открывает НОВЫЙ сокет под тем же peerId —
    // id участника это id его сокета в api, а тот при смене канала не меняется.
    // Сокеты разные, и очерёдность их событий ничем не связана: `disconnect`
    // прежнего запросто приходит уже после `welcome` нового. Сказать в этот
    // момент комнате `peer-left` — значит снять у всех остальных плитку и
    // consumer'ы ЖИВОГО участника, причём насовсем: второго `peer-joined` не
    // будет, а сам он о своей пропаже не узнает и переспрашивать не станет.
    if (!this.rooms.leave(peer)) {
      // За комнатой он уже не числится: либо вернулся новым сокетом и занял своё
      // место, либо комната успела закрыться. Сообщать об уходе некому и нечего.
      this.logger.log(`peer ${peer.id} disconnected in "${peer.room}" (already out of the room)`);
      return;
    }
    this.server.to(roomKey(peer.room)).emit('peer-left', { peerId: peer.id });
    this.logger.log(`peer ${peer.id} left "${peer.room}"`);
  }

  @SubscribeMessage('create-transport')
  async handleCreateTransport(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: Body<'create-transport'>,
  ): Promise<Reply<'create-transport'>> {
    const peer = this.peers.get(client.id);
    if (!peer) return fail('no-peer');
    if (peer.transports.size >= SfuGateway.MAX_TRANSPORTS_PER_PEER) {
      this.logger.warn(`create-transport refused for ${peer.id}: ${peer.transports.size} already`);
      return fail('too-many-transports');
    }
    const direction = payload?.direction === 'recv' ? 'recv' : 'send';
    try {
      const { transport, params } = await this.rooms.createTransport(peer);
      // Сверяемся и после ожидания: запросы, пришедшие разом, все прошли
      // проверку выше, пока первый транспорт ещё заводился.
      if (peer.transports.size > SfuGateway.MAX_TRANSPORTS_PER_PEER) {
        transport.close();
        return fail('too-many-transports');
      }
      return { ok: true, params, direction };
    } catch (err) {
      this.logger.warn(`create-transport failed for ${peer.id}: ${String(err)}`);
      return fail('transport-failed');
    }
  }

  @SubscribeMessage('connect-transport')
  async handleConnectTransport(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: Body<'connect-transport'>,
  ): Promise<Reply<'connect-transport'>> {
    const peer = this.peers.get(client.id);
    if (!peer) return fail('no-peer');
    const transport = this.transportOf(peer, payload?.transportId);
    if (!transport) return fail('no-transport');
    try {
      await transport.connect({ dtlsParameters: payload?.dtlsParameters as types.DtlsParameters });
      return { ok: true };
    } catch (err) {
      this.logger.warn(`connect-transport failed for ${peer.id}: ${String(err)}`);
      return fail('connect-failed');
    }
  }

  /**
   * Первая ступень восстановления связи: сетевой путь сменился (wifi → LTE,
   * NAT перевыдал порт) — ICE переизбирается на том же транспорте, дорожки и
   * consumer'ы остаются жить. Дороже этого только пересборка транспорта, её
   * клиент делает сам, уже без нашей помощи.
   */
  @SubscribeMessage('restart-ice')
  async handleRestartIce(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: Body<'restart-ice'>,
  ): Promise<Reply<'restart-ice'>> {
    const peer = this.peers.get(client.id);
    if (!peer) return fail('no-peer');
    const transport = this.transportOf(peer, payload?.transportId);
    if (!transport) return fail('no-transport');
    try {
      const iceParameters = await transport.restartIce();
      return { ok: true, iceParameters };
    } catch (err) {
      this.logger.warn(`restart-ice failed for ${peer.id}: ${String(err)}`);
      return fail('restart-failed');
    }
  }

  /**
   * Вторая ступень восстановления: клиент выбрасывает транспорт целиком и
   * строит новый. Старый надо закрыть и на нашей стороне — иначе он висит до
   * дисконнекта, а остальные продолжают слушать мёртвые дорожки. Закрытие
   * транспорта само уносит его producer'ов, а чужие consumer'ы получают
   * `producerclose` и штатное `producer-closed`.
   */
  @SubscribeMessage('close-transport')
  handleCloseTransport(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: Body<'close-transport'>,
  ): Reply<'close-transport'> {
    const peer = this.peers.get(client.id);
    if (!peer) return fail('no-peer');
    const transport = this.transportOf(peer, payload?.transportId);
    if (!transport) return fail('no-transport');
    transport.close();
    return { ok: true };
  }

  @SubscribeMessage('produce')
  async handleProduce(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: Body<'produce'>,
  ): Promise<Reply<'produce'>> {
    const peer = this.peers.get(client.id);
    if (!peer) return fail('no-peer');
    // Слушатель отдавать не вправе — и это единственное место, где такой запрет
    // вообще что-то стоит: клиент у него свой, и «не показывать кнопку» ничего
    // не запирает. Комнату он при этом слушает как все.
    if (peer.listen) {
      this.logger.warn(`produce refused for ${peer.id}: listen-only pass`);
      return fail('listen-only');
    }
    const transport = this.transportOf(peer, payload?.transportId);
    if (!transport) return fail('no-transport');
    const kind = payload?.kind === 'video' ? 'video' : payload?.kind === 'audio' ? 'audio' : null;
    if (!kind) return fail('bad-kind');
    const source = PRODUCER_SOURCES.includes(payload?.source as ProducerSource)
      ? (payload.source as ProducerSource)
      : null;
    if (!source) return fail('bad-source');
    try {
      const producer = await transport.produce({
        kind,
        rtpParameters: payload?.rtpParameters as types.RtpParameters,
        appData: { source, peerId: peer.id },
        // Ключевой кадр трансляции — сотни килобайт. Просит его каждый зритель
        // с потерями и каждый, кто только что нажал «Смотреть», и без выдержки
        // их просьбы складывались в очередь жирных кадров для всех сразу —
        // всплеск, после которого теряют пакеты уже все. Раз в секунду хватает:
        // новый зритель ждёт первого кадра не дольше неё.
        ...(source === 'screen'
          ? { keyFrameRequestDelay: SfuGateway.SCREEN_KEYFRAME_DELAY_MS }
          : {}),
      });
      // На роль — одна дорожка: клиент держит по producer'у на роль, и второй
      // той же роли значит, что ответ на прошлый до него не дошёл (сокет
      // моргнул посреди `produce`). Прежний остался бы у нас сиротой без RTP —
      // у остальных чёрной плиткой или немым микрофоном. Новый его заменяет.
      // Сверяемся уже после ожидания: два встречных `produce` иначе оба
      // проскочили бы проверку.
      for (const old of [...peer.producers.values()]) {
        if (producerInfo(old).source === source) this.dropProducer(client, peer, old);
      }
      peer.producers.set(producer.id, producer);
      producer.on('transportclose', () => peer.producers.delete(producer.id));
      client
        .to(roomKey(peer.room))
        .emit('new-producer', { peerId: peer.id, producer: producerInfo(producer) });
      return { ok: true, id: producer.id };
    } catch (err) {
      this.logger.warn(`produce failed for ${peer.id}: ${String(err)}`);
      return fail('produce-failed');
    }
  }

  @SubscribeMessage('close-producer')
  handleCloseProducer(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: Body<'close-producer'>,
  ): Reply<'close-producer'> {
    const peer = this.peers.get(client.id);
    if (!peer) return fail('no-peer');
    const id = typeof payload?.producerId === 'string' ? payload.producerId : '';
    const producer = peer.producers.get(id);
    if (!producer) return fail('no-producer');
    this.dropProducer(client, peer, producer);
    return { ok: true };
  }

  private dropProducer(client: Socket, peer: Peer, producer: types.Producer): void {
    producer.close();
    peer.producers.delete(producer.id);
    // Своих consumer'ов остальные закроют сами по этому событию — mediasoup
    // закрывает их на той стороне, но клиенту нужно снять плитку/дорожку.
    client
      .to(roomKey(peer.room))
      .emit('producer-closed', { peerId: peer.id, producerId: producer.id });
  }

  /**
   * Снимок комнаты, как в `welcome`. Нужен вернувшейся после обрыва сессии:
   * события за обрыв socket.io доиграл, а ответы на запросы, бывшие в полёте,
   * пропали — клиент сверяет по снимку, на что он так и не подписался.
   */
  @SubscribeMessage('snapshot')
  handleSnapshot(@ConnectedSocket() client: Socket): Reply<'snapshot'> {
    const peer = this.peers.get(client.id);
    if (!peer) return fail('no-peer');
    return { ok: true, peers: this.rooms.producersFor(peer) };
  }

  @SubscribeMessage('consume')
  async handleConsume(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: Body<'consume'>,
  ): Promise<Reply<'consume'>> {
    const peer = this.peers.get(client.id);
    if (!peer) return fail('no-peer');
    const router = this.rooms.router(peer.room);
    const transport = this.transportOf(peer, payload?.transportId);
    if (!router || !transport) return fail('no-transport');
    const producerId = typeof payload?.producerId === 'string' ? payload.producerId : '';
    const rtpCapabilities = (payload?.rtpCapabilities ?? peer.rtpCapabilities) as
      | types.RtpCapabilities
      | undefined;
    if (!producerId || !rtpCapabilities) return fail('bad-request');
    peer.rtpCapabilities = rtpCapabilities;
    const owner = this.rooms.peers(peer.room).find((p) => p.producers.has(producerId));
    if (!owner) return fail('no-producer');
    const producer = owner.producers.get(producerId)!;
    // Единственный отказ, который раньше уходил молча. А молчит он ровно в том
    // случае, который снаружи выглядит как «дорожка есть, но её никто не видит»:
    // дорожка доехала до сервера, а подписаться на неё некому. Называем обе
    // стороны несовпадения — кодек producer'а и то, что умеет приёмник.
    if (!router.canConsume({ producerId, rtpCapabilities })) {
      const wanted = producer.rtpParameters.codecs.map((c) => c.mimeType).join(',');
      const has = rtpCapabilities.codecs
        ?.filter((c) => c.kind === producer.kind)
        .map((c) => c.mimeType)
        .join(',');
      this.logger.warn(
        `cannot-consume: ${peer.id} → ${owner.id} ${producerInfo(producer).source} ` +
          `producer=[${wanted}] consumer=[${has}]`,
      );
      return fail('cannot-consume');
    }
    try {
      // paused: true — обязательный шаг протокола: клиент создаёт consumer,
      // подключает трек и только потом шлёт `resume`. Иначе первые пакеты
      // приходят в ещё не готовый элемент и дают чёрный кадр / щелчок.
      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: true,
      });
      peer.consumers.set(consumer.id, consumer);
      consumer.on('transportclose', () => peer.consumers.delete(consumer.id));
      // Какой слой simulcast реально доехал. Клиент просит слой сам
      // (`preferred-layers`), но получает то, что решил сервер по битрейту —
      // в тултипе качества честнее показывать факт, а не заявку.
      // Слать — сессии (комнате её id), а не объекту сокета: сокет мог
      // смениться восстановленным, и событие ушло бы в мёртвый. Рассылку же
      // socket.io ещё и доиграет, если она пришлась на сам обрыв.
      consumer.on('layerschange', (layers) => {
        this.server.to(client.id).emit('consumer-layers', {
          consumerId: consumer.id,
          spatialLayer: layers?.spatialLayer ?? null,
          temporalLayer: layers?.temporalLayer ?? null,
        });
      });
      consumer.on('producerclose', () => {
        peer.consumers.delete(consumer.id);
        this.server.to(client.id).emit('producer-closed', { peerId: owner.id, producerId });
      });
      const source = producerInfo(producer).source;
      // Вторая половина пары к строчке `produce`: она говорит, что дорожка
      // доехала до сервера, эта — что на неё кто-то подписался. Без неё разрыв
      // «producer есть, картинки нет» неотличим от «никто не подписывался».
      this.logger.log(
        `peer ${peer.id} consumes ${source} (${consumer.kind}/${consumer.rtpParameters.codecs[0]?.mimeType ?? '?'}) from ${owner.id}`,
      );
      return {
        ok: true,
        consumer: {
          id: consumer.id,
          producerId,
          peerId: owner.id,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          source,
        },
      };
    } catch (err) {
      this.logger.warn(`consume failed for ${peer.id}: ${String(err)}`);
      return fail('consume-failed');
    }
  }

  @SubscribeMessage('resume')
  async handleResume(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: Body<'resume'>,
  ): Promise<Reply<'resume'>> {
    const peer = this.peers.get(client.id);
    if (!peer) return fail('no-peer');
    const id = typeof payload?.consumerId === 'string' ? payload.consumerId : '';
    const consumer = peer.consumers.get(id);
    if (!consumer) return fail('no-consumer');
    // Исключение Nest в ack не превращает: клиент ждал бы ответа свои 10 с, а
    // вход подписывается на соседей по одному — вставала бы вся очередь.
    // Срывается resume, когда дорожку закрыли между `consume` и ним.
    try {
      await consumer.resume();
      return { ok: true };
    } catch (err) {
      this.logger.warn(`resume failed for ${peer.id}: ${String(err)}`);
      return fail('resume-failed');
    }
  }

  /**
   * Перестать слать подписчику дорожку, не закрывая подписку. Так зритель
   * трансляции, свернувший её плитку (развернул другую), не тянет с сервера
   * поток, которого не видит, а вернувшись — получает его обратно за ключевой
   * кадр, без новой подписки. Обратный ход — тот же `resume`.
   */
  @SubscribeMessage('pause')
  async handlePause(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: Body<'pause'>,
  ): Promise<Reply<'pause'>> {
    const peer = this.peers.get(client.id);
    if (!peer) return fail('no-peer');
    const id = typeof payload?.consumerId === 'string' ? payload.consumerId : '';
    const consumer = peer.consumers.get(id);
    if (!consumer) return fail('no-consumer');
    try {
      await consumer.pause();
      return { ok: true };
    } catch (err) {
      this.logger.warn(`pause failed for ${peer.id}: ${String(err)}`);
      return fail('pause-failed');
    }
  }

  /**
   * Снять подписку по просьбе зрителя («Перестать смотреть»). Закрыть consumer
   * только у себя клиенту мало: mediasoup-client серверу об этом не говорит, и
   * сервер слал бы поток дальше — в транспорт, где его уже никто не принимает.
   * Каждое «Смотреть» после этого добавляло бы ещё один такой поток.
   */
  @SubscribeMessage('close-consumer')
  handleCloseConsumer(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: Body<'close-consumer'>,
  ): Reply<'close-consumer'> {
    const peer = this.peers.get(client.id);
    if (!peer) return fail('no-peer');
    const id = typeof payload?.consumerId === 'string' ? payload.consumerId : '';
    const consumer = peer.consumers.get(id);
    if (!consumer) return fail('no-consumer');
    consumer.close();
    peer.consumers.delete(id);
    return { ok: true };
  }

  /**
   * Adaptive subscription: крупной плитке — верхний слой simulcast, мелкой
   * нижний. Ради этого simulcast и включается (шаг D плана).
   */
  @SubscribeMessage('preferred-layers')
  async handlePreferredLayers(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: Body<'preferred-layers'>,
  ): Promise<Reply<'preferred-layers'>> {
    const peer = this.peers.get(client.id);
    if (!peer) return fail('no-peer');
    const id = typeof payload?.consumerId === 'string' ? payload.consumerId : '';
    const consumer = peer.consumers.get(id);
    if (!consumer || consumer.kind !== 'video') return fail('no-consumer');
    const spatialLayer = Number(payload?.spatialLayer);
    if (!Number.isInteger(spatialLayer) || spatialLayer < 0) return fail('bad-layer');
    const temporalLayer = Number(payload?.temporalLayer);
    try {
      await consumer.setPreferredLayers({
        spatialLayer,
        ...(Number.isInteger(temporalLayer) && temporalLayer >= 0 ? { temporalLayer } : {}),
      });
      return { ok: true };
    } catch (err) {
      this.logger.warn(`preferred-layers failed for ${peer.id}: ${String(err)}`);
      return fail('layers-failed');
    }
  }

  private transportOf(peer: Peer, id: unknown): types.WebRtcTransport | undefined {
    return typeof id === 'string' ? peer.transports.get(id) : undefined;
  }
}

/** Комната socket.io под медиа — с префиксом, чтобы не пересечься с чем-либо ещё. */
function roomKey(room: string): string {
  return `sfu:${room}`;
}

/** UA для лога: без переводов строк (лог не подделать) и без хвоста в километр. */
function shortUa(client: Socket): string {
  return String(client.handshake.headers['user-agent'] ?? '')
    .replace(/\s+/g, ' ')
    .slice(0, 120);
}
