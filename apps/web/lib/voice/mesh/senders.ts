'use client';

import { boostVideoBitrate, boostAudioBitrate } from '@/lib/sdp';
import { setting } from '@/stores/config';
import type { TransportHost } from '../types';

/**
 * Потолки битрейта и публикация своих дорожек в одно соединение.
 *
 * Лист дерева: знает про `RTCRtpSender` и дирижёра — и больше ни про что. Ни
 * лестницы восстановления, ни сигналинга здесь нет и быть не должно.
 *
 * Всё, что зовёт `setParameters`, живёт здесь и только здесь. Параметры
 * кодировщика — как раз та вещь, которая разъезжается молча: потолок,
 * выставленный в двух местах по-разному, ничего не ломает сразу, а просто
 * однажды начинает значить не то, что написано в соседнем файле.
 */

// ─────────────────────────────────────────────────────────────────────────
// Потолки битрейта (SDP задаёт предел кодеку, setParameters — sender'у)
// ─────────────────────────────────────────────────────────────────────────

const SCREEN_MAX_BITRATE = 8_000_000;

// Потолок звука демонстрации (музыка/фильм) — заметно жирнее голоса: там
// слышно разницу.
const SCREEN_AUDIO_MAX_BITRATE = 256_000;

/**
 * Потолки камеры и голоса выбирает владелец инсталляции
 * (`voice.videoBitrateKbps`, `voice.audioBitrateKbps`); умолчания каталога —
 * те самые 2500 и 128 кбит/с, с которыми relay жил до этапа C.
 *
 * Спрашиваем в момент, когда дорожку настраивают, а не при загрузке модуля:
 * снимок настроек приезжает после первого кадра, и число, снятое на старте,
 * осталось бы вчерашним до перезагрузки вкладки. Демонстрацию экрана настройка
 * не трогает намеренно — она про камеру и голос, а текст в мыле нечитаем.
 */
function videoMaxBitrate(): number {
  return setting<number>('voice.videoBitrateKbps') * 1000;
}

function micAudioMaxBitrate(): number {
  return setting<number>('voice.audioBitrateKbps') * 1000;
}

/**
 * Кто и что отдаёт одному собеседнику. Два слота на соединение: общий видеослот
 * (в нём едет ЛИБО камера, ЛИБО экран — одновременно они не нужны никому) и
 * отдельная дорожка со звуком демонстрации.
 *
 * Слоты живут здесь, а не в записи о собеседнике. Собеседник — это `pc`, имя,
 * роль в переговорах и состояние связи; `RTCRtpSender` описывает не его, а нашу
 * отправку, и держать их в одной структуре означало приглашать четыре разные
 * подсистемы писать в одну запись — ровно та болезнь, от которой этот разрез.
 */
interface Slots {
  videoSender: RTCRtpSender | null;
  screenAudioSender: RTCRtpSender | null;
}

/**
 * Поднять потолки в SDP: и видео (x-google-bitrate), и голос (Opus:
 * стерео/битрейт/FEC) — иначе звонок звучит глухо на дефолтном ~32 кбит/с моно.
 * Чистая функция: сам разбор SDP лежит в `lib/sdp.ts`.
 */
export function tuneSdp(sdp: string | undefined): string | undefined {
  return boostAudioBitrate(boostVideoBitrate(sdp));
}

export interface Senders {
  /** Отдать собеседнику текущее видео (камеру ИЛИ экран) через общий слот. */
  sendVideoTo(peerId: string, pc: RTCPeerConnection): void;
  /** То же плюс отдельная дорожка со звуком экрана. */
  sendScreenTo(peerId: string, pc: RTCPeerConnection): void;
  /** Убрать из общего видеослота то, что там едет. */
  stopVideo(peerId: string): void;
  /** Убрать и картинку экрана, и его звук. */
  stopScreen(peerId: string): void;
  /** Привести потолки всех аудио-sender'ов пира к их ролям. */
  tuneAudio(peerId: string, pc: RTCPeerConnection): Promise<void>;
  /** Перетюнить видео: после выхода на связь и при смене тумблера «качество/ФПС». */
  tuneVideo(peerId: string, isScreen: boolean): void;
  /** Соединение закрылось: слоты вместе с ним. */
  forget(peerId: string): void;
  forgetAll(): void;
}

export function createSenders(host: TransportHost): Senders {
  const slots = new Map<string, Slots>();

  function slotsOf(peerId: string): Slots {
    let s = slots.get(peerId);
    if (!s) {
      s = { videoSender: null, screenAudioSender: null };
      slots.set(peerId, s);
    }
    return s;
  }

  // Поднимаем потолок битрейта у одного аудио-sender'а. SDP задаёт
  // maxaveragebitrate кодеку, а это — фактический максимум кодировщика.
  async function setAudioSenderBitrate(sender: RTCRtpSender, max: number) {
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings.forEach((e) => {
        e.maxBitrate = max;
        // Голос/звук демонстрации важнее картинки: под нагрузкой WebRTC душит
        // потоки по приоритету. Без этого голос рвётся наравне с видео, когда
        // кто-то параллельно льёт экран на 8 Мбит/с. high = и DSCP-метка, и
        // распределение полосы в пользу аудио.
        e.priority = 'high';
        e.networkPriority = 'high';
      });
      await sender.setParameters(params);
    } catch (err) {
      console.warn('audio setParameters failed:', err);
    }
  }

  async function tuneVideoSender(sender: RTCRtpSender, isScreen: boolean) {
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = isScreen ? SCREEN_MAX_BITRATE : videoMaxBitrate();
      // Экран — по выбору пользователя (тумблер Качество/ФПС); камера — сбалансированно
      params.degradationPreference = isScreen ? host.screenDegradation() : 'balanced';
      await sender.setParameters(params);
    } catch (err) {
      console.warn('setParameters failed:', err);
    }
  }

  function sendVideoTo(peerId: string, pc: RTCPeerConnection) {
    const track = host.videoTrack();
    if (!track) return;
    const slot = slotsOf(peerId);
    if (slot.videoSender) {
      slot.videoSender.replaceTrack(track).catch(() => {});
    } else {
      slot.videoSender = pc.addTrack(track, host.localStream()!);
    }
    void tuneVideoSender(slot.videoSender, host.screenOn());
  }

  return {
    sendVideoTo,

    // Демонстрация = видео экрана (общий слот) + отдельная аудиодорожка со звуком экрана
    sendScreenTo(peerId, pc) {
      sendVideoTo(peerId, pc);
      const audio = host.screenAudioTrack();
      if (!audio) return;
      const slot = slotsOf(peerId);
      if (slot.screenAudioSender) {
        slot.screenAudioSender.replaceTrack(audio).catch(() => {});
      } else {
        slot.screenAudioSender = pc.addTrack(audio, host.localStream()!);
      }
      // Звуку демонстрации — высокий потолок сразу (показ мог стартовать уже после
      // того, как связь установилась, и общий tuneAudio по нему не прошёлся).
      void setAudioSenderBitrate(slot.screenAudioSender, SCREEN_AUDIO_MAX_BITRATE);
    },

    stopVideo(peerId) {
      slots
        .get(peerId)
        ?.videoSender?.replaceTrack(null)
        .catch(() => {});
    },

    stopScreen(peerId) {
      const slot = slots.get(peerId);
      if (!slot) return;
      slot.videoSender?.replaceTrack(null).catch(() => {});
      slot.screenAudioSender?.replaceTrack(null).catch(() => {});
    },

    // Тюним все аудио-sender'ы пира: звук демонстрации — под высокий потолок
    // (музыка/фильм), микрофон и прочее — под голосовой.
    async tuneAudio(peerId, pc) {
      const screenAudio = slots.get(peerId)?.screenAudioSender ?? null;
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== 'audio') continue;
        const max = sender === screenAudio ? SCREEN_AUDIO_MAX_BITRATE : micAudioMaxBitrate();
        await setAudioSenderBitrate(sender, max);
      }
    },

    tuneVideo(peerId, isScreen) {
      const sender = slots.get(peerId)?.videoSender;
      if (sender) void tuneVideoSender(sender, isScreen);
    },

    forget(peerId) {
      slots.delete(peerId);
    },

    forgetAll() {
      slots.clear();
    },
  };
}
