'use client';

import { toast } from 'sonner';
import { Device } from 'mediasoup-client';
import type {
  Consumer,
  Producer,
  RtpCapabilities,
  RtpParameters,
  Transport,
  TransportOptions,
} from 'mediasoup-client/types';
import { io, type Socket } from 'socket.io-client';
import type { TransportHost, VoiceTransport } from './types';

/**
 * SFU-транспорт: своё медиа уходит на медиасервер ОДИН раз, он раздаёт его
 * остальным. Аплинк участника — константа, сколько бы людей ни было в канале;
 * это и есть то, чего mesh не может дать на 4+ с видео (docs/sfu-plan.md).
 *
 * Второй транспорт под тем же `VoiceTransport`, что и mesh. Устройства, гейт
 * микрофона, микшер входящего звука и плитки — по-прежнему у дирижёра
 * (`lib/voice.ts`), сюда они попадают только через `TransportHost`. Отсюда и
 * главное свойство: плитки и микшер не замечают, каким транспортом пришёл звук.
 *
 * Сигналинг — отдельный socket.io на путь `/sfu/`, рядом с основным сокетом
 * api. Пропуск (короткоживущий токен) выдаёт api, см. `apps/sfu/src/token.ts`.
 */

// ─────────────────────────────────────────────────────────────────────────
// Что чем является на проводе
// ─────────────────────────────────────────────────────────────────────────

/** Роль дорожки. Совпадает с `ProducerSource` на сервере — контракт общий. */
type Source = 'mic' | 'cam' | 'screen' | 'screen-audio';

interface ProducerInfo {
  id: string;
  kind: 'audio' | 'video';
  source: Source;
}

interface PeerSnapshot {
  peerId: string;
  name: string;
  producers: ProducerInfo[];
}

interface WelcomePayload {
  peerId: string;
  routerRtpCapabilities: RtpCapabilities;
  peers: PeerSnapshot[];
}

interface ConsumerPayload {
  id: string;
  producerId: string;
  peerId: string;
  kind: 'audio' | 'video';
  rtpParameters: RtpParameters;
  source: Source;
}

type Ack<T> = ({ ok: true } & T) | { ok: false; error: string };

// ─────────────────────────────────────────────────────────────────────────
// Профили кодирования
// ─────────────────────────────────────────────────────────────────────────

// Камера — три слоя simulcast: сервер сам выберет, кому какой отдать, а мы
// поверх просим слой явно (см. focusChanged). Ради этого simulcast и нужен:
// на плитке 160px нет смысла принимать 720p, и наоборот.
const CAM_ENCODINGS = [
  { rid: 'q', maxBitrate: 150_000, scaleResolutionDownBy: 4, scalabilityMode: 'L1T3' },
  { rid: 'h', maxBitrate: 500_000, scaleResolutionDownBy: 2, scalabilityMode: 'L1T3' },
  { rid: 'f', maxBitrate: 1_800_000, scalabilityMode: 'L1T3' },
];

// Демонстрация экрана — наоборот, один жирный слой: текст в мыле нечитаем,
// деградация «в мыло» тут хуже, чем просадка ФПС.
const SCREEN_ENCODINGS = [{ maxBitrate: 8_000_000, scalabilityMode: 'L1T3' }];

// Потолки Opus те же, что в mesh: голос на «discord-уровне», звук демонстрации
// (музыка/фильм) заметно жирнее — там слышно разницу.
const MIC_CODEC_OPTIONS = { opusStereo: false, opusFec: true, opusMaxAverageBitrate: 128_000 };
const SCREEN_AUDIO_CODEC_OPTIONS = {
  opusStereo: true,
  opusFec: true,
  opusMaxAverageBitrate: 256_000,
};

// Верхний слой simulcast (индекс), он же «дай максимум».
const TOP_SPATIAL_LAYER = 2;

// Слот аудио-дорожки для микшера. Дирижёр различает голос и звук демонстрации
// по порядку этого ключа (в mesh туда идёт `mid`) — здесь мы роль ЗНАЕМ точно,
// она приходит в `source`, поэтому просто отдаём фиксированный порядок.
const AUDIO_SLOT: Record<string, string> = { mic: '0', 'screen-audio': '1' };

// ─────────────────────────────────────────────────────────────────────────

export function createSfuTransport(host: TransportHost): VoiceTransport {
  let sock: Socket | null = null;
  let device: Device | null = null;
  let sendTransport: Transport | null = null;
  let recvTransport: Transport | null = null;

  const producers = new Map<Source, Producer>();
  // Consumer'ы по producerId — так их снимает `producer-closed`.
  const consumers = new Map<string, { consumer: Consumer; peerId: string; source: Source }>();
  const names = new Map<string, string>();
  // По одному MediaStream на собеседника: в него кладём его видео, плитка
  // держит ссылку и переживает смену дорожки (камера → экран) без пересоздания.
  const streams = new Map<string, MediaStream>();
  let focusedId: string | null = null;

  /** Запрос с ack. Ошибку не глотаем — возвращаем `null` и пишем в консоль. */
  function ask<T>(event: string, payload: unknown): Promise<({ ok: true } & T) | null> {
    const s = sock;
    if (!s) return Promise.resolve(null);
    return new Promise((resolve) => {
      s.timeout(10_000).emit(event, payload, (err: unknown, res: Ack<T>) => {
        if (err || !res || !res.ok) {
          console.warn(`[sfu] ${event} failed:`, err ?? (res as { error?: string })?.error);
          resolve(null);
          return;
        }
        resolve(res);
      });
    });
  }

  // ── Публикация своих дорожек ──────────────────────────────────────────

  async function produce(source: Source, track: MediaStreamTrack): Promise<void> {
    if (!sendTransport || !device) return;
    if (track.kind === 'video' && !device.canProduce('video')) return;
    // Дорожка этой роли уже течёт (повторный вызов publishScreen и т.п.) —
    // подменяем её в существующем producer'е, а не заводим второй.
    const live = producers.get(source);
    if (live) {
      await live.replaceTrack({ track }).catch(() => {});
      return;
    }
    // appData уходит в `produce` на сервер (см. sendTransport 'produce' ниже) —
    // по нему остальные узнают роль дорожки, а не гадают по порядку.
    const isScreen = source === 'screen';
    try {
      const producer = await sendTransport.produce({
        track,
        appData: { source },
        ...(track.kind === 'video'
          ? { encodings: isScreen ? SCREEN_ENCODINGS : CAM_ENCODINGS }
          : {}),
        ...(track.kind === 'audio'
          ? {
              codecOptions:
                source === 'screen-audio' ? SCREEN_AUDIO_CODEC_OPTIONS : MIC_CODEC_OPTIONS,
            }
          : {}),
      });
      producers.set(source, producer);
    } catch (err) {
      console.error(`[sfu] produce ${source} failed:`, err);
    }
  }

  /** Закрыть свой producer и сказать серверу — иначе он останется висеть. */
  function closeProducer(source: Source) {
    const producer = producers.get(source);
    if (!producer) return;
    producers.delete(source);
    producer.close();
    void ask('close-producer', { producerId: producer.id });
  }

  /**
   * Приводим свой видео-producer к тому, что сейчас в видео-слоте у дирижёра
   * (камера, экран или ничего). Смена дорожки внутри той же роли — дешёвый
   * `replaceTrack`; смена самой роли требует пересоздания: `source` вшит в
   * producer при создании, и врать про него нельзя — по нему остальные решают,
   * что показывать.
   */
  async function syncVideo() {
    const track = host.videoTrack();
    const wanted: Source | null = !track ? null : host.screenOn() ? 'screen' : 'cam';
    for (const stale of ['cam', 'screen'] as const) {
      if (stale !== wanted) closeProducer(stale);
    }
    if (!wanted || !track) return;
    const existing = producers.get(wanted);
    if (existing) {
      await existing.replaceTrack({ track }).catch(() => {});
      return;
    }
    await produce(wanted, track);
  }

  // ── Приём чужих дорожек ───────────────────────────────────────────────

  async function consume(peerId: string, info: ProducerInfo) {
    if (!recvTransport || !device) return;
    const res = await ask<{ consumer: ConsumerPayload }>('consume', {
      transportId: recvTransport.id,
      producerId: info.id,
      rtpCapabilities: device.rtpCapabilities,
    });
    if (!res) return;
    const c = res.consumer;
    let consumer: Consumer;
    try {
      consumer = await recvTransport.consume({
        id: c.id,
        producerId: c.producerId,
        kind: c.kind,
        rtpParameters: c.rtpParameters,
      });
    } catch (err) {
      console.error('[sfu] consume failed:', err);
      return;
    }
    consumers.set(c.producerId, { consumer, peerId, source: c.source });

    // Все дорожки собеседника держим в ОДНОМ MediaStream, как приходило из mesh
    // (`ontrack` отдавал общий поток). Это не косметика: скрытый `<audio>`-сток
    // из фазы 1 «прокачивает» дорожку, без него на части Chrome/Safari WebAudio
    // отдаёт тишину. Сток заводится по этому же потоку.
    const stream = ensureStream(peerId);
    if (c.kind === 'video') stream.getVideoTracks().forEach((t) => stream.removeTrack(t));
    stream.addTrack(consumer.track);
    host.addTile(peerId, names.get(peerId) ?? 'Участник', stream, false);
    host.setTileState(peerId, '');

    if (c.kind === 'audio') {
      // Звук — в тот же микшер, что и в mesh: громкость по собеседнику, VAD,
      // разделение «голос / звук демонстрации». Само видео на плитке заглушено.
      host.attachRemoteAudio(peerId, consumer.track, AUDIO_SLOT[c.source] ?? '9', stream);
    } else {
      applyLayers(peerId, consumer);
    }

    // Протокол требует именно такого порядка: consumer приходит на паузе, трек
    // подключён — только теперь просим пустить пакеты.
    await ask('resume', { consumerId: consumer.id });
  }

  function ensureStream(peerId: string): MediaStream {
    let stream = streams.get(peerId);
    if (!stream) {
      stream = new MediaStream();
      streams.set(peerId, stream);
    }
    return stream;
  }

  function dropConsumer(producerId: string) {
    const entry = consumers.get(producerId);
    if (!entry) return;
    consumers.delete(producerId);
    entry.consumer.close();
    streams.get(entry.peerId)?.removeTrack(entry.consumer.track);
    // `close()` дорожку останавливает, но `ended` не шлёт — узел микшера
    // пришлось бы оставить висеть. Снимаем его явно.
    if (entry.consumer.kind === 'audio') {
      host.detachRemoteAudio(entry.peerId, entry.consumer.track);
    }
  }

  function dropPeer(peerId: string) {
    for (const [producerId, entry] of [...consumers]) {
      if (entry.peerId === peerId) dropConsumer(producerId);
    }
    streams.delete(peerId);
    names.delete(peerId);
    host.removeTile(peerId);
  }

  // ── Adaptive subscription ─────────────────────────────────────────────

  // Плитка на весь экран просит верхний слой, остальные — нижний. Без этого
  // simulcast бессмысленен: сервер по умолчанию отдаёт максимум всем.
  function applyLayers(peerId: string, consumer: Consumer) {
    if (consumer.kind !== 'video') return;
    // Демонстрация экрана идёт одним слоем — просить у неё нечего.
    if (consumers.get(consumer.producerId)?.source === 'screen') return;
    const spatialLayer = !focusedId || focusedId === peerId ? TOP_SPATIAL_LAYER : 0;
    void ask('preferred-layers', { consumerId: consumer.id, spatialLayer });
  }

  // ── Установка соединения ──────────────────────────────────────────────

  /** Создаёт транспорт нужного направления и вешает на него обработчики. */
  async function openTransport(direction: 'send' | 'recv'): Promise<Transport | null> {
    if (!device) return null;
    const res = await ask<{ params: TransportOptions }>('create-transport', { direction });
    if (!res) return null;
    const transport =
      direction === 'send'
        ? device.createSendTransport(res.params)
        : device.createRecvTransport(res.params);

    transport.on('connect', ({ dtlsParameters }, done, fail) => {
      void ask('connect-transport', { transportId: transport.id, dtlsParameters }).then((ok) =>
        ok ? done() : fail(new Error('connect-transport failed')),
      );
    });

    if (direction === 'send') {
      transport.on('produce', ({ kind, rtpParameters, appData }, done, fail) => {
        void ask<{ id: string }>('produce', {
          transportId: transport.id,
          kind,
          rtpParameters,
          source: (appData as { source?: Source }).source,
        }).then((res) => (res ? done({ id: res.id }) : fail(new Error('produce failed'))));
      });
    }

    transport.on('connectionstatechange', (state) => {
      if (state === 'failed') {
        // Лестница восстановления (restartIce + пересборка) — шаг E плана.
        // Пока честно говорим, что связь с сервером развалилась.
        host.setStatus('Медиасервер: связь потеряна');
      }
    });

    return transport;
  }

  /** Всё, что нужно отдать наружу сразу после подключения. */
  async function publishLocal() {
    const stream = host.localStream();
    const screenAudio = host.screenAudioTrack();
    const mic = stream?.getAudioTracks().find((t) => t !== screenAudio) ?? null;
    if (mic) await produce('mic', mic);
    if (screenAudio) await produce('screen-audio', screenAudio);
    await syncVideo();
  }

  async function onWelcome(payload: WelcomePayload) {
    try {
      device = new Device();
      await device.load({ routerRtpCapabilities: payload.routerRtpCapabilities });
      sendTransport = await openTransport('send');
      recvTransport = await openTransport('recv');
      if (!sendTransport || !recvTransport) throw new Error('no transports');
      await publishLocal();
      for (const peer of payload.peers) {
        names.set(peer.peerId, peer.name || 'Участник');
        host.addTile(peer.peerId, peer.name || 'Участник', null, false);
        host.setTileState(peer.peerId, 'соединение…');
        for (const producer of peer.producers) await consume(peer.peerId, producer);
      }
    } catch (err) {
      console.error('[sfu] setup failed:', err);
      host.setStatus('Медиасервер недоступен');
      toast.error('Не удалось подключиться к медиасерверу.');
      host.playSfx('error');
    }
  }

  // ── Реализация интерфейса ─────────────────────────────────────────────

  /** Полный разбор: свои дорожки, чужие, транспорты и сам сокет. */
  function teardown() {
    producers.forEach((p) => p.close());
    producers.clear();
    consumers.forEach((c) => c.consumer.close());
    consumers.clear();
    sendTransport?.close();
    recvTransport?.close();
    sendTransport = null;
    recvTransport = null;
    device = null;
    // Плитки собеседников снимает дирижёр (при выходе он чистит их целиком),
    // но своё состояние обнуляем сами.
    streams.clear();
    names.clear();
    focusedId = null;
    sock?.removeAllListeners();
    sock?.disconnect();
    sock = null;
  }

  return {
    // Подписки вешаются на СВОЙ сокет при каждом входе — здесь ничего не нужно.
    init() {},

    join(_room, ticket) {
      if (!ticket) return; // без пропуска в медиасервер нам нечего делать
      // `url === '/'` — медиасервер за тем же Caddy, что и страница; в дев-режиме
      // адрес api задан явно, тогда идём туда же.
      const base =
        ticket.url && ticket.url !== '/'
          ? ticket.url
          : process.env.NEXT_PUBLIC_SOCKET_URL || undefined;
      const s = io(base, {
        path: '/sfu/',
        transports: ['websocket', 'polling'],
        auth: { token: ticket.token },
      });
      sock = s;

      s.on('welcome', (payload: WelcomePayload) => void onWelcome(payload));
      s.on('peer-joined', ({ peerId, name }: { peerId: string; name: string }) => {
        names.set(peerId, name || 'Участник');
        host.addTile(peerId, name || 'Участник', null, false);
        host.setTileState(peerId, 'соединение…');
      });
      s.on('new-producer', ({ peerId, producer }: { peerId: string; producer: ProducerInfo }) => {
        void consume(peerId, producer);
      });
      s.on('producer-closed', ({ producerId }: { producerId: string }) => {
        dropConsumer(producerId);
      });
      s.on('peer-left', ({ peerId }: { peerId: string }) => {
        host.setStatus((names.get(peerId) || 'Участник') + ' вышел');
        dropPeer(peerId);
        host.playSfx('peerLeave');
      });
      s.on('sfu-error', ({ error }: { error: string }) => {
        console.error('[sfu] rejected:', error);
        host.setStatus('Медиасервер отказал в доступе');
      });
    },

    leave() {
      teardown();
      host.setUplink('ok');
    },

    publishVideo() {
      void syncVideo();
    },

    unpublishVideo() {
      void syncVideo();
    },

    publishScreen() {
      void syncVideo();
      const audio = host.screenAudioTrack();
      if (audio) void produce('screen-audio', audio);
    },

    unpublishScreen() {
      void syncVideo();
      closeProducer('screen-audio');
    },

    replaceMicTrack(_oldTrack, newTrack) {
      const mic = producers.get('mic');
      if (mic) void mic.replaceTrack({ track: newTrack }).catch(() => {});
      else void produce('mic', newTrack);
    },

    retuneVideo() {
      // Тумблер «качество/ФПС» в SFU-режиме упирается в слои, а не в
      // degradationPreference — семантика палочек и слоёв переезжает в шаг E.
    },

    pollStats() {
      // Пинг и палочки качества до собеседника в SFU не имеют смысла: связь
      // теперь до сервера. Новая семантика — шаг E плана, здесь сознательно
      // пусто, чтобы не показывать mesh-цифры, которых уже нет.
    },

    renamePeer(id, name) {
      names.set(id, name);
    },

    focusChanged(id) {
      focusedId = id;
      for (const entry of consumers.values()) applyLayers(entry.peerId, entry.consumer);
    },

    reset() {
      // Сокет api переподключился с новым id — прежний пропуск выписан на
      // мёртвый peerId, и медиасервер ждёт нас под другим именем. Заново войдёт
      // дирижёр.
      teardown();
    },
  };
}
