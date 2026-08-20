'use client';

import { Device } from 'mediasoup-client';
import type {
  IceParameters,
  RtpCapabilities,
  RtpParameters,
  Transport,
  TransportOptions,
} from 'mediasoup-client/types';
import { io, type Socket } from 'socket.io-client';
import { tx } from '@/lib/i18n';
import type { TransportHost, VoiceTransport } from '../types';
import {
  type Ack,
  type ConsumerLayers,
  type ConsumerPayload,
  type PeerSnapshot,
  type ProducerInfo,
  type Source,
  type WelcomePayload,
} from './protocol';
import { createPublisher } from './publish';
import { createMetrics } from './metrics';
import { createLadder } from './recovery';
import { createSubscriber } from './subscribe';

/**
 * SFU-транспорт: своё медиа уходит на медиасервер ОДИН раз, он раздаёт его
 * остальным. Аплинк участника — константа, сколько бы людей ни было в канале;
 * это и есть то, чего mesh не может дать на 4+ с видео (docs/plans/old/sfu.md).
 *
 * Второй транспорт под тем же `VoiceTransport`, что и mesh. Устройства, гейт
 * микрофона, микшер входящего звука и плитки — по-прежнему у дирижёра
 * (`lib/voice.ts`), сюда они попадают только через `TransportHost`. Отсюда и
 * главное свойство: плитки и микшер не замечают, каким транспортом пришёл звук.
 *
 * Сигналинг — отдельный socket.io на путь `/sfu/`, рядом с основным сокетом
 * api. Пропуск (короткоживущий токен) выдаёт api, см. `apps/sfu/src/token.ts`.
 */

// Столько молчания входящей дорожки считаем сбоем, а не паузой в разговоре.
// Порог тот же, что и в mesh: мут у нас — `track.enabled = false`, RTP при этом
// продолжает идти, так что молчащий собеседник байты всё равно шлёт.
const SILENCE_MS = 8_000;

// ─────────────────────────────────────────────────────────────────────────

/**
 * WebView-обёртки прячутся из UA: WKWebView (десктоп на macOS) не пишет туда ни
 * `Safari`, ни `Chrome`, и автоопределение mediasoup-client честно отвечает
 * «device not supported» — мгновенный отвал в p2p, хотя движок — тот же WebKit
 * с полноценным WebRTC. Ловим ровно этот случай и явно просим handler Safari.
 * Остальные ошибки не наши — пробрасываем.
 */
function createDevice(): Device {
  try {
    return new Device();
  } catch (err) {
    const webkit =
      /AppleWebKit\//.test(navigator.userAgent) && typeof RTCRtpTransceiver !== 'undefined';
    if ((err as Error)?.name === 'UnsupportedError' && webkit) {
      console.warn('[sfu] UA не распознан, но движок WebKit — берём handler Safari12');
      return new Device({ handlerName: 'Safari12' });
    }
    throw err;
  }
}

export function createSfuTransport(host: TransportHost): VoiceTransport {
  let sock: Socket | null = null;
  let device: Device | null = null;
  let sendTransport: Transport | null = null;
  let recvTransport: Transport | null = null;

  // Свои дорожки живут отдельным предметом: их заводит, подменяет и закрывает
  // только он, а транспорт спрашивает у нас — лестница его пересобирает.
  const publisher = createPublisher({
    host,
    sendTransport: () => sendTransport,
    device: () => device,
    ask,
  });

  // Чужие дорожки и витрина — второй предмет. Надпись на плитке он снимает по
  // нашей связи с сервером, поэтому спрашивает её у нас (см. Б2 в плане).
  const subscriber = createSubscriber({
    host,
    recvTransport: () => recvTransport,
    device: () => device,
    ask,
    linked: () => ladder.isUp() && !mediaBroken(),
  });

  // Лестница восстановления — третий предмет. Своё состояние (ступень, три
  // сторожа, «встали» и «сдались») она держит сама, а ступени получает отсюда:
  // чинить связь умеем только мы, знать, когда и в каком порядке, — только она.
  const ladder = createLadder({
    host,
    broken: mediaBroken,
    hasSocket: () => sock !== null,
    socketConnected: () => sock?.connected === true,
    restartIce,
    rebuild: rebuildTransports,
    tellTiles,
  });

  // Цифры о звонке — четвёртый предмет: пинг, палочки, аплинк и сторож тишины.
  // Все они читают один и тот же снимок статистики за тик.
  const metrics = createMetrics({
    host,
    subscriber,
    ask,
    transports: () => [recvTransport, sendTransport],
    uplink: () => publisher.uplink(),
    broken: mediaBroken,
    isUp: ladder.isUp,
    gaveUp: ladder.gaveUp,
    restartIce,
    rebuild: rebuildTransports,
  });

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
      ladder.transportState(direction, state);
    });

    return transport;
  }

  /**
   * Всё, что нужно отдать наружу сразу после подключения. Возвращает false, если
   * микрофон у нас есть, а уехать не смог: это не мелочь, а весь смысл звонка —
   * дальше по стеку такой заход лечится переездом в p2p, а не тишиной с
   * зелёной надписью «подключено».
   */
  async function onWelcome(payload: WelcomePayload) {
    try {
      device = createDevice();
      await device.load({ routerRtpCapabilities: payload.routerRtpCapabilities });
      sendTransport = await openTransport('send');
      recvTransport = await openTransport('recv');
      if (!sendTransport || !recvTransport) throw new Error('no transports');
      // Микрофон не уехал — считаем это несостоявшимся входом, как и мёртвый
      // транспорт: дирижёр уведёт звонок в p2p, где дорожка пойдёт напрямую.
      // Раньше такой заход молча заканчивался «подключено» и полной тишиной.
      if (!(await publisher.publishLocal())) throw new Error('mic not published');
      // Вход состоялся ЗДЕСЬ: транспорты стоят, своё медиа уехало — нас уже
      // слышно. Подписки на чужие дорожки идут следом и в счёт входа не идут:
      // каждая — отдельный запрос с ответом (до 10 с ожидания), и в людной
      // комнате их сумма легко перебирала сторож входа. Сторож срабатывал на
      // полностью исправном соединении и уводил весь звонок в p2p.
      ladder.markUp();
      // Число своих дорожек — в ту же веху: «встал» без единой из них и есть тот
      // самый немой заход, и по логу это должно читаться одной строкой.
      host.diag('sfu up', `peers=${payload.peers.length} tracks=${publisher.count()}`);
      // Успевший прийти до `welcome` в его снимке комнаты не значится — снять
      // надпись с его плитки больше некому.
      for (const peerId of subscriber.peerIds()) subscriber.sayTileState(peerId);
      for (const peer of payload.peers) {
        subscriber.addPeer(peer.peerId, peer.name);
        for (const producer of peer.producers) await subscriber.consume(peer.peerId, producer);
      }
      // То, что объявилось, пока мы строились. Обязательно после снимка
      // комнаты: в нём тех же дорожек может уже и не быть.
      await subscriber.drainPending();
    } catch (err) {
      console.error('[sfu] setup failed:', err);
      host.diag('sfu setup failed', String((err as Error)?.message ?? err));
      // Упало ДО того, как мы встали, — это несостоявшийся вход (дирижёр уводит
      // в p2p безусловно). Упало после — мы уже на связи и слышны, решение о
      // переезде принимается по составу комнаты, как при любой другой потере.
      ladder.giveUp(ladder.isUp() ? 'lost' : 'setup');
    }
  }

  // ── Ступени лестницы ──────────────────────────────────────────────────
  //
  // Когда их звать, решает `recovery.ts`; здесь — чем именно чинить.

  function mediaBroken(): boolean {
    return [sendTransport, recvTransport].some(
      (t) => t && (t.connectionState === 'failed' || t.connectionState === 'disconnected'),
    );
  }

  /**
   * Что видно на плитках, пока лестница идёт: надпись и погашенные палочки.
   * Транспорт у медиасервера один на всех, поэтому и надпись на всех сразу:
   * развалился он, а не связь с кем-то одним.
   *
   * Раньше вся лестница шла молча. Тоста на ступенях нет намеренно (они длятся
   * секунды и чаще всего кончаются успехом), `setStatus` в этой части
   * приложения не показывает никто — статус читает только гостевая сцена, — и
   * человек оставался с неподвижными плитками, без звука и без единого слова о
   * том, что происходит. В mesh это есть с самого начала (handleStateChange), и
   * разница между транспортами тут была не решением, а недосмотром.
   */
  function tellTiles(broken: boolean) {
    if (broken) metrics.dim();
    subscriber.sayAll(broken ? 'reconnecting' : 'settled');
  }

  /** Ступень 1: переизбрать ICE, не трогая дорожки. Лечит смену сетевого пути. */
  async function restartIce() {
    for (const transport of [sendTransport, recvTransport]) {
      if (!transport) continue;
      const res = await ask<{ iceParameters: IceParameters }>('restart-ice', {
        transportId: transport.id,
      });
      if (!res) continue;
      await transport.restartIce({ iceParameters: res.iceParameters }).catch((err) => {
        console.warn('[sfu] restartIce failed:', err);
      });
    }
  }

  /**
   * Ступень 2: выбросить транспорты и построить заново поверх того же сокета.
   * Свои дорожки и подписки поднимаем сами; чужие плитки при этом не трогаем —
   * с точки зрения витрины никто никуда не уходил.
   */
  async function rebuildTransports() {
    const wanted = subscriber.entries().map((entry) => ({
      peerId: entry.peerId,
      info: {
        id: entry.producerId,
        kind: entry.consumer.kind,
        source: entry.source,
      } as ProducerInfo,
    }));
    for (const entry of subscriber.entries()) subscriber.dropConsumer(entry.producerId);
    publisher.closeAll();
    for (const transport of [sendTransport, recvTransport]) {
      if (!transport) continue;
      // Сервер о закрытии транспорта иначе не узнает: он висел бы до дисконнекта,
      // а остальные продолжали бы слушать наши мёртвые дорожки.
      void ask('close-transport', { transportId: transport.id });
      transport.close();
    }
    sendTransport = await openTransport('send');
    recvTransport = await openTransport('recv');
    if (!sendTransport || !recvTransport) return; // не вышло — дожмёт сторож
    // Микрофон не уехал — на пересборке это значит ровно то же, что и на входе
    // (см. `onWelcome`): транспорты стоят, палочки зелёные, а нас не слышно, и
    // человек узнаёт об этом от собеседника через минуту разговора в пустоту.
    // Раньше ответ `publishLocal` здесь выбрасывался, и ступень 2 кончалась
    // молчаливым успехом. Считаем это потерей — дирижёр уведёт в p2p.
    if (!(await publisher.publishLocal())) {
      host.diag('sfu rebuild failed', 'mic not published');
      ladder.giveUp('lost');
      return;
    }
    for (const { peerId, info } of wanted) await subscriber.consume(peerId, info);
    await subscriber.drainPending();
  }

  // ── Реализация интерфейса ─────────────────────────────────────────────

  /** Полный разбор: свои дорожки, чужие, транспорты и сам сокет. */
  function teardown() {
    publisher.closeAll();
    subscriber.clear();
    sendTransport?.close();
    recvTransport?.close();
    sendTransport = null;
    recvTransport = null;
    device = null;
    // Плитки собеседников снимает дирижёр (при выходе он чистит их целиком),
    // но своё состояние обнуляем сами.
    metrics.reset();
    ladder.reset();
    sock?.removeAllListeners();
    sock?.disconnect();
    sock = null;
  }

  return {
    // Подписки вешаются на СВОЙ сокет при каждом входе — здесь ничего не нужно.
    init() {},

    join(_room, ticket) {
      if (!ticket) return; // без пропуска в медиасервер нам нечего делать
      // Повторный вход без выхода: прежний сокет надо снять самим, иначе он
      // остаётся жить безымянным — со своими транспортами и нашим микрофоном в
      // комнате, из которой мы уже ушли, и снять его будет уже нечем.
      if (sock) teardown();
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

      // Сторож входа: медиасервер не поднял нас за отведённое время — это отказ,
      // а не «ещё чуть-чуть». Дирижёр уведёт звонок в p2p, вместо того чтобы
      // держать человека в тишине с крутилкой.
      ladder.armSetup();

      // Сокет не открылся вовсе (сервер лежит, прокси не пускает) — ждать сторож
      // незачем, ответ уже известен.
      s.on('connect_error', (err) => {
        console.warn('[sfu] connect_error:', err.message);
        host.diag('sfu connect_error', err.message);
        if (!ladder.isUp()) ladder.giveUp('setup');
      });

      s.on('welcome', (payload: WelcomePayload) => void onWelcome(payload));
      s.on('peer-joined', ({ peerId, name }: { peerId: string; name: string }) => {
        subscriber.addPeer(peerId, name);
      });
      s.on('new-producer', ({ peerId, producer }: { peerId: string; producer: ProducerInfo }) => {
        void subscriber.consume(peerId, producer);
      });
      s.on('producer-closed', ({ producerId }: { producerId: string }) => {
        subscriber.dropConsumer(producerId);
      });
      s.on('peer-left', ({ peerId }: { peerId: string }) => {
        host.setStatus('voice.status.peerLeft', {
          name: subscriber.nameOf(peerId) || tx('voice.peer.fallback'),
        });
        subscriber.dropPeer(peerId);
        host.playSfx('peerLeave');
      });
      s.on('consumer-layers', ({ consumerId, spatialLayer }: ConsumerLayers) => {
        subscriber.layerReported(consumerId, spatialLayer);
      });
      // Сигналинг оборвался посреди звонка. Само по себе медиа ещё может идти —
      // ICE живёт отдельно от WS, — но переподключиться сокет не сможет: пропуск
      // одноразовый и уже протух. Новый умеет выписать только дирижёр.
      s.on('disconnect', () => {
        ladder.signalingLost();
      });
      s.on('sfu-error', ({ error }: { error: string }) => {
        console.error('[sfu] rejected:', error);
        host.diag('sfu rejected', error);
        ladder.giveUp(ladder.isUp() ? 'lost' : 'setup');
      });
    },

    leave() {
      if (!sock) return; // в медиасервер мы не ходили — разбирать нечего
      teardown();
      host.setUplink('ok');
    },

    publishVideo() {
      void publisher.syncVideo();
    },

    unpublishVideo() {
      void publisher.syncVideo();
    },

    publishScreen() {
      void publisher.syncVideo();
      const audio = host.screenAudioTrack();
      if (audio) void publisher.publishScreenAudio(audio);
    },

    unpublishScreen() {
      void publisher.syncVideo();
      publisher.closeProducer('screen-audio');
    },

    replaceMicTrack(_oldTrack, newTrack) {
      void publisher.replaceMic(newTrack);
    },

    retuneVideo() {
      void publisher.retuneScreen();
    },

    pollStats() {
      void metrics.tick();
    },

    renamePeer(id, name) {
      subscriber.rename(id, name);
    },

    focusChanged(id) {
      subscriber.setFocus(id);
    },

    reset() {
      // Сокет api переподключился с новым id — прежний пропуск выписан на
      // мёртвый peerId, и медиасервер ждёт нас под другим именем. Заново войдёт
      // дирижёр.
      teardown();
    },
  };
}
