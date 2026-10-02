import { describe, expect, it, vi } from 'vitest';
import type { Device, Transport } from 'mediasoup-client/types';
import type { TransportHost } from '../types';
import type { ProducerInfo } from './protocol';
import { createSubscriber } from './subscribe';

vi.mock('@/lib/i18n', () => ({ tx: (key: string) => key }));
vi.stubGlobal('MediaStream', class {});

/**
 * Трансляция через медиасервер идёт к зрителю только по его просьбе.
 *
 * Это не косметика, а канал сервера: 1440p — это ~8–10 Мбит/с на каждого, кто
 * его получает, и в канале на десятерых раздавать его всем подряд значит
 * класть порт сервера ради тех, кто трансляцию даже не открывал.
 */
function setup() {
  const watch = new Map<string, string | null>();
  const host = {
    addTile: vi.fn(),
    removeTile: vi.fn(),
    setTileState: vi.fn(),
    setTileWatch: vi.fn((id: string, state: string | null) => watch.set(id, state)),
    attachRemoteAudio: vi.fn(),
    detachRemoteAudio: vi.fn(),
    diag: vi.fn(),
  } as unknown as TransportHost;
  const asked: { event: string; payload: { producerId?: string; consumerId?: string } }[] = [];
  const ask = vi.fn(async (event: string, payload: { producerId?: string }) => {
    asked.push({ event, payload });
    if (event === 'consume') {
      return {
        ok: true,
        consumer: {
          id: `c-${payload.producerId}`,
          producerId: payload.producerId,
          kind: payload.producerId?.includes('audio') ? 'audio' : 'video',
          rtpParameters: {},
          source: payload.producerId?.split(':')[1],
        },
      };
    }
    return { ok: true };
  });
  const transport = {
    id: 'recv',
    consume: vi.fn(async (o: { id: string; producerId: string; kind: string }) => ({
      id: o.id,
      producerId: o.producerId,
      kind: o.kind,
      closed: false,
      track: { muted: false, addEventListener: vi.fn() },
      close: vi.fn(),
    })),
  };
  const subscriber = createSubscriber({
    host,
    recvTransport: () => transport as unknown as Transport,
    device: () => ({ rtpCapabilities: {} }) as unknown as Device,
    ask: ask as never,
    linked: () => true,
  });
  const consumed = () =>
    asked.filter((a) => a.event === 'consume').map((a) => a.payload.producerId);
  const byEvent = (event: string) =>
    asked.filter((a) => a.event === event).map((a) => a.payload) as Record<string, unknown>[];
  return { subscriber, watch, consumed, asked: byEvent };
}

const info = (peer: string, source: ProducerInfo['source']): ProducerInfo => ({
  id: `${peer}:${source}`,
  kind: source === 'mic' || source === 'screen-audio' ? 'audio' : 'video',
  source,
});

describe('трансляция по кнопке «Смотреть»', () => {
  it('голос и камера приходят сразу, трансляция — только предлагается', async () => {
    const { subscriber, watch, consumed } = setup();
    subscriber.addPeer('a', 'Аня');
    await subscriber.consume('a', info('a', 'mic'));
    await subscriber.consume('a', info('a', 'screen'));
    await subscriber.consume('a', info('a', 'screen-audio'));

    expect(consumed()).toEqual(['a:mic']);
    expect(watch.get('a')).toBe('offered');
  });

  it('«Смотреть» подписывает на экран и его звук — экран первым', async () => {
    const { subscriber, watch, consumed } = setup();
    subscriber.addPeer('a', 'Аня');
    await subscriber.consume('a', info('a', 'screen-audio'));
    await subscriber.consume('a', info('a', 'screen'));

    await subscriber.watch('a');

    expect(consumed()).toEqual(['a:screen', 'a:screen-audio']);
    expect(watch.get('a')).toBe('watching');
  });

  it('«Перестать смотреть» снимает подписки и снова предлагает', async () => {
    const { subscriber, watch, asked } = setup();
    subscriber.addPeer('a', 'Аня');
    await subscriber.consume('a', info('a', 'mic'));
    await subscriber.consume('a', info('a', 'screen'));
    await subscriber.watch('a');

    subscriber.unwatch('a');

    expect(subscriber.entries().map((e) => e.source)).toEqual(['mic']);
    expect(watch.get('a')).toBe('offered');
    // Закрыть у себя мало: сервер слал бы поток дальше в пустоту.
    expect(asked('close-consumer')).toEqual([{ consumerId: 'c-a:screen' }]);
  });

  it('«Перестать» посреди подписки — поток не приходит, серверу сказано', async () => {
    const { subscriber, asked } = setup();
    subscriber.addPeer('a', 'Аня');
    await subscriber.consume('a', info('a', 'screen'));

    const watching = subscriber.watch('a');
    subscriber.unwatch('a');
    await watching;

    expect(subscriber.entries()).toEqual([]);
    expect(asked('close-consumer')).toEqual([{ consumerId: 'c-a:screen' }]);
    expect(asked('resume')).toHaveLength(0);
  });

  /**
   * Стример сменил окно, или сеть моргнула и дорожку заменили: старый
   * producer закрыт, новый объявлен. Зритель остаётся зрителем — второй раз
   * жать «Смотреть» ради того же показа он не должен.
   */
  it('перезапущенный показ того, кого смотрим, приходит сам', async () => {
    const { subscriber, watch, consumed } = setup();
    subscriber.addPeer('a', 'Аня');
    await subscriber.consume('a', info('a', 'screen'));
    await subscriber.watch('a');

    subscriber.producerClosed('a:screen');
    expect(watch.get('a')).toBeNull();
    await subscriber.consume('a', { ...info('a', 'screen'), id: 'a:screen:2' });

    expect(consumed()).toEqual(['a:screen', 'a:screen:2']);
    expect(watch.get('a')).toBe('watching');
  });

  it('выбор зрителя — у каждого собеседника свой', async () => {
    const { subscriber, watch, consumed } = setup();
    subscriber.addPeer('a', 'Аня');
    subscriber.addPeer('b', 'Боря');
    await subscriber.consume('a', info('a', 'screen'));
    await subscriber.consume('b', info('b', 'screen'));

    await subscriber.watch('b');

    expect(consumed()).toEqual(['b:screen']);
    expect(watch.get('a')).toBe('offered');
  });

  it('ушедший собеседник уносит и выбор: вернулся — снова предложение', async () => {
    const { subscriber, watch, consumed } = setup();
    subscriber.addPeer('a', 'Аня');
    await subscriber.consume('a', info('a', 'screen'));
    await subscriber.watch('a');
    subscriber.dropPeer('a');

    subscriber.addPeer('a', 'Аня');
    await subscriber.consume('a', { ...info('a', 'screen'), id: 'a:screen:2' });

    expect(consumed()).toEqual(['a:screen']);
    expect(watch.get('a')).toBe('offered');
  });
});

describe('слой трансляции по размеру плитки', () => {
  async function watching() {
    const env = setup();
    env.subscriber.addPeer('a', 'Аня');
    await env.subscriber.consume('a', info('a', 'screen'));
    return env;
  }

  it('размер ещё неизвестен — нижний слой: дешёвое умолчание лучше дорогого', async () => {
    const { subscriber, asked } = await watching();
    await subscriber.watch('a');
    expect(asked('preferred-layers')).toEqual([{ consumerId: 'c-a:screen', spatialLayer: 0 }]);
    expect(asked('resume')).toHaveLength(1);
  });

  it('крупная плитка — верхний слой, обратно в сетку — нижний', async () => {
    const { subscriber, asked } = await watching();
    await subscriber.watch('a');
    subscriber.setView('a', 1600);
    subscriber.setView('a', 1600); // тот же размер — без лишнего запроса
    subscriber.setView('a', 400);
    expect(asked('preferred-layers').map((p) => p.spatialLayer)).toEqual([0, 1, 0]);
  });

  /**
   * Развернул другую плитку — трансляция свёрнута. Сервер её не шлёт, пока
   * она не покажется снова; подписка при этом живёт, новой не нужно.
   */
  it('невидимую плитку сервер придерживает, показалась — отпускает', async () => {
    const { subscriber, asked } = await watching();
    await subscriber.watch('a');
    subscriber.setView('a', 0);
    subscriber.setView('a', 600);
    expect(asked('pause')).toHaveLength(1);
    expect(asked('resume')).toHaveLength(2);
  });

  it('подписка на трансляцию, которую сейчас не видно, с паузы не отпускается', async () => {
    const { subscriber, asked } = await watching();
    subscriber.setView('a', 0);
    await subscriber.watch('a');
    expect(asked('resume')).toHaveLength(0);
    subscriber.setView('a', 900);
    expect(asked('resume')).toHaveLength(1);
    expect(asked('preferred-layers').at(-1)?.spatialLayer).toBe(1);
  });
});
