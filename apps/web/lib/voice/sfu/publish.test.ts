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
