import { describe, it, expect } from 'vitest';
import {
  boostVideoBitrate,
  boostAudioBitrate,
  OPUS_MAX_BITRATE,
  SDP_START_BITRATE_KBPS,
  SDP_MIN_BITRATE_KBPS,
  SDP_MAX_BITRATE_KBPS,
} from './sdp';

// Минимальный SDP с одним видеокодеком (VP8 = pt 96) и одним аудио (opus = 111).
const sdp = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=rtpmap:96 VP8/90000',
  'a=fmtp:96 max-fs=12288',
].join('\r\n');

describe('boostVideoBitrate', () => {
  it('undefined/пусто → как есть', () => {
    expect(boostVideoBitrate(undefined)).toBeUndefined();
    expect(boostVideoBitrate('')).toBe('');
  });

  it('дописывает x-google-bitrate только в fmtp видеокодека', () => {
    const out = boostVideoBitrate(sdp)!;
    const lines = out.split('\r\n');
    const videoFmtp = lines.find((l) => l.startsWith('a=fmtp:96'))!;
    const audioFmtp = lines.find((l) => l.startsWith('a=fmtp:111'))!;
    expect(videoFmtp).toContain(`x-google-start-bitrate=${SDP_START_BITRATE_KBPS}`);
    expect(videoFmtp).toContain(`x-google-min-bitrate=${SDP_MIN_BITRATE_KBPS}`);
    expect(videoFmtp).toContain(`x-google-max-bitrate=${SDP_MAX_BITRATE_KBPS}`);
    // аудио не трогаем
    expect(audioFmtp).not.toContain('x-google');
  });

  it('сохраняет CRLF-формат и количество строк', () => {
    const out = boostVideoBitrate(sdp)!;
    expect(out.split('\r\n').length).toBe(sdp.split('\r\n').length);
  });

  it('идемпотентность: повторный вызов не дублирует параметры', () => {
    const once = boostVideoBitrate(sdp)!;
    const twice = boostVideoBitrate(once)!;
    expect(twice).toBe(once);
    expect((twice.match(/x-google-start-bitrate/g) || []).length).toBe(1);
  });

  it('без видеокодеков SDP не меняется', () => {
    const audioOnly = ['v=0', 'm=audio 9 RTP 111', 'a=rtpmap:111 opus/48000/2'].join('\r\n');
    expect(boostVideoBitrate(audioOnly)).toBe(audioOnly);
  });

  it('распознаёт H264/VP9/AV1 (регистронезависимо)', () => {
    const h264 = [
      'm=video 9 RTP 102',
      'a=rtpmap:102 H264/90000',
      'a=fmtp:102 profile-level-id=42e01f',
    ].join('\r\n');
    expect(boostVideoBitrate(h264)).toContain('x-google-start-bitrate');
  });
});

// Голос и звук демонстрации — две аудиолинии, как у собеседника, который
// показывает экран. Opus = 111 в обеих: BUNDLE это разрешает, разведка
// (docs/plans/voice-quality.md) проверила на Chromium, WebKit и Firefox.
const call = [
  'v=0',
  'a=group:BUNDLE 0 1 2',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
  'a=mid:0',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=mid:1',
  'a=rtpmap:96 VP8/90000',
  'a=fmtp:96 max-fs=12288',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
  'a=mid:2',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  '',
].join('\r\n');

/** fmtp Opus в N-й аудиолинии. */
function opusFmtp(sdp: string, audioIndex: number): string {
  const audio = sdp.split(/\r\n(?=m=)/).filter((s) => s.startsWith('m=audio'))[audioIndex];
  return audio.split('\r\n').find((l) => l.startsWith('a=fmtp:111'))!;
}

describe('boostAudioBitrate', () => {
  it('undefined/пусто → как есть', () => {
    expect(boostAudioBitrate(undefined)).toBeUndefined();
    expect(boostAudioBitrate('')).toBe('');
  });

  it('голос — первая аудиолиния — моно: стерео на голосе только тратит битрейт', () => {
    const voice = opusFmtp(boostAudioBitrate(call)!, 0);
    expect(voice).toContain(';stereo=0');
    expect(voice).toContain('sprop-stereo=0');
  });

  it('звук демонстрации — следующие аудиолинии — стерео: там музыка', () => {
    const screen = opusFmtp(boostAudioBitrate(call)!, 1);
    expect(screen).toContain(';stereo=1');
    expect(screen).toContain('sprop-stereo=1');
  });

  it('битрейт, FEC и DTX одинаковы у обеих ролей', () => {
    const out = boostAudioBitrate(call)!;
    for (const fmtp of [opusFmtp(out, 0), opusFmtp(out, 1)]) {
      expect(fmtp).toContain(`maxaveragebitrate=${OPUS_MAX_BITRATE}`);
      expect(fmtp).toContain('useinbandfec=1');
      expect(fmtp).toContain('usedtx=0');
      expect((fmtp.match(/useinbandfec/g) || []).length).toBe(1);
    }
  });

  it('RED и видео не трогает', () => {
    const lines = boostAudioBitrate(call)!.split('\r\n');
    expect(lines.filter((l) => l.startsWith('a=fmtp:63'))).toEqual([
      'a=fmtp:63 111/111',
      'a=fmtp:63 111/111',
    ]);
    expect(lines.find((l) => l.startsWith('a=fmtp:96'))).toBe('a=fmtp:96 max-fs=12288');
  });

  it('слушатель: единственная recvonly-аудиолиния — это голос', () => {
    const listener = [
      'v=0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=recvonly',
      'a=rtpmap:111 opus/48000/2',
    ].join('\r\n');
    expect(boostAudioBitrate(listener)).toContain(';stereo=0');
  });

  it('добавляет a=fmtp сразу после rtpmap, если её не было', () => {
    const noFmtp = ['m=audio 9 RTP 111', 'a=rtpmap:111 opus/48000/2'].join('\r\n');
    const lines = boostAudioBitrate(noFmtp)!.split('\r\n');
    expect(lines[2]).toMatch(/^a=fmtp:111 .*stereo=0/);
  });

  it('идемпотентность: повторный вызов не меняет результат', () => {
    const once = boostAudioBitrate(call)!;
    expect(boostAudioBitrate(once)).toBe(once);
  });

  it('сохраняет CRLF и число строк, если fmtp уже были', () => {
    const out = boostAudioBitrate(call)!;
    expect(out.split('\r\n').length).toBe(call.split('\r\n').length);
    expect(out.endsWith('\r\n')).toBe(true);
  });

  it('без opus SDP не меняется', () => {
    const videoOnly = ['m=video 9 RTP 96', 'a=rtpmap:96 VP8/90000'].join('\r\n');
    expect(boostAudioBitrate(videoOnly)).toBe(videoOnly);
  });
});
