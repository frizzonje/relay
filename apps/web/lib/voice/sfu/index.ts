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
import { createLadder } from './recovery';
import { createSubscriber, type ConsumerEntry } from './subscribe';
import { gradeQuality, pingGrade } from '../quality';
import {
  netDelta,
  readStats,
  sumStats,
  toHistory,
  type NetSnapshot,
  type StatsSnapshot,
} from '../stats';

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

/** Отсев пропавших снимков, он же сужение типа: `undefined` из карты сюда не едет. */
const isSnapshot = (s: StatsSnapshot | undefined): s is StatsSnapshot => s !== undefined;

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

  // Счётчики прошлого тика по собеседникам — из них считаются потери за
  // интервал и мгновенный битрейт (см. quality.ts).
  const netHistory = new Map<string, NetSnapshot>();
  // Входящий звук по producerId: сколько байт видели в прошлый раз, когда они
  // в последний раз росли и сколько раз мы уже будили эту дорожку (см.
  // `monitorAudioFlow`).
  const audioFlow = new Map<string, { bytes: number; since: number; kicks: number }>();

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
    if (broken) dimTileNet();
    subscriber.sayAll(broken ? 'reconnecting' : 'settled');
  }

  /**
   * Погасить палочки у всех сразу — по той же причине, что и надпись выше:
   * путь до медиасервера один на всех, и если развалился он, то про связь с
   * каждым мы не знаем ничего.
   *
   * Гасить приходится явно. Само по себе молчание транспорта выглядит на
   * счётчиках consumer'ов как полный штиль: потерь за интервал ноль, rtt
   * `null`, — и `gradeQuality(null, 0)` уверенно рисует четыре палочки ровно в
   * ту минуту, когда связи нет. Индикатор для того и нужен, чтобы в тишине
   * ответить «у меня или у него», и врать он не имеет права. В mesh это есть с
   * самого начала (`connState !== 'connected'` — и всё в `null`).
   */
  function dimTileNet() {
    for (const peerId of subscriber.peerIds()) {
      netHistory.delete(peerId);
      host.setTileNet(peerId, {
        grade: 'bad',
        rttMs: null,
        lossPct: null,
        jitterMs: null,
        relay: null,
        sendKbps: null,
        recvKbps: null,
        videoRes: null,
        fps: null,
        codec: null,
        via: 'sfu',
        layer: null,
      });
    }
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

  // ── Палочки качества ──────────────────────────────────────────────────
  //
  // Семантика здесь другая, чем в mesh, и подменять одно другим нельзя: RTT и
  // потери — это НАШ канал до сервера, а не до собеседника; его половину пути
  // мы не видим в принципе. Поэтому «↑ кбит/с к нему» и «через реле» на плитке
  // молчат (их больше нет), зато появляется то, чего в mesh не бывает: какой
  // слой simulcast реально доехал. Тултип помечен `via: 'sfu'`.

  /** RTT до медиасервера — общий для всех плиток: путь-то один. */
  async function serverRtt(): Promise<number | null> {
    for (const transport of [recvTransport, sendTransport]) {
      if (!transport || transport.closed) continue;
      try {
        const rtt = readStats(await transport.getStats()).rttMs;
        if (rtt != null) return rtt;
      } catch {
        /* транспорт мог закрыться под руками — просто пробуем второй */
      }
    }
    return null;
  }

  function updatePing(rtt: number | null) {
    if (subscriber.peerIds().length === 0) {
      host.setPing({ waiting: true, ms: null, grade: null, label: 'ping.alone' });
      return;
    }
    if (rtt == null) {
      host.setPing({
        waiting: true,
        ms: null,
        grade: null,
        label: ladder.isUp() ? 'ping.measuring' : 'ping.connecting',
      });
      return;
    }
    host.setPing({ waiting: false, ms: rtt, grade: pingGrade(rtt), label: '' });
  }

  /**
   * Один снимок с каждой чужой дорожки за тик — и два читателя на него.
   *
   * Палочки и сторож тишины спрашивали каждый свой `getStats`, то есть звук
   * собеседника опрашивался дважды за тик и в два разных момента: сторож видел
   * байты, которых палочки в том же тике уже не видели.
   */
  async function collectConsumerStats(): Promise<Map<string, StatsSnapshot>> {
    const snaps = new Map<string, StatsSnapshot>();
    for (const entry of subscriber.entries()) {
      if (entry.consumer.closed) continue;
      try {
        snaps.set(entry.producerId, readStats(await entry.consumer.getStats()));
      } catch {
        /* consumer мог закрыться между тиками */
      }
    }
    return snaps;
  }

  function updatePeerQuality(rtt: number | null, snaps: Map<string, StatsSnapshot>) {
    // Связь до сервера развалилась — мерить нечего и незачем: см. `dimTileNet`.
    if (mediaBroken()) {
      dimTileNet();
      return;
    }
    for (const peerId of subscriber.peerIds()) {
      const mine = subscriber.entries().filter((e) => e.peerId === peerId);
      if (mine.length === 0) {
        netHistory.delete(peerId); // ещё ничего не слушаем — мерить нечего
        continue;
      }

      // Дорожек у собеседника несколько, а плитка одна: складываем в один снимок.
      const snap = sumStats(mine.map((e) => snaps.get(e.producerId)).filter(isSnapshot));

      // Потери и битрейт — за интервал, а не накопленным итогом с начала звонка.
      const now = Date.now();
      const delta = netDelta(netHistory.get(peerId), snap, now);
      netHistory.set(peerId, toHistory(snap, now));

      // Слой берём с камеры: у демонстрации он один, показывать нечего.
      const cam = mine.find((e) => e.source === 'cam');
      const layer = cam ? subscriber.layerOf(cam.consumer.id) : null;

      host.setTileNet(peerId, {
        grade: gradeQuality(rtt, delta.lossPct ?? 0),
        rttMs: rtt,
        lossPct: delta.lossPct,
        jitterMs: snap.jitterMs,
        relay: null, // TURN в этом режиме не участвует — путь всегда через сервер
        sendKbps: null, // исходящий у нас общий на всех, «к нему» не существует
        recvKbps: delta.recvKbps,
        videoRes: snap.videoRes,
        fps: snap.fps,
        codec: snap.codec,
        via: 'sfu',
        layer,
      });
    }
  }

  // ── Сторож односторонней тишины ───────────────────────────────────────
  //
  // Самая частая жалоба на звонок: «связь есть, палочки горят, а звука нет, и
  // само не проходит». В mesh её ловит `monitorAudioFlow` по байтам входящего
  // аудио; здесь до сих пор не ловил никто, хотя на медиасервере у этого сбоя
  // есть свой отдельный путь, вдобавок к сетевому: consumer приезжает на паузе
  // и снимается с неё отдельным запросом `resume`. Не дошёл запрос — дорожка
  // осталась на паузе навсегда, и снаружи это неотличимо от «прислали тишину».
  //
  // Отсюда и лестница, и её первая ступень, которой в mesh быть не может:
  // повторить `resume`. Дальше — общая сетевая: переизбрать ICE, потом собрать
  // транспорты заново.
  //
  // Условия «звук шёл и оборвался» здесь, в отличие от mesh, нет намеренно:
  // consumer существует только потому, что у собеседника есть дорожка, — и
  // ноль байт с самого начала как раз и означает ту самую вечную паузу.
  async function monitorAudioFlow(snaps: Map<string, StatsSnapshot>) {
    // Лестница уже идёт своим ходом — второй раз чинить то же самое незачем.
    if (!ladder.isUp() || ladder.gaveUp() || mediaBroken()) return;

    const now = Date.now();
    const wake: { entry: ConsumerEntry; secs: number }[] = [];
    let worstKick = 0;

    for (const entry of subscriber.entries()) {
      if (entry.consumer.kind !== 'audio' || entry.consumer.closed) continue;
      const snap = snaps.get(entry.producerId);
      if (!snap) continue; // дорожка закрылась под руками сборщика
      const bytes = snap.audioBytesRecv;
      const prev = audioFlow.get(entry.consumer.id);
      if (!prev || bytes > prev.bytes) {
        audioFlow.set(entry.consumer.id, { bytes, since: now, kicks: 0 });
        // Молчал, а теперь пошёл — снять с плитки надпись, которую поставили мы.
        if (prev?.kicks) subscriber.sayTileState(entry.peerId);
        continue;
      }
      if (now - prev.since <= SILENCE_MS) continue;

      // Байты не растут дольше порога. Отметку времени двигаем сразу: она же и
      // не даёт лестнице сорваться в цикл — следующая попытка не раньше чем
      // через SILENCE_MS.
      const kicks = prev.kicks + 1;
      const secs = Math.round((now - prev.since) / 1000);
      audioFlow.set(entry.consumer.id, { bytes, since: now, kicks });
      const name = subscriber.nameOf(entry.peerId) ?? entry.peerId;
      console.warn(
        `[sfu] нет входящего звука от «${name}» (${entry.peerId}) ${secs}с; bytesReceived=${bytes}`,
      );
      host.setTileState(entry.peerId, 'tile.state.reconnecting');
      if (kicks === 1) wake.push({ entry, secs });
      worstKick = Math.max(worstKick, kicks);
    }

    // Ступень 1 — по каждой молчащей дорожке отдельно: она и молчит отдельно.
    for (const { entry, secs } of wake) {
      host.diag(
        'sfu silence',
        `${subscriber.nameOf(entry.peerId) ?? entry.peerId} ${secs}s: resume`,
      );
      if (!(await ask('resume', { consumerId: entry.consumer.id }))) {
        host.diag('sfu resume failed', `wake ${entry.peerId}`);
      }
    }
    // Ступени 2 и 3 — общие: чинится не дорожка, а путь до сервера. Поэтому и
    // одна попытка на тик, сколько бы дорожек ни молчало.
    if (worstKick === 2) {
      host.diag('sfu silence', 'stage 2: restart-ice');
      await restartIce();
    } else if (worstKick > 2) {
      host.diag('sfu silence', 'stage 3: rebuild transports');
      await rebuildTransports();
    }
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
    netHistory.clear();
    audioFlow.clear();
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
      void (async () => {
        const rtt = await serverRtt();
        const snaps = await collectConsumerStats();
        updatePing(rtt);
        // Палочки — до сторожа: сторож чинит связь, и после его ступени снимок
        // этого тика описывал бы дорожки, которых уже нет.
        updatePeerQuality(rtt, snaps);
        host.setUplink(await publisher.uplink());
        await monitorAudioFlow(snaps);
      })();
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
