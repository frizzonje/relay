'use client';

import type {
  DtlsParameters,
  IceParameters,
  RtpCapabilities,
  RtpParameters,
  TransportOptions,
} from 'mediasoup-client/types';
import type { SfuConsumer, SfuEvents, SfuMedia, SfuRequests } from '@relay/shared';

/**
 * Что чем является на проводе между нами и медиасервером.
 *
 * Формы разговора — из контракта (`@relay/shared`, файл `sfu.ts`), вторая его
 * сторона — `apps/sfu`. Здесь те из них, что несут медиатипы, получают типы
 * браузерного `mediasoup-client`; остальные берутся из контракта как есть,
 * под своими именами. Плюс профили кодирования, о которых мы договорились с
 * роутером. Ни состояния, ни зависимостей: этот файл — лист.
 */

/** Медиатипы браузерной стороны. */
export interface ClientMedia extends SfuMedia {
  rtpCapabilities: RtpCapabilities;
  rtpParameters: RtpParameters;
  dtlsParameters: DtlsParameters;
  iceParameters: IceParameters;
  transportParams: TransportOptions;
}

export type ConsumerPayload = SfuConsumer<ClientMedia>;
export type ServerEvents = SfuEvents<ClientMedia>;
export type WelcomePayload = ServerEvents['welcome'];
export type Requests = SfuRequests<ClientMedia>;

/**
 * Спросить сервер и дождаться ответа. Имя запроса, его тело и ответ сверяются
 * с контрактом. Отказ приезжает как `null` — сокет принадлежит `index.ts`, и
 * всем остальным он виден только этой функцией.
 */
export type Ask = <E extends keyof Requests>(
  event: E,
  payload: Requests[E][0],
) => Promise<({ ok: true } & Requests[E][1]) | null>;

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

// Демонстрация экрана — два слоя под профиль трансляции, их считает
// `screen-profile.ts`: размер и кадры там зависят от режима и от владельца.

// Звук — первым в очередь на аплинке: и приоритет кодировщика, и DSCP-метка.
export const AUDIO_ENCODINGS = [{ priority: 'high', networkPriority: 'high' }] as {
  priority: RTCPriorityType;
  networkPriority: RTCPriorityType;
}[];

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

/** У трансляции слоёв два (см. screen-profile.ts): верхний — первый. */
export const SCREEN_TOP_LAYER = 1;

// Слот аудио-дорожки для микшера. Дирижёр различает голос и звук демонстрации
// по порядку этого ключа (в mesh туда идёт `mid`) — здесь мы роль ЗНАЕМ точно,
// она приходит в `source`, поэтому просто отдаём фиксированный порядок.
export const AUDIO_SLOT: Record<string, string> = { mic: '0', 'screen-audio': '1' };
