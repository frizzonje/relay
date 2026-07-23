'use client';

import { Device } from 'mediasoup-client';
import type {
  Consumer,
  IceParameters,
  Producer,
  RtpCapabilities,
  RtpParameters,
  Transport,
  TransportOptions,
} from 'mediasoup-client/types';
import { io, type Socket } from 'socket.io-client';
import type { UplinkStatus } from '@/stores/voice';
import type { TransportHost, VoiceTransport } from './types';
import {
  gradeQuality,
  kbps,
  limitReason,
  pingGrade,
  rttFromStats,
  type NetSnapshot,
} from './quality';

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

/** Слой simulcast, который сервер реально отдаёт по этому consumer'у. */
interface ConsumerLayers {
  consumerId: string;
  spatialLayer: number | null;
  temporalLayer: number | null;
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

// Окно на каждую ступень лестницы восстановления: не поднялись за него — идём
// дальше. Столько же ждёт mesh на своём ICE-restart.
const RECOVER_WINDOW_MS = 8_000;

// Сколько ждём медиасервер на входе: welcome + оба транспорта. Не поднялись —
// это отказ, а не «ещё чуть-чуть»: дирижёр уведёт звонок в p2p.
const SETUP_TIMEOUT_MS = 12_000;

// Слот аудио-дорожки для микшера. Дирижёр различает голос и звук демонстрации
// по порядку этого ключа (в mesh туда идёт `mid`) — здесь мы роль ЗНАЕМ точно,
// она приходит в `source`, поэтому просто отдаём фиксированный порядок.
const AUDIO_SLOT: Record<string, string> = { mic: '0', 'screen-audio': '1' };

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

  const producers = new Map<Source, Producer>();
  // Consumer'ы по producerId — так их снимает `producer-closed`.
  const consumers = new Map<string, { consumer: Consumer; peerId: string; source: Source }>();
  const names = new Map<string, string>();
  // По одному MediaStream на собеседника: в него кладём его видео, плитка
  // держит ссылку и переживает смену дорожки (камера → экран) без пересоздания.
  const streams = new Map<string, MediaStream>();
  // Счётчики прошлого тика по собеседникам — из них считаются потери за
  // интервал и мгновенный битрейт (см. quality.ts).
  const netHistory = new Map<string, NetSnapshot>();
  // Реально доехавший слой simulcast по consumerId — сервер сообщает его сам
  // (`consumer-layers`), это факт, а не наша заявка в `preferred-layers`.
  const gotLayer = new Map<string, number | null>();
  let focusedId: string | null = null;

  // Лестница восстановления: 0 — всё в порядке, 1 — сделан ICE-restart,
  // 2 — транспорты пересобраны. Дальше идти некуда, решает дирижёр.
  let recoverStage = 0;
  let failTimer: ReturnType<typeof setTimeout> | null = null;
  let setupTimer: ReturnType<typeof setTimeout> | null = null;
  let socketTimer: ReturnType<typeof setTimeout> | null = null;
  // ready — мы хоть раз встали (лестница до этого момента бессмысленна);
  // lost — уже сдались и позвали дирижёра, второй раз звать не надо.
  let ready = false;
  let lost = false;

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
    if (track.kind === 'video' && !device.canProduce('video')) {
      // Тихий отказ здесь — это и есть «звук есть, видео нет»: движок не нашёл
      // ни одного видеокодека роутера в своих send-возможностях (WebKit шлёт
      // почти только H264 нужного профиля). Раньше молчали — теперь кричим, и в
      // консоль, и на сервер: иначе диагностируется только гаданием.
      console.error('[sfu] device cannot produce video — нет совпадающего кодека');
      host.diag('sfu no video codec', source);
      return;
    }
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
      // Какой кодек реально согласовали — виден в консоли обеих сторон и на
      // сервере. По нему сразу ясно, что ушло (video/VP8, video/H264…), а не
      // «producer вроде создан». Дёшево и снимает половину догадок при разборе.
      host.diag('sfu produce', `${source} ${producer.rtpParameters.codecs[0]?.mimeType ?? '?'}`);
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
    } else {
      await produce(wanted, track);
    }
    if (wanted === 'screen') await retuneScreen();
  }

  /**
   * Тумблер «качество/ФПС» демонстрации. Слои тут ни при чём: mediasoup рулит
   * producer'ом, но под ним остаётся обычный `RTCRtpSender`, и предпочтение
   * кодировщика ставится ровно так же, как в mesh — иначе один и тот же тумблер
   * в двух режимах делал бы разное.
   */
  async function retuneScreen() {
    const sender = producers.get('screen')?.rtpSender;
    if (!sender) return;
    try {
      const params = sender.getParameters();
      params.degradationPreference = host.screenDegradation();
      await sender.setParameters(params);
    } catch (err) {
      console.warn('[sfu] setParameters failed:', err);
    }
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
    gotLayer.delete(entry.consumer.id);
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
      if (state === 'connected') {
        // Встали (сами или после ступени лестницы) — сбрасываем её.
        if (failTimer) clearTimeout(failTimer);
        failTimer = null;
        recoverStage = 0;
        return;
      }
      // 'disconnected' часто сам проходит за секунду-другую (перескок сети),
      // поэтому даём ему фору; 'failed' — окончательно, лечим сразу.
      if (state === 'failed' || state === 'disconnected') {
        host.diag('sfu transport', `${direction} ${state}`);
      }
      if (state === 'failed') scheduleRecovery(0);
      else if (state === 'disconnected') scheduleRecovery(4_000);
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
      device = createDevice();
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
      ready = true;
      if (setupTimer) clearTimeout(setupTimer);
      setupTimer = null;
      host.diag('sfu up', `peers=${payload.peers.length}`);
    } catch (err) {
      console.error('[sfu] setup failed:', err);
      host.diag('sfu setup failed', String((err as Error)?.message ?? err));
      giveUp('setup');
    }
  }

  // ── Лестница восстановления ───────────────────────────────────────────
  //
  // В mesh лестница чинила связь с КАЖДЫМ собеседником отдельно (ICE-restart →
  // пересборка relay-only). Здесь собеседник ровно один — сервер, — поэтому и
  // лестница одна на звонок, зато её обрыв уносит сразу всех: последняя ступень
  // не «снять пира», а позвать дирижёра (он решит, ехать ли в p2p).

  function mediaBroken(): boolean {
    return [sendTransport, recvTransport].some(
      (t) => t && (t.connectionState === 'failed' || t.connectionState === 'disconnected'),
    );
  }

  function scheduleRecovery(delayMs: number) {
    if (failTimer || !ready) return; // лестница уже идёт (или мы ещё не вставали)
    failTimer = setTimeout(() => {
      failTimer = null;
      void recover();
    }, delayMs);
  }

  async function recover() {
    if (!sock || !mediaBroken()) {
      recoverStage = 0; // отпустило само, пока ждали
      return;
    }
    if (recoverStage === 0) {
      recoverStage = 1;
      host.setStatus('Медиасервер: восстанавливаем связь…');
      host.diag('sfu recover', 'stage 1: restart-ice');
      await restartIce();
      scheduleRecovery(RECOVER_WINDOW_MS); // сторож: не помогло — следующая ступень
      return;
    }
    if (recoverStage === 1) {
      recoverStage = 2;
      host.setStatus('Медиасервер: пересобираем соединение…');
      host.diag('sfu recover', 'stage 2: rebuild transports');
      await rebuildTransports();
      scheduleRecovery(RECOVER_WINDOW_MS);
      return;
    }
    giveUp('lost');
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
    const wanted = [...consumers].map(([producerId, entry]) => ({
      peerId: entry.peerId,
      info: { id: producerId, kind: entry.consumer.kind, source: entry.source } as ProducerInfo,
    }));
    for (const producerId of [...consumers.keys()]) dropConsumer(producerId);
    for (const source of [...producers.keys()]) closeProducer(source);
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
    await publishLocal();
    for (const { peerId, info } of wanted) await consume(peerId, info);
  }

  /** Лестница кончилась. Куда ехать дальше — не наше решение, а дирижёра. */
  function giveUp(reason: 'setup' | 'lost') {
    if (lost) return; // дирижёр уже позван — второй раз незачем
    lost = true;
    clearTimers();
    host.setStatus('Медиасервер недоступен');
    host.transportLost(reason);
  }

  function clearTimers() {
    for (const timer of [failTimer, setupTimer, socketTimer]) {
      if (timer) clearTimeout(timer);
    }
    failTimer = null;
    setupTimer = null;
    socketTimer = null;
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
        const rtt = rttFromStats(await transport.getStats());
        if (rtt != null) return rtt;
      } catch {
        /* транспорт мог закрыться под руками — просто пробуем второй */
      }
    }
    return null;
  }

  function updatePing(rtt: number | null) {
    if (names.size === 0) {
      host.setPing({ waiting: true, ms: null, grade: null, label: 'один в канале' });
      return;
    }
    if (rtt == null) {
      host.setPing({
        waiting: true,
        ms: null,
        grade: null,
        label: ready ? 'замеряем задержку' : 'устанавливаем связь',
      });
      return;
    }
    host.setPing({ waiting: false, ms: rtt, grade: pingGrade(rtt), label: '' });
  }

  async function updatePeerQuality(rtt: number | null) {
    for (const peerId of names.keys()) {
      const mine = [...consumers.values()].filter((e) => e.peerId === peerId);
      if (mine.length === 0) {
        netHistory.delete(peerId); // ещё ничего не слушаем — мерить нечего
        continue;
      }

      let lost = 0;
      let recv = 0;
      let bytesRecv = 0;
      let jitterMs: number | null = null;
      let width = 0;
      let height = 0;
      let fps: number | null = null;
      let codec: string | null = null;

      for (const entry of mine) {
        let stats: RTCStatsReport;
        try {
          stats = await entry.consumer.getStats();
        } catch {
          continue;
        }
        stats.forEach((r) => {
          if (r.type !== 'inbound-rtp') return;
          const kind = (r as { kind?: string; mediaType?: string }).kind ?? r.mediaType;
          lost += (r as { packetsLost?: number }).packetsLost ?? 0;
          recv += (r as { packetsReceived?: number }).packetsReceived ?? 0;
          bytesRecv += (r as { bytesReceived?: number }).bytesReceived ?? 0;
          const j = (r as { jitter?: number }).jitter;
          if (kind === 'audio' && j != null) jitterMs = Math.round(j * 1000);
          if (kind !== 'video') return;
          const rv = r as {
            frameWidth?: number;
            frameHeight?: number;
            framesPerSecond?: number;
            codecId?: string;
          };
          if (rv.frameWidth && rv.frameHeight) {
            width = rv.frameWidth;
            height = rv.frameHeight;
          }
          if (rv.framesPerSecond != null) fps = Math.round(rv.framesPerSecond);
          const mime = rv.codecId
            ? (stats.get(rv.codecId) as { mimeType?: string } | undefined)?.mimeType
            : undefined;
          if (mime) codec = mime.split('/')[1]?.toUpperCase() ?? null;
        });
      }

      // Потери и битрейт — за интервал, а не накопленным итогом с начала звонка.
      const prev = netHistory.get(peerId);
      const now = Date.now();
      netHistory.set(peerId, { lost, recv, bytesSent: 0, bytesRecv, ts: now });
      let lossPct: number | null = null;
      let recvKbps: number | null = null;
      if (prev) {
        const dLost = Math.max(0, lost - prev.lost);
        const dRecv = Math.max(0, recv - prev.recv);
        const total = dLost + dRecv;
        lossPct = total > 0 ? Math.round((dLost / total) * 1000) / 10 : 0;
        recvKbps = kbps(bytesRecv, prev.bytesRecv, now - prev.ts);
      }

      // Слой берём с камеры: у демонстрации он один, показывать нечего.
      const cam = mine.find((e) => e.source === 'cam');
      const layer = cam ? (gotLayer.get(cam.consumer.id) ?? null) : null;

      host.setTileNet(peerId, {
        grade: gradeQuality(rtt, lossPct ?? 0),
        rttMs: rtt,
        lossPct,
        jitterMs,
        relay: null, // TURN в этом режиме не участвует — путь всегда через сервер
        sendKbps: null, // исходящий у нас общий на всех, «к нему» не существует
        recvKbps,
        videoRes: width && height ? `${width}×${height}` : null,
        fps,
        codec,
        via: 'sfu',
        layer,
      });
    }
  }

  /** Здоровье своего аплинка — там же, где в mesh: qualityLimitationReason. */
  async function updateUplink() {
    let worst: UplinkStatus = 'ok';
    for (const producer of producers.values()) {
      if (producer.kind !== 'video' || producer.closed) continue;
      try {
        const stats = await producer.getStats();
        stats.forEach((r) => {
          if (r.type !== 'outbound-rtp') return;
          const reason = limitReason(
            (r as { qualityLimitationReason?: string }).qualityLimitationReason,
          );
          if (reason === 'bandwidth') worst = 'bandwidth';
          else if (reason === 'cpu' && worst === 'ok') worst = 'cpu';
        });
      } catch {
        /* producer мог закрыться между тиками */
      }
    }
    host.setUplink(worst);
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
    netHistory.clear();
    gotLayer.clear();
    focusedId = null;
    clearTimers();
    recoverStage = 0;
    ready = false;
    lost = false;
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

      // Сторож входа: медиасервер не поднял нас за отведённое время — это отказ,
      // а не «ещё чуть-чуть». Дирижёр уведёт звонок в p2p, вместо того чтобы
      // держать человека в тишине с крутилкой.
      setupTimer = setTimeout(() => {
        setupTimer = null;
        if (!ready) giveUp('setup');
      }, SETUP_TIMEOUT_MS);

      // Сокет не открылся вовсе (сервер лежит, прокси не пускает) — ждать сторож
      // незачем, ответ уже известен.
      s.on('connect_error', (err) => {
        console.warn('[sfu] connect_error:', err.message);
        host.diag('sfu connect_error', err.message);
        if (!ready) giveUp('setup');
      });

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
      s.on('consumer-layers', ({ consumerId, spatialLayer }: ConsumerLayers) => {
        gotLayer.set(consumerId, spatialLayer);
      });
      // Сигналинг оборвался посреди звонка. Само по себе медиа ещё может идти —
      // ICE живёт отдельно от WS, — но переподключиться сокет не сможет: пропуск
      // одноразовый и уже протух. Новый умеет выписать только дирижёр.
      s.on('disconnect', () => {
        if (!ready || lost) return;
        host.diag('sfu signaling lost');
        host.setStatus('Медиасервер: связь с сигналингом потеряна');
        if (socketTimer) clearTimeout(socketTimer);
        socketTimer = setTimeout(() => {
          socketTimer = null;
          if (!sock?.connected) giveUp('lost');
        }, RECOVER_WINDOW_MS);
      });
      s.on('sfu-error', ({ error }: { error: string }) => {
        console.error('[sfu] rejected:', error);
        host.diag('sfu rejected', error);
        giveUp(ready ? 'lost' : 'setup');
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
      void retuneScreen();
    },

    pollStats() {
      void (async () => {
        const rtt = await serverRtt();
        updatePing(rtt);
        await updatePeerQuality(rtt);
        await updateUplink();
      })();
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
