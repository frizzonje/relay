import { Injectable, Logger } from '@nestjs/common';
import type { types } from 'mediasoup';
import { MEDIA_CODECS, webRtcTransportOptions } from './media.config';
import { WorkersService } from './workers.service';

/**
 * Назначение дорожки. Клиент присылает его в appData при `produce`, сервер
 * пересылает остальным вместе с producerId — по нему дирижёр решает, куда
 * приткнуть входящий трек: микрофон в микшер, камера/экран в плитку.
 */
export type ProducerSource = 'mic' | 'cam' | 'screen' | 'screen-audio';

export const PRODUCER_SOURCES: ProducerSource[] = ['mic', 'cam', 'screen', 'screen-audio'];

export interface Peer {
  /** Совпадает с id участника в основном сигналинге — плитки общие. */
  id: string;
  name: string;
  socketId: string;
  room: string;
  rtpCapabilities?: types.RtpCapabilities;
  transports: Map<string, types.WebRtcTransport>;
  producers: Map<string, types.Producer>;
  consumers: Map<string, types.Consumer>;
}

interface Room {
  id: string;
  router: types.Router;
  peers: Map<string, Peer>;
}

/**
 * Комнаты и их роутеры. Роутер — это «коммутатор» одной комнаты: producer'ы
 * (кто что шлёт) и consumer'ы (кто что слушает) живут внутри него, поэтому
 * комната = роутер, ни больше ни меньше. Пустая комната закрывается сразу:
 * висящий роутер держит память воркера ни за чем.
 */
@Injectable()
export class RoomsService {
  private readonly logger = new Logger(RoomsService.name);
  private readonly rooms = new Map<string, Room>();

  constructor(private readonly workers: WorkersService) {}

  private async room(id: string): Promise<Room> {
    const existing = this.rooms.get(id);
    if (existing) return existing;
    const router = await this.workers.take().createRouter({ mediaCodecs: MEDIA_CODECS });
    const room: Room = { id, router, peers: new Map() };
    this.rooms.set(id, room);
    this.logger.log(`room "${id}" created (router ${router.id})`);
    return room;
  }

  /** Заводит участника в комнате. Снимок соседей клиент получает через producersFor. */
  async join(
    roomId: string,
    peer: Omit<Peer, 'transports' | 'producers' | 'consumers'>,
  ): Promise<{ router: types.Router; peer: Peer }> {
    const room = await this.room(roomId);
    // Переподключение с тем же id (перезагрузка вкладки, реконнект) — старую
    // сессию закрываем, иначе её producer'ы останутся висеть немым дублем.
    const stale = room.peers.get(peer.id);
    if (stale) this.leave(stale);
    const full: Peer = {
      ...peer,
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
    };
    room.peers.set(full.id, full);
    return { router: room.router, peer: full };
  }

  /** Убирает участника и всё, что он держал. Идемпотентно. */
  leave(peer: Peer): void {
    const room = this.rooms.get(peer.room);
    // Транспорт при закрытии уносит с собой свои producer'ы и consumer'ы —
    // отдельно их закрывать не нужно, достаточно транспортов.
    for (const transport of peer.transports.values()) transport.close();
    peer.transports.clear();
    peer.producers.clear();
    peer.consumers.clear();
    if (!room) return;
    // Только если это всё ещё он: при быстром реконнекте место мог занять
    // новый объект того же участника, и затирать его нельзя.
    if (room.peers.get(peer.id) === peer) room.peers.delete(peer.id);
    if (room.peers.size === 0) {
      room.router.close();
      this.rooms.delete(room.id);
      this.logger.log(`room "${room.id}" closed (empty)`);
    }
  }

  peers(roomId: string): Peer[] {
    return [...(this.rooms.get(roomId)?.peers.values() ?? [])];
  }

  router(roomId: string): types.Router | undefined {
    return this.rooms.get(roomId)?.router;
  }

  async createTransport(
    peer: Peer,
  ): Promise<{ transport: types.WebRtcTransport; params: TransportParams }> {
    const router = this.router(peer.room);
    if (!router) throw new Error('room is gone');
    const transport = await router.createWebRtcTransport(webRtcTransportOptions());
    transport.on('dtlsstatechange', (state) => {
      if (state === 'closed' || state === 'failed') transport.close();
    });
    transport.on('@close', () => peer.transports.delete(transport.id));
    peer.transports.set(transport.id, transport);
    return {
      transport,
      params: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      },
    };
  }

  /** Все чужие producer'ы комнаты — то, что новичку надо начать слушать. */
  producersFor(peer: Peer): { peerId: string; name: string; producers: ProducerInfo[] }[] {
    return this.peers(peer.room)
      .filter((p) => p.id !== peer.id)
      .map((p) => ({
        peerId: p.id,
        name: p.name,
        producers: [...p.producers.values()].map(producerInfo),
      }));
  }
}

export interface TransportParams {
  id: string;
  iceParameters: types.IceParameters;
  iceCandidates: types.IceCandidate[];
  dtlsParameters: types.DtlsParameters;
}

export interface ProducerInfo {
  id: string;
  kind: types.MediaKind;
  source: ProducerSource;
}

export function producerInfo(producer: types.Producer): ProducerInfo {
  return {
    id: producer.id,
    kind: producer.kind,
    source: (producer.appData as { source?: ProducerSource }).source ?? 'mic',
  };
}
