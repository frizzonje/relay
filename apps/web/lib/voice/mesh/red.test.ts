import { afterEach, describe, expect, it, vi } from 'vitest';
import { preferRedForVoice, redFirst } from './red';

/**
 * RED — только голосу и только там, где браузер его умеет. Каждый отказ здесь
 * обязан быть тихим: переговоры без RED — это просто сегодняшний звонок, а
 * исключение из этого модуля уронило бы переговоры целиком.
 */

const opus = { mimeType: 'audio/opus', clockRate: 48000, channels: 2, sdpFmtpLine: 'minptime=10' };
const red = { mimeType: 'audio/red', clockRate: 48000, channels: 2, sdpFmtpLine: '111/111' };
const pcmu = { mimeType: 'audio/PCMU', clockRate: 8000 };

function transceiver(kind: 'audio' | 'video', mid: string | null, direction = 'sendrecv') {
  return {
    mid,
    direction,
    currentDirection: direction === 'stopped' ? 'stopped' : null,
    receiver: { track: { kind } },
    setCodecPreferences: vi.fn(),
  };
}

const pcWith = (...ts: ReturnType<typeof transceiver>[]) =>
  ({ getTransceivers: () => ts }) as unknown as RTCPeerConnection;

function capabilities(codecs: object[] | null) {
  vi.stubGlobal('RTCRtpReceiver', {
    getCapabilities: () => (codecs ? { codecs, headerExtensions: [] } : null),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('redFirst', () => {
  it('ставит RED первым и не теряет остальных', () => {
    expect(redFirst([opus, red, pcmu] as never)).toEqual([red, opus, pcmu]);
  });

  it('без RED — null: трогать нечего', () => {
    expect(redFirst([opus, pcmu] as never)).toBeNull();
  });

  it('регистр mimeType не важен', () => {
    const upper = { ...red, mimeType: 'audio/RED' };
    expect(redFirst([opus, upper] as never)![0]).toBe(upper);
  });
});

describe('preferRedForVoice', () => {
  it('RED получает только голос — аудио с наименьшим mid', () => {
    capabilities([opus, red, pcmu]);
    const screen = transceiver('audio', '2');
    const video = transceiver('video', '1');
    const voice = transceiver('audio', '0');
    preferRedForVoice(pcWith(screen, video, voice));
    expect(voice.setCodecPreferences).toHaveBeenCalledWith([red, opus, pcmu]);
    expect(screen.setCodecPreferences).not.toHaveBeenCalled();
    expect(video.setCodecPreferences).not.toHaveBeenCalled();
  });

  it('mid сравниваются числами: «10» позже «9»', () => {
    capabilities([opus, red]);
    const ten = transceiver('audio', '10');
    const nine = transceiver('audio', '9');
    preferRedForVoice(pcWith(ten, nine));
    expect(nine.setCodecPreferences).toHaveBeenCalled();
    expect(ten.setCodecPreferences).not.toHaveBeenCalled();
  });

  it('до первых переговоров mid нет — голос первый аудиотрансивер', () => {
    capabilities([opus, red]);
    const first = transceiver('audio', null);
    const second = transceiver('audio', null);
    preferRedForVoice(pcWith(first, second));
    expect(first.setCodecPreferences).toHaveBeenCalled();
    expect(second.setCodecPreferences).not.toHaveBeenCalled();
  });

  it('новый трансивер без mid не отбирает роль у голоса', () => {
    capabilities([opus, red]);
    const fresh = transceiver('audio', null);
    const voice = transceiver('audio', '0');
    preferRedForVoice(pcWith(fresh, voice));
    expect(voice.setCodecPreferences).toHaveBeenCalled();
    expect(fresh.setCodecPreferences).not.toHaveBeenCalled();
  });

  it('остановленный трансивер не в счёт', () => {
    capabilities([opus, red]);
    const stopped = transceiver('audio', '0', 'stopped');
    const live = transceiver('audio', '3');
    preferRedForVoice(pcWith(stopped, live));
    expect(live.setCodecPreferences).toHaveBeenCalled();
    expect(stopped.setCodecPreferences).not.toHaveBeenCalled();
  });

  it('браузер без RED (Firefox) — ничего не делает', () => {
    capabilities([opus, pcmu]);
    const voice = transceiver('audio', '0');
    preferRedForVoice(pcWith(voice));
    expect(voice.setCodecPreferences).not.toHaveBeenCalled();
  });

  it('нет getCapabilities или setCodecPreferences — ничего не делает и не падает', () => {
    const voice = { ...transceiver('audio', '0'), setCodecPreferences: undefined };
    capabilities([opus, red]);
    expect(() => preferRedForVoice(pcWith(voice as never))).not.toThrow();
    vi.stubGlobal('RTCRtpReceiver', {});
    const other = transceiver('audio', '0');
    expect(() => preferRedForVoice(pcWith(other))).not.toThrow();
    expect(other.setCodecPreferences).not.toHaveBeenCalled();
  });

  it('отказ браузера не роняет переговоры', () => {
    capabilities([opus, red]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const voice = transceiver('audio', '0');
    voice.setCodecPreferences.mockImplementation(() => {
      throw new Error('InvalidModificationError');
    });
    expect(() => preferRedForVoice(pcWith(voice))).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});
