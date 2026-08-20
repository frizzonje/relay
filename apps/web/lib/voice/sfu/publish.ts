'use client';

import type { Device, Producer, Transport } from 'mediasoup-client/types';
import type { UplinkStatus } from '@/stores/voice';
import type { TransportHost } from '../types';
import { readStats, worseUplink } from '../stats';
import {
  CAM_ENCODINGS,
  MIC_CODEC_OPTIONS,
  SCREEN_AUDIO_CODEC_OPTIONS,
  SCREEN_ENCODINGS,
  type Ask,
  type Source,
} from './protocol';

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
}

export function createPublisher({ host, sendTransport, device, ask }: PublishDeps): Publisher {
  const producers = new Map<Source, Producer>();

  async function produce(source: Source, track: MediaStreamTrack): Promise<boolean> {
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
      return true;
    }
    // appData уходит в `produce` на сервер — по нему остальные узнают роль
    // дорожки, а не гадают по порядку.
    const isScreen = source === 'screen';
    try {
      const producer = await transport.produce({
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
  };
}
