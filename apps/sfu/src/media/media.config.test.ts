import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MEDIA_CODECS,
  announcedIp,
  rtcPortCount,
  rtcPortRange,
  webRtcServerOptions,
  webRtcTransportOptions,
  workerSettings,
} from './media.config';
import type { types } from 'mediasoup';

/**
 * Настройки медиа. Каждая проверка здесь стоит за конкретным «слышно, но не
 * видно»: профиль H264, анонсируемый адрес и ICE-TCP — три места, где ошибка не
 * даёт ни ошибки, ни лога, только молчащую картинку у одного собеседника.
 */

const ENV = [
  'SFU_ANNOUNCED_IP',
  'TURN_EXTERNAL_IP',
  'SERVER_HOST',
  'SFU_RTC_MIN_PORT',
  'SFU_RTC_MAX_PORT',
] as const;

beforeEach(() => {
  for (const k of ENV) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
});

describe('кодеки роутера', () => {
  it('H264 объявлен профилем, который отдают все — включая WebKit', () => {
    const h264 = MEDIA_CODECS.find((c) => c.mimeType === 'video/H264')!;
    // Прежний Main 5.0 (4d0032) WebKit для WebRTC не предлагает — с ним видео с
    // десктопной оболочки на macOS молча не уходило, а звук шёл.
    expect(h264.parameters!['profile-level-id']).toBe('42e01f');
    expect(h264.parameters!['level-asymmetry-allowed']).toBe(1);
    expect(h264.parameters!['packetization-mode']).toBe(1);
  });

  it('opus объявлен со стерео — иначе звук демонстрации экрана схлопнется', () => {
    const opus = MEDIA_CODECS.find((c) => c.mimeType === 'audio/opus')!;
    expect(opus.channels).toBe(2);
    expect(opus.parameters!['sprop-stereo']).toBe(1);
    expect(opus.parameters!.useinbandfec).toBe(1);
  });

  it('видео покрыто VP8, VP9 и H264 — роутер не транскодит, это и есть пересечение', () => {
    const video = MEDIA_CODECS.filter((c) => c.kind === 'video').map((c) => c.mimeType);
    expect(video).toEqual(['video/VP8', 'video/VP9', 'video/H264']);
  });
});

describe('порты', () => {
  it('дефолтный диапазон — тот, что открыт в compose и install.sh', () => {
    expect(rtcPortRange()).toEqual({ min: 40000, max: 40100 });
    expect(rtcPortCount()).toBe(101);
  });

  it('диапазон переопределяется из env', () => {
    process.env.SFU_RTC_MIN_PORT = '50000';
    process.env.SFU_RTC_MAX_PORT = '50500';
    expect(rtcPortRange()).toEqual({ min: 50000, max: 50500 });
  });

  it('мусор и ноль в env не превращаются в NaN-порт — берём дефолт', () => {
    for (const bad of ['abc', '0', '-1', '   ', '']) {
      process.env.SFU_RTC_MIN_PORT = bad;
      expect(rtcPortRange().min, bad).toBe(40000);
    }
  });

  it('перевёрнутый диапазон — ноль портов, а не отрицательное число', () => {
    process.env.SFU_RTC_MIN_PORT = '40100';
    process.env.SFU_RTC_MAX_PORT = '40000';
    expect(rtcPortCount()).toBe(0);
  });

  it('воркер больше не берёт порты из диапазона — у него свой WebRtcServer', () => {
    expect(workerSettings()).not.toHaveProperty('rtcMinPort');
    expect(workerSettings()).not.toHaveProperty('rtcMaxPort');
  });
});

describe('анонсируемый адрес', () => {
  it('без настроек — ничего: пусть mediasoup решает сам', () => {
    expect(announcedIp()).toBeUndefined();
  });

  it('SFU_ANNOUNCED_IP приоритетнее TURN_EXTERNAL_IP', () => {
    process.env.TURN_EXTERNAL_IP = '198.51.100.1';
    process.env.SFU_ANNOUNCED_IP = '203.0.113.7';
    expect(announcedIp()).toBe('203.0.113.7');
  });

  it('переиспользуем адрес coturn — грабли у них одни', () => {
    process.env.TURN_EXTERNAL_IP = '198.51.100.1';
    expect(announcedIp()).toBe('198.51.100.1');
  });

  it('IP-литерал в SERVER_HOST годится, а доменное имя — нет', () => {
    process.env.SERVER_HOST = '203.0.113.9';
    expect(announcedIp()).toBe('203.0.113.9');
    process.env.SERVER_HOST = 'relay.example';
    expect(announcedIp()).toBeUndefined();
    process.env.SERVER_HOST = 'localhost';
    expect(announcedIp()).toBeUndefined();
  });
});

describe('WebRtcServer и транспорт', () => {
  it('воркер i слушает min + i — UDP и TCP на одном номере', () => {
    const o = webRtcServerOptions(3);
    expect(o.listenInfos.map((i) => [i.protocol, i.port])).toEqual([
      ['udp', 40003],
      ['tcp', 40003],
    ]);
  });

  it('слушаем 0.0.0.0, а анонсируем публичный адрес', () => {
    process.env.SFU_ANNOUNCED_IP = '203.0.113.7';
    for (const info of webRtcServerOptions(0).listenInfos) {
      expect(info.ip).toBe('0.0.0.0');
      expect(info.announcedAddress).toBe('203.0.113.7');
    }
  });

  it('транспорт садится на сервер воркера и держит ICE-TCP', () => {
    const server = { id: 'srv' } as unknown as types.WebRtcServer;
    const o = webRtcTransportOptions(server) as types.WebRtcTransportOptions & {
      webRtcServer: types.WebRtcServer;
    };
    expect(o.webRtcServer).toBe(server);
    expect(o).not.toHaveProperty('listenInfos');
    expect(o.enableUdp).toBe(true);
    expect(o.enableTcp).toBe(true);
    expect(o.preferUdp).toBe(true);
  });
});
