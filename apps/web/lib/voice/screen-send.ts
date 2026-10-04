'use client';

import type { TileSend } from '@/stores/voice';
import type { TransportHost } from './types';
import { kbps } from './quality';
import { worseUplink, type SendVideo } from './stats';

/**
 * Плашка своей трансляции: что реально уходит, а не что заказано. Одна на оба
 * транспорта — через медиасервер поток один, напрямую он у каждого собеседника
 * свой, но человек на плашке должен видеть одно и то же: что за кадр, сколько
 * кадров и сколько всего уходит с его аплинка.
 */

/**
 * Свести отправку с нескольких соединений (mesh — по одному на собеседника):
 * кадр — самый крупный из реально идущих, байты — сумма, ограничение — худшее.
 */
export function mergeSendVideo(list: (SendVideo | null)[]): SendVideo | null {
  let top: SendVideo | null = null;
  let bytesSent = 0;
  let limit: SendVideo['limit'] = 'ok';
  for (const send of list) {
    if (!send) continue;
    bytesSent += send.bytesSent;
    limit = worseUplink(limit, send.limit);
    if (!top || send.height > top.height) top = send;
  }
  return top && { ...top, bytesSent, limit };
}

export interface ScreenSendMeter {
  /**
   * Показания этого тика. `nobody` — отправлять некому (в прямом канале никто
   * не смотрит): тогда не уходит ничего, и плашка говорит об этом прямо.
   */
  report(send: SendVideo | null, nobody?: boolean): void;
  reset(): void;
}

export function createScreenSendMeter(
  host: Pick<TransportHost, 'setScreenSend' | 'screenOn' | 'videoTrack' | 'screenProfile'>,
): ScreenSendMeter {
  // Байты на прошлом тике — битрейт считается за интервал.
  let before: { bytes: number; at: number } | null = null;

  return {
    report(send, nobody = false) {
      if (!host.screenOn()) {
        before = null;
        host.setScreenSend(null);
        return;
      }
      if (nobody) {
        before = null;
        // Что уйдёт, как только кто-то зайдёт: захват, ужатый до профиля, — а
        // не сырой захват (экран 1440p в канале с потолком 720p уйдёт 720p).
        const s = host.videoTrack()?.getSettings();
        const profile = host.screenProfile();
        host.setScreenSend({
          height: Math.min(s?.height || profile.height, profile.height),
          fps: Math.min(s?.frameRate ? Math.round(s.frameRate) : profile.fps, profile.fps),
          kbps: null,
          codec: null,
          hardware: null,
          limit: 'ok',
          idle: true,
        });
        return;
      }
      if (!send) {
        before = null;
        host.setScreenSend(null);
        return;
      }
      const now = Date.now();
      // Байты упали — ушёл собеседник, и его соединение выпало из суммы: базы
      // для интервала нет, ждём следующего тика.
      const rate =
        before && send.bytesSent >= before.bytes
          ? kbps(send.bytesSent, before.bytes, now - before.at)
          : null;
      before = { bytes: send.bytesSent, at: now };
      const next: TileSend = {
        height: send.height,
        fps: send.fps,
        kbps: rate,
        codec: send.codec,
        hardware: send.hardware,
        limit: send.limit,
      };
      host.setScreenSend(next);
    },

    reset() {
      before = null;
    },
  };
}
