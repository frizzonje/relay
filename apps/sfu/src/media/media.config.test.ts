import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MEDIA_CODECS,
  announcedIp,
  webRtcTransportOptions,
  workerSettings,
} from './media.config';

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

describe('workerSettings', () => {
  it('дефолтный диапазон портов — тот, что открыт в compose', () => {
    const s = workerSettings();
    expect(s.rtcMinPort).toBe(40000);
    expect(s.rtcMaxPort).toBe(40100);
  });

  it('диапазон переопределяется из env', () => {
    process.env.SFU_RTC_MIN_PORT = '50000';
    process.env.SFU_RTC_MAX_PORT = '50500';
    expect(workerSettings()).toMatchObject({ rtcMinPort: 50000, rtcMaxPort: 50500 });
  });

  it('мусор и ноль в env не превращаются в NaN-порт — берём дефолт', () => {
    for (const bad of ['abc', '0', '-1', '   ', '']) {
      process.env.SFU_RTC_MIN_PORT = bad;
      expect(workerSettings().rtcMinPort, bad).toBe(40000);
    }
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

describe('опции транспорта', () => {
  it('слушаем 0.0.0.0, а анонсируем публичный адрес', () => {
    process.env.SFU_ANNOUNCED_IP = '203.0.113.7';
    const o = webRtcTransportOptions();
    for (const info of o.listenInfos!) {
      expect(info.ip).toBe('0.0.0.0');
      expect(info.announcedAddress).toBe('203.0.113.7');
    }
  });

  it('ICE-TCP включён — единственный путь из сетей, где режут UDP', () => {
    const o = webRtcTransportOptions();
    expect(o.enableUdp).toBe(true);
    expect(o.enableTcp).toBe(true);
    expect(o.preferUdp).toBe(true);
    expect(o.listenInfos!.map((i) => i.protocol)).toEqual(['udp', 'tcp']);
  });
});
