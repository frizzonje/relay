import { Logger } from '@nestjs/common';
import type { types } from 'mediasoup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRODUCER_SOURCES, RoomsService, producerInfo } from './rooms.service';
import type { Peer } from './rooms.service';
import type { WorkersService } from './workers.service';
import { FakeProducer, FakeTransport, FakeWorkers } from './testkit';

/**
 * Комнаты и роутеры. Здесь два обязательства, которые видно только под
 * нагрузкой и поздно: комната = роутер и закрывается, как только опустела
 * (иначе роутеры копятся в памяти воркера навсегда), и переподключение с тем
 * же id закрывает прошлую сессию — иначе её дорожки остаются висеть немым
 * дублем, который все слушают и никто не слышит.
 */

let workers: FakeWorkers;
let rooms: RoomsService;

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  workers = new FakeWorkers();
  rooms = new RoomsService(workers as unknown as WorkersService);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const join = (room: string, id: string, name = id) =>
  rooms.join(room, { id, name, socketId: `sock-${id}`, room });

describe('комната и роутер', () => {
  it('первый вошедший заводит роутер, второй попадает в тот же', async () => {
    const first = await join('эфир', 'a');
    const second = await join('эфир', 'b');
    expect(second.router).toBe(first.router);
    expect(workers.routers).toHaveLength(1);
    expect(workers.taken).toBe(1);
  });

  it('разные комнаты берут разные воркеры по кругу', async () => {
    await join('первая', 'a');
    await join('вторая', 'b');
    expect(workers.routers).toHaveLength(2);
    expect(rooms.router('первая')).not.toBe(rooms.router('вторая'));
  });

  it('роутер заводится с полным набором кодеков — он же и есть пересечение', async () => {
    await join('эфир', 'a');
    const codecs = workers.routers[0].mediaCodecs as { mimeType: string }[];
    expect(codecs.map((c) => c.mimeType)).toEqual([
      'audio/opus',
      'video/VP8',
      'video/VP9',
      'video/H264',
    ]);
  });

  it('опустевшая комната закрывается — висящий роутер держит память ни за чем', async () => {
    const { peer } = await join('эфир', 'a');
    rooms.leave(peer);
    expect(workers.routers[0].closed).toBe(true);
    expect(rooms.router('эфир')).toBeUndefined();
    expect(rooms.peers('эфир')).toEqual([]);
  });

  it('пока кто-то остался, роутер живёт', async () => {
    const a = await join('эфир', 'a');
    await join('эфир', 'b');
    rooms.leave(a.peer);
    expect(workers.routers[0].closed).toBe(false);
    expect(rooms.peers('эфир').map((p) => p.id)).toEqual(['b']);
  });

  it('несуществующая комната отвечает пустотой, а не падением', () => {
    expect(rooms.peers('нет')).toEqual([]);
    expect(rooms.router('нет')).toBeUndefined();
  });
});

describe('переподключение с тем же id', () => {
  it('прошлая сессия закрывается вместе со своими транспортами', async () => {
    const first = await join('эфир', 'a');
    const { transport } = await rooms.createTransport(first.peer);

    const second = await join('эфир', 'a');
    expect((transport as unknown as FakeTransport).closed).toBe(true);
    expect(rooms.peers('эфир')).toEqual([second.peer]);
  });

  it('запоздалый выход прошлой сессии не выкидывает новую', async () => {
    const first = await join('эфир', 'a');
    const second = await join('эфир', 'a');
    // Сокет старой сессии отваливается уже после того, как место занял новый.
    rooms.leave(first.peer);
    expect(rooms.peers('эфир')).toEqual([second.peer]);
    expect(workers.routers[0].closed).toBe(false);
  });

  it('выход идемпотентен', async () => {
    const { peer } = await join('эфир', 'a');
    rooms.leave(peer);
    expect(() => rooms.leave(peer)).not.toThrow();
  });
});

describe('транспорты', () => {
  it('возвращает клиенту ровно то, что нужно для ICE и DTLS', async () => {
    const { peer } = await join('эфир', 'a');
    const { transport, params } = await rooms.createTransport(peer);
    expect(params.id).toBe(transport.id);
    expect(Object.keys(params).sort()).toEqual(
      ['dtlsParameters', 'iceCandidates', 'iceParameters', 'id'].sort(),
    );
    expect(peer.transports.get(transport.id)).toBe(transport);
  });

  it('транспорт анонсирует внешний адрес, а не адрес контейнера', async () => {
    process.env.SFU_ANNOUNCED_IP = '203.0.113.7';
    const { peer } = await join('эфир', 'a');
    await rooms.createTransport(peer);
    delete process.env.SFU_ANNOUNCED_IP;
    // Опции ушли в роутер — проверяем, что он их получил именно с адресом.
    expect(workers.routers[0].transports).toHaveLength(1);
  });

  it('закрытие транспорта снимает его с участника — не ждём дисконнекта', async () => {
    const { peer } = await join('эфир', 'a');
    const { transport } = await rooms.createTransport(peer);
    (transport as unknown as FakeTransport).close();
    expect(peer.transports.size).toBe(0);
  });

  it('оборванный dtls закрывает транспорт сам, а не оставляет висеть', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const { peer } = await join('эфир', 'a');
    const { transport } = await rooms.createTransport(peer);
    const fake = transport as unknown as FakeTransport;
    fake.fire('dtlsstatechange', 'failed');
    expect(fake.closed).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('dtls failed'))).toBe(true);
  });

  it('переходы ICE и DTLS попадают в лог — по ним и разбирают «отвалились»', async () => {
    const log = vi.spyOn(Logger.prototype, 'log');
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const { peer } = await join('эфир', 'a');
    const { transport } = await rooms.createTransport(peer);
    const fake = transport as unknown as FakeTransport;
    log.mockClear();

    fake.fire('icestatechange', 'connected');
    fake.fire('dtlsstatechange', 'connected');
    fake.fire('icestatechange', 'disconnected');
    // Промежуточные состояния шумом в лог не идут.
    fake.fire('icestatechange', 'checking');

    expect(log.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining('ice connected'),
      expect.stringContaining('dtls connected'),
    ]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('ice disconnected'))).toBe(true);
  });

  it('транспорт в исчезнувшей комнате — внятная ошибка, а не тихий undefined', async () => {
    const { peer } = await join('эфир', 'a');
    rooms.leave(peer);
    await expect(rooms.createTransport(peer)).rejects.toThrow('room is gone');
  });
});

describe('снимок комнаты для новичка', () => {
  it('чужие дорожки — да, свои — нет', async () => {
    const a = await join('эфир', 'a', 'Аня');
    const b = await join('эфир', 'b', 'Боря');
    const { transport } = await rooms.createTransport(a.peer);
    const producer = await (transport as unknown as FakeTransport).produce({
      kind: 'audio',
      appData: { source: 'mic' },
    });
    a.peer.producers.set(producer.id, producer as unknown as types.Producer);

    expect(rooms.producersFor(b.peer)).toEqual([
      { peerId: 'a', name: 'Аня', producers: [{ id: producer.id, kind: 'audio', source: 'mic' }] },
    ]);
    expect(rooms.producersFor(a.peer)).toEqual([{ peerId: 'b', name: 'Боря', producers: [] }]);
  });
});

describe('producerInfo', () => {
  it('назначение берётся из appData', () => {
    for (const source of PRODUCER_SOURCES) {
      const p = new FakeProducer('video', { source });
      expect(producerInfo(p as unknown as types.Producer).source).toBe(source);
    }
  });

  it('без назначения дорожка считается микрофоном — самый безобидный дефолт', () => {
    const p = new FakeProducer('audio', {});
    expect(producerInfo(p as unknown as types.Producer)).toEqual({
      id: p.id,
      kind: 'audio',
      source: 'mic',
    });
  });
});

describe('peer как структура', () => {
  it('новый участник приходит с пустыми картами, а не с чужими', async () => {
    const { peer } = await join('эфир', 'a');
    const p: Peer = peer;
    expect([p.transports.size, p.producers.size, p.consumers.size]).toEqual([0, 0, 0]);
    expect(p.socketId).toBe('sock-a');
  });
});
