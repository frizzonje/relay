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

  function setup(
    screenOn = true,
    codecs: { kind: string; mimeType: string }[] = [{ kind: 'video', mimeType: 'video/VP8' }],
  ) {
    const mic = { kind: 'audio', readyState: 'live' } as unknown as MediaStreamTrack;
    const screen = {
      kind: 'video',
      readyState: 'live',
      getSettings: () => ({ height: 1440 }),
    } as unknown as MediaStreamTrack;
    let release: (() => void) | null = null;
    const produce = vi.fn(async (opts: ProduceOpts & { codec?: { mimeType: string } }) => {
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
      device: () => ({ canProduce: () => true, rtpCapabilities: { codecs } }) as unknown as Device,
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

describe('кодировщик трансляции', () => {
  const h264 = { kind: 'video', mimeType: 'video/H264' };
  const screen = {
    kind: 'video',
    readyState: 'live',
    getSettings: () => ({ height: 1440 }),
  } as unknown as MediaStreamTrack;

  function setup(powerEfficient: boolean, failH264 = false) {
    vi.stubGlobal('navigator', {
      userAgent: 'Chrome/140',
      mediaCapabilities: {
        encodingInfo: vi.fn(async () => ({ supported: true, smooth: true, powerEfficient })),
      },
    });
    const produce = vi.fn(
      async (opts: { codec?: { mimeType: string }; encodings?: Record<string, unknown>[] }) => {
        if (failH264 && opts.codec) throw new Error('encoder refused');
        return {
          id: 'p',
          kind: 'video',
          track: screen,
          closed: false,
          rtpParameters: { codecs: [{ mimeType: opts.codec?.mimeType ?? 'video/VP8' }] },
          close: vi.fn(),
        };
      },
    );
    const host = {
      localStream: () => null,
      screenAudioTrack: () => null,
      videoTrack: () => screen,
      screenOn: () => true,
      screenProfile: () => ({ height: 1440, fps: 30, bitrate: 8_000_000 }),
      screenDegradation: () => 'maintain-resolution',
      diag: vi.fn(),
    } as unknown as TransportHost;
    const publisher = createPublisher({
      host,
      sendTransport: () => ({ produce }) as unknown as Transport,
      device: () =>
        ({
          canProduce: () => true,
          rtpCapabilities: { codecs: [{ kind: 'video', mimeType: 'video/VP8' }, h264] },
        }) as unknown as Device,
      ask: vi.fn(async () => null),
    });
    return { publisher, produce, host };
  }

  it('аппаратный H264 есть — трансляция уходит им, без временных слоёв', async () => {
    const { publisher, produce } = setup(true);
    await publisher.syncVideo();
    const opts = produce.mock.calls[0][0];
    expect(opts.codec).toEqual(h264);
    expect(opts.encodings?.every((e) => !('scalabilityMode' in e))).toBe(true);
    expect(opts.encodings).toHaveLength(2);
    vi.unstubAllGlobals();
  });

  it('кодирует только процессор — остаёмся на умолчании (VP8)', async () => {
    const { publisher, produce } = setup(false);
    await publisher.syncVideo();
    expect(produce.mock.calls[0][0].codec).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('H264 не поднялся — трансляция всё равно уходит, на умолчании', async () => {
    const { publisher, produce, host } = setup(true, true);
    await publisher.syncVideo();
    expect(produce).toHaveBeenCalledTimes(2);
    expect(produce.mock.calls[1][0].codec).toBeUndefined();
    expect(publisher.count()).toBe(1);
    expect(host.diag).toHaveBeenCalledWith('sfu produce fallback', 'screen video/H264 → default');
    vi.unstubAllGlobals();
  });
});

/**
 * Публикация — запрос к медиасерверу, и пока он летит, роль успевают снять:
 * камеру выключили, показ остановили, транспорт разобрали на пересборке.
 * `closeProducer` и `closeAll` видят только уже опубликованное, так что
 * доехавший следом producer ложился в живые — у зрителей висел замёрзший кадр
 * выключенной камеры, а сервер держал его до следующей сверки.
 */
describe('публикация, которую сняли на лету', () => {
  function setup() {
    const cam = { kind: 'video', readyState: 'live' } as unknown as MediaStreamTrack;
    const mic = { kind: 'audio', readyState: 'live' } as unknown as MediaStreamTrack;
    let video: MediaStreamTrack | null = cam;
    const releases: Array<() => void> = [];
    const made: Array<{ id: string; close: ReturnType<typeof vi.fn> }> = [];
    const produce = vi.fn(
      async (opts: { track: MediaStreamTrack; appData: { source: string } }) => {
        await new Promise<void>((r) => releases.push(r));
        const producer = {
          id: `p-${opts.appData.source}-${made.length}`,
          kind: opts.track.kind,
          track: opts.track,
          closed: false,
          rtpParameters: { codecs: [{ mimeType: 'x' }] },
          replaceTrack: vi.fn(async () => {}),
          close: vi.fn(),
        };
        made.push(producer);
        return producer;
      },
    );
    const ask = vi.fn(async () => null);
    const host = {
      localStream: () => ({ getAudioTracks: () => [mic] }),
      screenAudioTrack: () => null,
      videoTrack: () => video,
      screenOn: () => false,
      diag: vi.fn(),
    } as unknown as TransportHost;
    const publisher = createPublisher({
      host,
      sendTransport: () => ({ produce }) as unknown as Transport,
      device: () => ({ canProduce: () => true }) as unknown as Device,
      ask,
    });
    return {
      publisher,
      produce,
      ask,
      made,
      mic,
      camOff: () => (video = null),
      release: () => releases.shift()?.(),
    };
  }

  it('камеру выключили, пока она публиковалась, — producer закрыт и у сервера', async () => {
    const { publisher, produce, ask, made, camOff, release } = setup();
    const on = publisher.syncVideo();
    await vi.waitFor(() => expect(produce).toHaveBeenCalledTimes(1));
    camOff();
    await publisher.syncVideo();
    release();
    await on;

    expect(publisher.count()).toBe(0);
    expect(made[0].close).toHaveBeenCalled();
    expect(ask).toHaveBeenCalledWith('close-producer', { producerId: made[0].id });
  });

  it('транспорт разобрали посреди публикации — следующая публикуется заново, а не ждёт мёртвую', async () => {
    const { publisher, produce, made, mic, release } = setup();
    const first = publisher.replaceMic(mic);
    await vi.waitFor(() => expect(produce).toHaveBeenCalledTimes(1));
    publisher.closeAll();

    const second = publisher.replaceMic(mic);
    await vi.waitFor(() => expect(produce).toHaveBeenCalledTimes(2));
    release();
    release();
    await Promise.all([first, second]);

    expect(made[0].close).toHaveBeenCalled();
    expect(made[1].close).not.toHaveBeenCalled();
    expect(publisher.count()).toBe(1);
  });
});
