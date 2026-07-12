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

describe('boostAudioBitrate', () => {
  it('undefined/пусто → как есть', () => {
    expect(boostAudioBitrate(undefined)).toBeUndefined();
    expect(boostAudioBitrate('')).toBe('');
  });

  it('навязывает стерео/битрейт/FEC в fmtp opus, видео не трогает', () => {
    const out = boostAudioBitrate(sdp)!;
    const lines = out.split('\r\n');
    const audioFmtp = lines.find((l) => l.startsWith('a=fmtp:111'))!;
    const videoFmtp = lines.find((l) => l.startsWith('a=fmtp:96'))!;
    expect(audioFmtp).toContain('stereo=1');
    expect(audioFmtp).toContain(`maxaveragebitrate=${OPUS_MAX_BITRATE}`);
    expect(audioFmtp).toContain('useinbandfec=1');
    expect(audioFmtp).toContain('usedtx=0');
    // встречный useinbandfec не дублируется
    expect((audioFmtp.match(/useinbandfec/g) || []).length).toBe(1);
    // видеокодек не трогаем
    expect(videoFmtp).not.toContain('stereo');
  });

  it('добавляет a=fmtp, если у opus её не было', () => {
    const noFmtp = ['m=audio 9 RTP 111', 'a=rtpmap:111 opus/48000/2'].join('\r\n');
    const out = boostAudioBitrate(noFmtp)!;
    expect(out).toContain('a=fmtp:111 ');
    expect(out).toContain('stereo=1');
  });

  it('идемпотентность: повторный вызов не меняет результат', () => {
    const once = boostAudioBitrate(sdp)!;
    expect(boostAudioBitrate(once)).toBe(once);
  });

  it('без opus SDP не меняется', () => {
    const videoOnly = ['m=video 9 RTP 96', 'a=rtpmap:96 VP8/90000'].join('\r\n');
    expect(boostAudioBitrate(videoOnly)).toBe(videoOnly);
  });
});
