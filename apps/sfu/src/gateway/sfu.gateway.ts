import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
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
  ProducerSource,
  producerInfo,
  RoomsService,
} from '../media/rooms.service';
import { verifySfuToken } from '../token';

type Ack<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

interface CreateTransportPayload {
  direction?: unknown;
}
interface ConnectTransportPayload {
  transportId?: unknown;
  dtlsParameters?: unknown;
}
interface ProducePayload {
  transportId?: unknown;
  kind?: unknown;
  rtpParameters?: unknown;
  source?: unknown;
}
interface ProducerPayload {
  producerId?: unknown;
}
interface RestartIcePayload {
  transportId?: unknown;
}
interface ConsumePayload {
  transportId?: unknown;
  producerId?: unknown;
  rtpCapabilities?: unknown;
}
interface ConsumerPayload {
  consumerId?: unknown;
}
interface LayersPayload {
  consumerId?: unknown;
  spatialLayer?: unknown;
  temporalLayer?: unknown;
}

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
 * плюс серверные `peer-joined` / `new-producer` / `producer-closed` / `peer-left`.
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
})
export class SfuGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(SfuGateway.name);
  private readonly peers = new Map<string, Peer>();

  @WebSocketServer()
  server!: Server;

  constructor(private readonly rooms: RoomsService) {}

  async handleConnection(client: Socket): Promise<void> {
    const claims = verifySfuToken(client.handshake.auth?.token);
    if (!claims) {
      client.emit('sfu-error', { error: 'unauthorized' });
      client.disconnect(true);
      return;
    }
    const { router, peer } = await this.rooms.join(claims.room, {
      id: claims.peerId,
      name: claims.name,
      socketId: client.id,
      room: claims.room,
    });
    this.peers.set(client.id, peer);
    await client.join(roomKey(claims.room));
    // Всё, что нужно клиенту, чтобы стартовать: capabilities для device.load()
    // и снимок комнаты, по которому он подпишется на уже идущие дорожки.
    client.emit('welcome', {
      peerId: peer.id,
      routerRtpCapabilities: router.rtpCapabilities,
      peers: this.rooms.producersFor(peer),
    });
    client.to(roomKey(peer.room)).emit('peer-joined', { peerId: peer.id, name: peer.name });
    this.logger.log(`peer ${peer.id} joined "${peer.room}"`);
  }

  handleDisconnect(client: Socket): void {
    const peer = this.peers.get(client.id);
    if (!peer) return;
    this.peers.delete(client.id);
    this.rooms.leave(peer);
    client.to(roomKey(peer.room)).emit('peer-left', { peerId: peer.id });
    this.logger.log(`peer ${peer.id} left "${peer.room}"`);
  }

  @SubscribeMessage('create-transport')
  async handleCreateTransport(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: CreateTransportPayload,
  ): Promise<Ack<{ params: unknown; direction: 'send' | 'recv' }>> {
    const peer = this.peers.get(client.id);
    if (!peer) return fail('no-peer');
    const direction = payload?.direction === 'recv' ? 'recv' : 'send';
    try {
      const { params } = await this.rooms.createTransport(peer);
      return { ok: true, params, direction };
    } catch (err) {
      this.logger.warn(`create-transport failed for ${peer.id}: ${String(err)}`);
      return fail('transport-failed');
    }
  }

  @SubscribeMessage('connect-transport')
  async handleConnectTransport(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: ConnectTransportPayload,
  ): Promise<Ack> {
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
    @MessageBody() payload: RestartIcePayload,
  ): Promise<Ack<{ iceParameters: types.IceParameters }>> {
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
    @MessageBody() payload: RestartIcePayload,
  ): Ack {
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
    @MessageBody() payload: ProducePayload,
  ): Promise<Ack<{ id: string }>> {
    const peer = this.peers.get(client.id);
    if (!peer) return fail('no-peer');
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
      });
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
    @MessageBody() payload: ProducerPayload,
  ): Ack {
    const peer = this.peers.get(client.id);
    if (!peer) return fail('no-peer');
    const id = typeof payload?.producerId === 'string' ? payload.producerId : '';
    const producer = peer.producers.get(id);
    if (!producer) return fail('no-producer');
    producer.close();
    peer.producers.delete(id);
    // Своих consumer'ов остальные закроют сами по этому событию — mediasoup
    // закрывает их на той стороне, но клиенту нужно снять плитку/дорожку.
    client.to(roomKey(peer.room)).emit('producer-closed', { peerId: peer.id, producerId: id });
    return { ok: true };
  }

  @SubscribeMessage('consume')
  async handleConsume(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: ConsumePayload,
  ): Promise<Ack<{ consumer: unknown }>> {
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
    if (!router.canConsume({ producerId, rtpCapabilities })) return fail('cannot-consume');
    const owner = this.rooms.peers(peer.room).find((p) => p.producers.has(producerId));
    if (!owner) return fail('no-producer');
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
      consumer.on('layerschange', (layers) => {
        client.emit('consumer-layers', {
          consumerId: consumer.id,
          spatialLayer: layers?.spatialLayer ?? null,
          temporalLayer: layers?.temporalLayer ?? null,
        });
      });
      consumer.on('producerclose', () => {
        peer.consumers.delete(consumer.id);
        client.emit('producer-closed', { peerId: owner.id, producerId });
      });
      return {
        ok: true,
        consumer: {
          id: consumer.id,
          producerId,
          peerId: owner.id,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          source: producerInfo(owner.producers.get(producerId)!).source,
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
    @MessageBody() payload: ConsumerPayload,
  ): Promise<Ack> {
    const peer = this.peers.get(client.id);
    if (!peer) return fail('no-peer');
    const id = typeof payload?.consumerId === 'string' ? payload.consumerId : '';
    const consumer = peer.consumers.get(id);
    if (!consumer) return fail('no-consumer');
    await consumer.resume();
    return { ok: true };
  }

  /**
   * Adaptive subscription: крупной плитке — верхний слой simulcast, мелкой
   * нижний. Ради этого simulcast и включается (шаг D плана).
   */
  @SubscribeMessage('preferred-layers')
  async handlePreferredLayers(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: LayersPayload,
  ): Promise<Ack> {
    const peer = this.peers.get(client.id);
    if (!peer) return fail('no-peer');
    const id = typeof payload?.consumerId === 'string' ? payload.consumerId : '';
    const consumer = peer.consumers.get(id);
    if (!consumer || consumer.kind !== 'video') return fail('no-consumer');
    const spatialLayer = Number(payload?.spatialLayer);
    if (!Number.isInteger(spatialLayer) || spatialLayer < 0) return fail('bad-layer');
    const temporalLayer = Number(payload?.temporalLayer);
    await consumer.setPreferredLayers({
      spatialLayer,
      ...(Number.isInteger(temporalLayer) && temporalLayer >= 0 ? { temporalLayer } : {}),
    });
    return { ok: true };
  }

  private transportOf(peer: Peer, id: unknown): types.WebRtcTransport | undefined {
    return typeof id === 'string' ? peer.transports.get(id) : undefined;
  }
}

/** Комната socket.io под медиа — с префиксом, чтобы не пересечься с чем-либо ещё. */
function roomKey(room: string): string {
  return `sfu:${room}`;
}
