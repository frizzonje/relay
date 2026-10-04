import { describe, expect, it, vi } from 'vitest';
import type { TransportHost } from './types';
import type { SendVideo } from './stats';
import { createScreenSendMeter, mergeSendVideo } from './screen-send';

const send = (height: number, bytesSent: number, extra: Partial<SendVideo> = {}): SendVideo => ({
  width: Math.round((height * 16) / 9),
  height,
  fps: 30,
  bytesSent,
  codec: 'VP8',
  hardware: false,
  limit: 'ok',
  ...extra,
});

function setup(screenOn = true) {
  const setScreenSend = vi.fn();
  const host = {
    setScreenSend,
    screenOn: () => screenOn,
    videoTrack: () => ({ getSettings: () => ({ height: 1440, frameRate: 59.9 }) }),
    screenProfile: () => ({ height: 720, fps: 30, bitrate: 3_000_000 }),
  } as unknown as TransportHost;
  return { meter: createScreenSendMeter(host), setScreenSend };
}

describe('плашка трансляции', () => {
  /**
   * Напрямую поток уходит каждому собеседнику свой: на плашке — их сумма
   * (столько уходит с аплинка), кадр — самый крупный, ограничение — худшее.
   */
  it('mesh: отправка с нескольких соединений сводится в одну', () => {
    expect(
      mergeSendVideo([send(720, 1000), null, send(720, 3000, { limit: 'cpu' })]),
    ).toMatchObject({ height: 720, bytesSent: 4000, limit: 'cpu' });
    expect(mergeSendVideo([])).toBeNull();
  });

  it('битрейт — за интервал между тиками', () => {
    vi.useFakeTimers();
    const { meter, setScreenSend } = setup();
    meter.report(send(1440, 0));
    expect(setScreenSend.mock.lastCall?.[0]).toMatchObject({ height: 1440, kbps: null });
    vi.advanceTimersByTime(1000);
    meter.report(send(1440, 1_000_000));
    expect(setScreenSend.mock.lastCall?.[0]).toMatchObject({ kbps: 8000 });
    vi.useRealTimers();
  });

  /** В прямом канале никого — не уходит ничего, и плашка не изображает эфир. */
  it('некому отправлять — что уйдёт (захват под профилем) и пометка, без битрейта', () => {
    const { meter, setScreenSend } = setup();
    meter.report(null, true);
    expect(setScreenSend).toHaveBeenLastCalledWith(
      expect.objectContaining({ height: 720, fps: 30, kbps: null, idle: true }),
    );
  });

  it('трансляции нет — плашки нет', () => {
    const { meter, setScreenSend } = setup(false);
    meter.report(send(1440, 100));
    expect(setScreenSend).toHaveBeenLastCalledWith(null);
  });
});
