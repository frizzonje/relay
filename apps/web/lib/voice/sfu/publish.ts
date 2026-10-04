'use client';

import type { Device, Producer, RtpCodecCapability, Transport } from 'mediasoup-client/types';
import type { UplinkStatus } from '@/stores/voice';
import { setting } from '@/stores/config';
import { SDP_START_BITRATE_KBPS } from '@/lib/sdp';
import type { TransportHost } from '../types';
import { readSendVideo, readStats, worseUplink, type SendVideo } from '../stats';
import { sfuScreenEncodings, type ScreenProfile } from '../screen-profile';
import { createScreenTelemetry } from '../screen-telemetry';
import { describeSender, setSenderParameters } from '../sender-params';
import { isH264, pickScreenCodec } from './screen-codec';
import {
  AUDIO_ENCODINGS,
  CAM_ENCODINGS,
  MIC_CODEC_OPTIONS,
  SCREEN_AUDIO_CODEC_OPTIONS,
  type Ask,
  type Source,
} from './protocol';

/**
 * Лестница simulcast, ужатая под потолок инсталляции (`voice.videoBitrateKbps`).
 *
 * Именно потолок, а не замена: слои различаются не только битрейтом, но и
 * разрешением, и подставить одно число вместо трёх значило бы отдать плитке в
 * 160px тот же поток, что и полноэкранной. Умолчание каталога (2500 кбит/с)
 * выше самого жирного слоя, поэтому инсталляция, где панель не открывали,
 * публикует сегодняшнюю лестницу байт в байт; настройкой её только сжимают.
 */
function camEncodings(): typeof CAM_ENCODINGS {
  const cap = setting<number>('voice.videoBitrateKbps') * 1000;
  return CAM_ENCODINGS.map((layer) => ({ ...layer, maxBitrate: Math.min(layer.maxBitrate, cap) }));
}

/**
 * Голос под потолком инсталляции (`voice.audioBitrateKbps`). Умолчание каталога
 * — те же 128 кбит/с, что стоят в профиле, поэтому ненастроенная инсталляция
 * звучит ровно как вчера.
 */
function micCodecOptions(): typeof MIC_CODEC_OPTIONS {
  return {
    ...MIC_CODEC_OPTIONS,
    opusMaxAverageBitrate: setting<number>('voice.audioBitrateKbps') * 1000,
  };
}

/**
 * Стартовая оценка канала под трансляцию. Без неё движок начинает с 300 кбит/с
 * и разгоняется осторожно: верхний слой включался секунд через десять, а
 * зритель всё это время смотрел мыло (стенд 2026-10-04: со стартом верхний
 * слой идёт с третьей секунды). Тот же старт, что в mesh, но не выше профиля:
 * 720p незачем начинать с четырёх мегабит.
 */
function screenCodecOptions(profile: ScreenProfile) {
  return {
    videoGoogleStartBitrate: Math.min(SDP_START_BITRATE_KBPS, Math.round(profile.bitrate / 1000)),
  };
}

/**
 * Свои дорожки на медиасервере.
 *
 * Уезжают они туда ровно по разу, сколько бы людей ни было в канале, — в этом
 * весь смысл режима. Отсюда и владение: `producers` заводятся, подменяются и
 * закрываются только здесь, а всё остальное про них спрашивает.
 *
 * Транспорт этот файл не держит: его пересобирает лестница восстановления, и
 * ссылка на него протухает. Поэтому — функцией, каждый раз заново.
 */
export interface PublishDeps {
  host: TransportHost;
  /** Транспорт, по которому уходит наше медиа (лестница его пересобирает). */
  sendTransport(): Transport | null;
  device(): Device | null;
  ask: Ask;
}

export interface Publisher {
  /** Отправить всё, что есть: микрофон, звук демонстрации, видео. */
  publishLocal(): Promise<boolean>;
  /** Привести видео-producer к тому, что сейчас в видео-слоте у дирижёра. */
  syncVideo(): Promise<void>;
  /** Применить тумблер «качество/ФПС» к демонстрации. */
  retuneScreen(): Promise<void>;
  /** Подменить микрофонную дорожку, не пересоздавая producer. */
  replaceMic(track: MediaStreamTrack): Promise<void>;
  /** Отправить звук демонстрации: он включается отдельно от картинки. */
  publishScreenAudio(track: MediaStreamTrack): Promise<void>;
  closeProducer(source: Source): void;
  /** Закрыть все свои дорожки молча — сервер и так узнает (выход, разбор). */
  closeAll(): void;
  /** Сколько своих дорожек сейчас едет. Ноль на входе — это немой заход. */
  count(): number;
  /** Здоровье своего аплинка — там же, где в mesh: qualityLimitationReason. */
  uplink(): Promise<UplinkStatus>;
  /** Что реально уходит с трансляции экрана; null — её нет. */
  screenSend(): Promise<SendVideo | null>;
}

/** Высота и кадры того, что снимается сейчас: от них считаются слои и битрейт экрана. */
function trackHeight(track: MediaStreamTrack): number {
  return track.getSettings?.().height ?? 0;
}

function trackFps(track: MediaStreamTrack): number {
  return track.getSettings?.().frameRate ?? 0;
}

export function createPublisher({ host, sendTransport, device, ask }: PublishDeps): Publisher {
  const producers = new Map<Source, Producer>();
  // Публикации, которые уже идут, по роли. Роль публикуют с разных сторон почти
  // разом — вход, сверка после обрыва, тумблер камеры, — а в `producers` она
  // попадает только после ответа сервера. Без этой записи обе проходили
  // проверку «уже течёт»: сервер оставлял вторую, а первая так и кодировалась
  // у нас сиротой — для экрана это двойная нагрузка на процессор и аплинк.
  const inflight = new Map<Source, Promise<boolean>>();
  // Что реально уходит с трансляции — по слоям, в серверный лог.
  const telemetry = createScreenTelemetry((event, detail) => host.diag(event, detail));

  async function produce(source: Source, track: MediaStreamTrack): Promise<boolean> {
    const pending = inflight.get(source);
    if (pending) {
      // Дождаться той публикации и подменить в ней дорожку — как с живой.
      await pending;
      const live = producers.get(source);
      if (live && live.track !== track) await live.replaceTrack({ track }).catch(() => {});
      return !!live;
    }
    const run = produceNow(source, track);
    inflight.set(source, run);
    try {
      return await run;
    } finally {
      inflight.delete(source);
    }
  }

  async function produceNow(source: Source, track: MediaStreamTrack): Promise<boolean> {
    const transport = sendTransport();
    const dev = device();
    if (!transport || !dev) {
      host.diag('sfu produce skipped', `${source} no transport`);
      return false;
    }
    if (track.kind === 'video' && !dev.canProduce('video')) {
      // Тихий отказ здесь — это и есть «звук есть, видео нет»: движок не нашёл
      // ни одного видеокодека роутера в своих send-возможностях (WebKit шлёт
      // почти только H264 нужного профиля). Раньше молчали — теперь кричим, и в
      // консоль, и на сервер: иначе диагностируется только гаданием.
      console.error('[sfu] device cannot produce video — нет совпадающего кодека');
      host.diag('sfu no video codec', source);
      return false;
    }
    // Дорожка этой роли уже течёт (повторный вызов publishScreen и т.п.) —
    // подменяем её в существующем producer'е, а не заводим второй.
    const live = producers.get(source);
    if (live) {
      await live.replaceTrack({ track }).catch(() => {});
      if (source === 'screen') await retuneScreen();
      return true;
    }
    // Трансляции — аппаратный кодировщик, если он есть (см. screen-codec.ts).
    const codec =
      source === 'screen' ? await pickScreenCodec(dev, host.screenProfile()) : undefined;
    // Пока движок отвечал про кодировщик, показ успели остановить: публиковать
    // нечего, а опубликованная мёртвая дорожка висела бы у зрителей замёрзшим
    // кадром до следующей сверки.
    if (track.readyState === 'ended') return false;
    if (codec) {
      const ok = await produceWith(source, track, codec);
      if (ok) return true;
      // H264 не поднялся (движок передумал, отказал кодировщик) — трансляция
      // важнее кодека: уходим, как раньше, на умолчании.
      host.diag('sfu produce fallback', `${source} ${codec.mimeType} → default`);
    }
    return produceWith(source, track);
  }

  async function produceWith(
    source: Source,
    track: MediaStreamTrack,
    codec?: RtpCodecCapability,
  ): Promise<boolean> {
    const transport = sendTransport();
    if (!transport) return false;
    // appData уходит в `produce` на сервер — по нему остальные узнают роль
    // дорожки, а не гадают по порядку.
    const isScreen = source === 'screen';
    try {
      const producer = await transport.produce({
        track,
        appData: { source },
        ...(codec ? { codec } : {}),
        // Дорожкой владеет приложение, а не производитель: mediasoup-client по
        // умолчанию (stopTracks: true) останавливает трек при закрытии
        // producer'а, и любой разбор транспорта — переезд, реконнект сокета,
        // пересборка лестницей — молча гасил микрофон и экран. Следующая
        // публикация падала с «track ended», и звонок оставался в тишине до
        // перезахода. Гасят дорожки только их владельцы: mic.ts и camera.ts.
        stopTracks: false,
        // Экран — два слоя simulcast под профиль трансляции: нижний для
        // плитки, верхний для того, кто развернул (см. screen-profile.ts).
        // Голос и звук трансляции — с высоким приоритетом: стример льёт
        // десяток мегабит, и на забитом аплинке голос иначе рвался бы наравне
        // с картинкой (в mesh так с самого начала, см. setAudioSenderBitrate).
        encodings:
          track.kind === 'audio'
            ? AUDIO_ENCODINGS
            : isScreen
              ? screenEncodings(track, codec)
              : camEncodings(),
        ...(track.kind === 'audio'
          ? {
              codecOptions:
                source === 'screen-audio' ? SCREEN_AUDIO_CODEC_OPTIONS : micCodecOptions(),
            }
          : isScreen
            ? { codecOptions: screenCodecOptions(host.screenProfile()) }
            : {}),
      });
      producers.set(source, producer);
      // Какой кодек реально согласовали — виден в консоли обеих сторон и на
      // сервере. По нему сразу ясно, что ушло (video/VP8, video/H264…), а не
      // «producer вроде создан». Дёшево и снимает половину догадок при разборе.
      host.diag('sfu produce', `${source} ${producer.rtpParameters.codecs[0]?.mimeType ?? '?'}`);
      return true;
    } catch (err) {
      // Молчать здесь нельзя: не уехавший микрофон — это «я в канале, меня не
      // слышно», ровно та тишина, которую разбирают перезаходами. В нативной
      // оболочке консоли нет вовсе, так что веху обязан увидеть сервер.
      console.error(`[sfu] produce ${source} failed:`, err);
      host.diag('sfu produce failed', `${source} ${String((err as Error)?.message ?? err)}`);
      return false;
    }
  }

  /**
   * Слои трансляции. Временные слои (`L1T3`) просим только у VP8: аппаратный
   * H264 их часто не умеет, а неизвестный `scalabilityMode` движок вправе
   * отвергнуть вместе со всей публикацией.
   */
  function screenEncodings(track: MediaStreamTrack, codec?: RtpCodecCapability) {
    const layers = sfuScreenEncodings(host.screenProfile(), trackHeight(track), trackFps(track));
    if (!isH264(codec)) return layers;
    return layers.map(({ scalabilityMode: _, ...layer }) => layer);
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
   * Привести кодировки экрана к профилю трансляции: битрейт и кадры каждого
   * слоя, масштаб нижнего (кадр мог смениться — другой режим, другое окно) и
   * что беречь при нехватке. Слоёв столько же, сколько было при создании:
   * число кодировок `setParameters` менять не даёт. Тот же тумблер в mesh
   * ставится тем же `setParameters` — иначе в двух режимах он делал бы разное.
   */
  async function retuneScreen() {
    const producer = producers.get('screen');
    const sender = producer?.rtpSender;
    if (!producer || !sender || !producer.track) return;
    const wanted = sfuScreenEncodings(
      host.screenProfile(),
      trackHeight(producer.track),
      trackFps(producer.track),
    );
    const failed = await setSenderParameters(
      sender,
      (params) => {
        params.encodings.forEach((encoding, i) => {
          const layer = wanted[Math.min(i, wanted.length - 1)];
          encoding.maxBitrate = layer.maxBitrate;
          encoding.maxFramerate = layer.maxFramerate;
          encoding.scaleResolutionDownBy = layer.scaleResolutionDownBy;
        });
      },
      host.screenDegradation(),
    );
    // Что движок принял на самом деле — рядом с тем, что просили: отказ здесь
    // и есть «поменял настройку — ничего не изменилось».
    host.diag('screen enc', describeSender(sender, failed));
  }

  return {
    async publishLocal() {
      const stream = host.localStream();
      const screenAudio = host.screenAudioTrack();
      const mic = stream?.getAudioTracks().find((t) => t !== screenAudio) ?? null;
      let micOk = true;
      if (mic) micOk = await produce('mic', mic);
      // Микрофона нет вовсе (не выдали устройство) — это не отказ медиасервера:
      // напрямую человек будет так же нем, переезжать незачем. Но веха нужна:
      // снаружи «его не слышно» выглядит одинаково в обоих случаях.
      else host.diag('sfu no mic track', stream ? 'stream without audio' : 'no local stream');
      if (screenAudio) await produce('screen-audio', screenAudio);
      await syncVideo();
      return micOk;
    },

    syncVideo,
    retuneScreen,
    closeProducer,

    async replaceMic(track) {
      const mic = producers.get('mic');
      if (mic) await mic.replaceTrack({ track }).catch(() => {});
      else await produce('mic', track);
    },

    async publishScreenAudio(track) {
      await produce('screen-audio', track);
    },

    closeAll() {
      producers.forEach((p) => p.close());
      producers.clear();
    },

    count: () => producers.size,

    async uplink() {
      let worst: UplinkStatus = 'ok';
      for (const producer of producers.values()) {
        if (producer.kind !== 'video' || producer.closed) continue;
        try {
          worst = worseUplink(worst, readStats(await producer.getStats()).uplink);
        } catch {
          /* producer мог закрыться между тиками */
        }
      }
      return worst;
    },

    async screenSend() {
      const producer = producers.get('screen');
      if (!producer || producer.closed) {
        telemetry.tx(null);
        return null;
      }
      try {
        const report = await producer.getStats();
        telemetry.tx(report);
        return readSendVideo(report);
      } catch {
        return null; // закрылся между тиками
      }
    },
  };
}
