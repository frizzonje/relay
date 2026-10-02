import { describe, it, expect, vi } from 'vitest';
import type { Device, Transport } from 'mediasoup-client/types';
import type { TransportHost } from '../types';
import { createPublisher } from './publish';

vi.mock('@/stores/config', () => ({ setting: () => 128 }));

/**
 * Дорожками владеет приложение, а не mediasoup-client.
 *
 * По умолчанию (`stopTracks: true`) он сам зовёт `track.stop()`, закрывая
 * producer, — а закрывает он его на ЛЮБОМ разборе транспорта: переезд,
 * реконнект сокета, пересборка лестницей. Остановленная из кода дорожка не шлёт
 * `ended`, так что этого не замечал никто: следующая публикация падала с «track
 * ended», и звонок оставался немым до перезахода (overhype, 17.09: демонстрация
 * на троих — и тишина у всех). Флаг легко потерять при правке `produce`, и
 * вернётся тогда ровно та же тишина, — поэтому он под тестом.
 */
describe('публикация своих дорожек', () => {
  it('не отдаёт mediasoup-client права гасить наши дорожки', async () => {
    const mic = { kind: 'audio', readyState: 'live' } as unknown as MediaStreamTrack;
    const produce = vi.fn(async (_opts: { stopTracks?: boolean }) => ({
      id: 'p1',
      kind: 'audio',
      closed: false,
      rtpParameters: { codecs: [{ mimeType: 'audio/opus' }] },
      close: vi.fn(),
    }));
    const host = {
      localStream: () => ({ getAudioTracks: () => [mic] }),
      screenAudioTrack: () => null,
      videoTrack: () => null,
      screenOn: () => false,
      diag: vi.fn(),
    } as unknown as TransportHost;
    const publisher = createPublisher({
      host,
      sendTransport: () => ({ produce }) as unknown as Transport,
      device: () => ({ canProduce: () => true }) as unknown as Device,
      ask: vi.fn(async () => null),
    });

    expect(await publisher.publishLocal()).toBe(true);
    expect(produce).toHaveBeenCalledTimes(1);
    expect(produce.mock.calls[0][0]).toMatchObject({ stopTracks: false });
  });
});

describe('трансляция и приоритеты', () => {
  type ProduceOpts = {
    track: MediaStreamTrack;
    encodings?: Record<string, unknown>[];
    appData: { source: string };
  };

  function setup(screenOn = true) {
    const mic = { kind: 'audio', readyState: 'live' } as unknown as MediaStreamTrack;
    const screen = {
      kind: 'video',
      readyState: 'live',
      getSettings: () => ({ height: 1440 }),
    } as unknown as MediaStreamTrack;
    let release: (() => void) | null = null;
    const produce = vi.fn(async (opts: ProduceOpts) => {
      // Сервер отвечает не сразу — ровно в это окно и влезает вторая публикация.
      if (opts.appData.source === 'screen') await new Promise<void>((r) => (release = r));
      return {
        id: `p-${opts.appData.source}-${produce.mock.calls.length}`,
        kind: opts.track.kind,
        track: opts.track,
        closed: false,
        rtpParameters: { codecs: [{ mimeType: 'video/VP8' }] },
        replaceTrack: vi.fn(async () => {}),
        close: vi.fn(),
      };
    });
    const host = {
      localStream: () => ({ getAudioTracks: () => [mic] }),
      screenAudioTrack: () => null,
      videoTrack: () => (screenOn ? screen : null),
      screenOn: () => screenOn,
      screenProfile: () => ({ height: 1440, fps: 45, bitrate: 10_000_000 }),
      screenDegradation: () => 'maintain-resolution',
      diag: vi.fn(),
    } as unknown as TransportHost;
    const publisher = createPublisher({
      host,
      sendTransport: () => ({ produce }) as unknown as Transport,
      device: () => ({ canProduce: () => true }) as unknown as Device,
      ask: vi.fn(async () => null),
    });
    return { publisher, produce, release: () => release?.() };
  }

  it('экран уходит двумя слоями по профилю, голос — с высоким приоритетом', async () => {
    const { publisher, produce, release } = setup();
    const done = publisher.publishLocal();
    await vi.waitFor(() => expect(produce).toHaveBeenCalledTimes(2));
    release();
    await done;

    const bySource = (source: string) =>
      produce.mock.calls.find(([o]) => o.appData.source === source)![0];
    expect(bySource('mic').encodings).toEqual([{ priority: 'high', networkPriority: 'high' }]);
    expect(bySource('screen').encodings).toMatchObject([
      { rid: 'l', scaleResolutionDownBy: 2, maxFramerate: 30 },
      { rid: 'f', scaleResolutionDownBy: 1, maxFramerate: 45, maxBitrate: 10_000_000 },
    ]);
  });

  /**
   * Сверка после обрыва публикует своё заново, пока первая публикация экрана
   * ещё ждёт ответа сервера. Раньше обе проходили проверку «уже течёт», и одна
   * из них кодировалась сиротой — двойная нагрузка на процессор и аплинк.
   */
  it('роль, которая уже публикуется, второй раз не публикуется', async () => {
    const { publisher, produce, release } = setup();
    const first = publisher.syncVideo();
    await vi.waitFor(() => expect(produce).toHaveBeenCalledTimes(1));
    const second = publisher.syncVideo();
    release();
    await Promise.all([first, second]);

    expect(produce.mock.calls.filter(([o]) => o.appData.source === 'screen')).toHaveLength(1);
    expect(publisher.count()).toBe(1);
  });
});
