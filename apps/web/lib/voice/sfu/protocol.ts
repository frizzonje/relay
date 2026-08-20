'use client';

import type { RtpCapabilities, RtpParameters } from 'mediasoup-client/types';

/**
 * Что чем является на проводе между нами и медиасервером.
 *
 * Здесь только контракт: имена событий разбирает `index.ts`, а формы, которые
 * в них ездят, и профили кодирования, о которых мы договорились с роутером, —
 * тут. Ни состояния, ни зависимостей: этот файл — лист.
 *
 * Вторая сторона контракта — `apps/sfu/src/gateway/sfu.gateway.ts`. Менять
 * что-либо здесь в одиночку нельзя: клиент прошлой версии обязан звонить
 * клиенту новой.
 */

/** Роль дорожки. Совпадает с `ProducerSource` на сервере — контракт общий. */
export type Source = 'mic' | 'cam' | 'screen' | 'screen-audio';

export interface ProducerInfo {
  id: string;
  kind: 'audio' | 'video';
  source: Source;
}

export interface PeerSnapshot {
  peerId: string;
  name: string;
  producers: ProducerInfo[];
}

export interface WelcomePayload {
  peerId: string;
  routerRtpCapabilities: RtpCapabilities;
  peers: PeerSnapshot[];
}

export interface ConsumerPayload {
  id: string;
  producerId: string;
  peerId: string;
  kind: 'audio' | 'video';
  rtpParameters: RtpParameters;
  source: Source;
}

/** Слой simulcast, который сервер реально отдаёт по этому consumer'у. */
export interface ConsumerLayers {
  consumerId: string;
  spatialLayer: number | null;
  temporalLayer: number | null;
}

/** Ответ на запрос с подтверждением: либо полезная нагрузка, либо причина отказа. */
export type Ack<T> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * Спросить сервер и дождаться ответа. Отказ приезжает как `null` — сокет
 * принадлежит `index.ts`, и всем остальным он виден только этой функцией.
 */
export type Ask = <T>(event: string, payload: unknown) => Promise<({ ok: true } & T) | null>;

// ─────────────────────────────────────────────────────────────────────────
// Профили кодирования
// ─────────────────────────────────────────────────────────────────────────

// Камера — три слоя simulcast: сервер сам выберет, кому какой отдать, а мы
// поверх просим слой явно (см. focusChanged). Ради этого simulcast и нужен:
// на плитке 160px нет смысла принимать 720p, и наоборот.
export const CAM_ENCODINGS = [
  { rid: 'q', maxBitrate: 150_000, scaleResolutionDownBy: 4, scalabilityMode: 'L1T3' },
  { rid: 'h', maxBitrate: 500_000, scaleResolutionDownBy: 2, scalabilityMode: 'L1T3' },
  { rid: 'f', maxBitrate: 1_800_000, scalabilityMode: 'L1T3' },
];

// Демонстрация экрана — наоборот, один жирный слой: текст в мыле нечитаем,
// деградация «в мыло» тут хуже, чем просадка ФПС.
export const SCREEN_ENCODINGS = [{ maxBitrate: 8_000_000, scalabilityMode: 'L1T3' }];

// Потолки Opus те же, что в mesh: голос на «discord-уровне», звук демонстрации
// (музыка/фильм) заметно жирнее — там слышно разницу.
export const MIC_CODEC_OPTIONS = {
  opusStereo: false,
  opusFec: true,
  opusMaxAverageBitrate: 128_000,
};
export const SCREEN_AUDIO_CODEC_OPTIONS = {
  opusStereo: true,
  opusFec: true,
  opusMaxAverageBitrate: 256_000,
};

/** Верхний слой simulcast (индекс), он же «дай максимум». */
export const TOP_SPATIAL_LAYER = 2;

// Слот аудио-дорожки для микшера. Дирижёр различает голос и звук демонстрации
// по порядку этого ключа (в mesh туда идёт `mid`) — здесь мы роль ЗНАЕМ точно,
// она приходит в `source`, поэтому просто отдаём фиксированный порядок.
export const AUDIO_SLOT: Record<string, string> = { mic: '0', 'screen-audio': '1' };
