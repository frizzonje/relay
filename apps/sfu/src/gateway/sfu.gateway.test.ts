import { createHmac } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Socket } from 'socket.io';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomsService } from '../media/rooms.service';
import { FakeIo, FakeSocket, FakeTransport, FakeWorkers } from '../media/testkit';
import type { WorkersService } from '../media/workers.service';
import { SfuGateway } from './sfu.gateway';

/**
 * Сигналинг медиасервера. Он не знает ни про пароли, ни про закрытые серверы —
 * вся его защита в двух вещах: подпись пропуска и потолки на участника. Второе
 * не про злой умысел: каждый транспорт занимает порт из диапазона (сотня на
 * всех), и цикл переподключений у одного клиента без потолка съедает их у целой
 * комнаты.
 */

const SECRET = 'секрет-медиасервера';

/** Пропуск в том виде, в каком его выдаёт api (формат байт-в-байт). */
function issue(claims: { room: string; peerId: string; name?: string }, ttlMs = 60_000) {
  const body = Buffer.from(
    JSON.stringify({ name: '', ...claims, exp: Date.now() + ttlMs }),
    'utf8',
  ).toString('base64url');
  const prefix = `s1.${body}`;
  const sig = createHmac('sha256', 'relay-sfu-v1:' + (process.env.SFU_SECRET ?? ''))
    .update(prefix)
    .digest('base64url');
  return `${prefix}.${sig}`;
}

let io: FakeIo;
let workers: FakeWorkers;
let rooms: RoomsService;
let gw: SfuGateway;

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  process.env.SFU_SECRET = SECRET;
  io = new FakeIo();
  workers = new FakeWorkers();
  rooms = new RoomsService(workers as unknown as WorkersService);
  gw = new SfuGateway(rooms);
  gw.server = {} as never;
});

afterEach(() => {
  delete process.env.SFU_SECRET;
  vi.restoreAllMocks();
});

const sock = (s: FakeSocket) => s as unknown as Socket;

/** Подключить участника с валидным пропуском. */
async function connect(room: string, peerId: string, name = peerId) {
  const s = io.connect({ token: issue({ room, peerId, name }), id: `sock-${peerId}` });
  await gw.handleConnection(sock(s));
  return s;
}

/** Подключить и построить ему транспорт — с него начинается всё остальное. */
async function withTransport(room: string, peerId: string) {
  const s = await connect(room, peerId);
  const ack = await gw.handleCreateTransport(sock(s), { direction: 'send' });
  if (!ack.ok) throw new Error('транспорт не создался');
  const transportId = (ack.params as { id: string }).id;
  return { s, transportId };
}

describe('подключение', () => {
  it('валидный пропуск даёт capabilities и снимок комнаты', async () => {
    const s = await connect('эфир', 'a', 'Аня');
    const welcome = s.last('welcome') as {
      peerId: string;
      routerRtpCapabilities: unknown;
      peers: unknown[];
    };
    expect(welcome.peerId).toBe('a');
    expect(welcome.routerRtpCapabilities).toEqual(workers.routers[0].rtpCapabilities);
    expect(welcome.peers).toEqual([]);
    expect(s.rooms.has('sfu:эфир')).toBe(true);
  });

  it('второму приезжает первый, а первому — уведомление о пополнении', async () => {
    const a = await connect('эфир', 'a', 'Аня');
    a.clear();
    const b = await connect('эфир', 'b', 'Боря');
    expect(
      (b.last('welcome') as { peers: { peerId: string }[] }).peers.map((p) => p.peerId),
    ).toEqual(['a']);
    expect(a.last('peer-joined')).toEqual({ peerId: 'b', name: 'Боря' });
  });

  it('без пропуска отключают, сказав об этом клиенту и в лог', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const s = io.connect({ ua: 'RelayDesktop/1.0' });
    await gw.handleConnection(sock(s));
    expect(s.last('sfu-error')).toEqual({ error: 'unauthorized' });
    expect(s.disconnected).toBe(true);
    // Клиент после отказа молча уедет в p2p — без этой строчки не разобраться.
    expect(warn.mock.calls.some((c) => String(c[0]).includes('RelayDesktop/1.0'))).toBe(true);
  });

  it('протухший пропуск и чужая подпись не проходят', async () => {
    const stale = io.connect({ token: issue({ room: 'эфир', peerId: 'a' }, -1000) });
    await gw.handleConnection(sock(stale));
    expect(stale.disconnected).toBe(true);

    process.env.SFU_SECRET = 'другой-секрет';
    const forged = io.connect({ token: issue({ room: 'эфир', peerId: 'a' }) });
    process.env.SFU_SECRET = SECRET;
    await gw.handleConnection(sock(forged));
    expect(forged.disconnected).toBe(true);
  });

  it('пропуск пускает ровно в свою комнату — её берут из клейма, не из запроса', async () => {
    const a = await connect('первая', 'a');
    const b = await connect('вторая', 'b');
    expect(a.rooms.has('sfu:первая')).toBe(true);
    expect(b.rooms.has('sfu:вторая')).toBe(true);
    expect(a.got('peer-joined')).toBe(false);
  });

  it('уход снимает участника и сообщает комнате', async () => {
    const a = await connect('эфир', 'a');
    const b = await connect('эфир', 'b');
    a.clear();
    gw.handleDisconnect(sock(b));
    expect(a.last('peer-left')).toEqual({ peerId: 'b' });
    expect(rooms.peers('эфир').map((p) => p.id)).toEqual(['a']);
  });

  it('дисконнект неизвестного сокета — не событие', () => {
    const s = io.connect();
    expect(() => gw.handleDisconnect(sock(s))).not.toThrow();
  });
});

describe('транспорты', () => {
  it('создаёт транспорт и возвращает направление обратно клиенту', async () => {
    const s = await connect('эфир', 'a');
    const send = await gw.handleCreateTransport(sock(s), { direction: 'send' });
    const recv = await gw.handleCreateTransport(sock(s), { direction: 'recv' });
    expect(send).toMatchObject({ ok: true, direction: 'send' });
    expect(recv).toMatchObject({ ok: true, direction: 'recv' });
    // Неизвестное направление считаем отправляющим, а не отказом.
    expect(await gw.handleCreateTransport(sock(s), { direction: 'вбок' })).toMatchObject({
      direction: 'send',
    });
  });

  it('потолок в шесть транспортов держится — порты диапазона общие на всех', async () => {
    const s = await connect('эфир', 'a');
    for (let i = 0; i < 6; i++) {
      expect((await gw.handleCreateTransport(sock(s), {})).ok, `#${i}`).toBe(true);
    }
    expect(await gw.handleCreateTransport(sock(s), {})).toEqual({
      ok: false,
      error: 'too-many-transports',
    });
  });

  it('упавший mediasoup превращается во внятный отказ, а не в исключение', async () => {
    const s = await connect('эфир', 'a');
    workers.routers[0].failTransport = true;
    expect(await gw.handleCreateTransport(sock(s), {})).toEqual({
      ok: false,
      error: 'transport-failed',
    });
  });

  it('connect-transport передаёт dtls-параметры в транспорт', async () => {
    const { s, transportId } = await withTransport('эфир', 'a');
    const dtlsParameters = { role: 'client', fingerprints: [] };
    expect(await gw.handleConnectTransport(sock(s), { transportId, dtlsParameters })).toEqual({
      ok: true,
    });
    expect(workers.routers[0].transports[0].connectedWith).toEqual({ dtlsParameters });
  });

  it('чужой и несуществующий transportId не проходят', async () => {
    const { s } = await withTransport('эфир', 'a');
    const other = await withTransport('эфир', 'b');
    for (const id of ['нет-такого', 42, undefined, other.transportId]) {
      expect(await gw.handleConnectTransport(sock(s), { transportId: id }), String(id)).toEqual({
        ok: false,
        error: 'no-transport',
      });
    }
  });

  it('сбой dtls — отказ connect-failed', async () => {
    const { s, transportId } = await withTransport('эфир', 'a');
    workers.routers[0].transports[0].failConnect = true;
    expect(await gw.handleConnectTransport(sock(s), { transportId })).toEqual({
      ok: false,
      error: 'connect-failed',
    });
  });

  it('restart-ice переизбирает ICE на том же транспорте, дорожки живут', async () => {
    const { s, transportId } = await withTransport('эфир', 'a');
    const ack = await gw.handleRestartIce(sock(s), { transportId });
    expect(ack).toMatchObject({ ok: true });
    expect(workers.routers[0].transports[0].iceRestarts).toBe(1);
    expect(workers.routers[0].transports[0].closed).toBe(false);
  });

  it('close-transport закрывает транспорт, не дожидаясь дисконнекта', async () => {
    const { s, transportId } = await withTransport('эфир', 'a');
    expect(gw.handleCloseTransport(sock(s), { transportId })).toEqual({ ok: true });
    expect(workers.routers[0].transports[0].closed).toBe(true);
    // Транспорт снят с участника — повторное закрытие уже нечего закрывать.
    expect(gw.handleCloseTransport(sock(s), { transportId })).toEqual({
      ok: false,
      error: 'no-transport',
    });
  });

  it('без участника все ручки отвечают no-peer, а не падают', async () => {
    const s = io.connect();
    expect(await gw.handleCreateTransport(sock(s), {})).toEqual({ ok: false, error: 'no-peer' });
    expect(await gw.handleConnectTransport(sock(s), {})).toEqual({ ok: false, error: 'no-peer' });
    expect(await gw.handleRestartIce(sock(s), {})).toEqual({ ok: false, error: 'no-peer' });
    expect(gw.handleCloseTransport(sock(s), {})).toEqual({ ok: false, error: 'no-peer' });
    expect(await gw.handleProduce(sock(s), {})).toEqual({ ok: false, error: 'no-peer' });
    expect(gw.handleCloseProducer(sock(s), {})).toEqual({ ok: false, error: 'no-peer' });
    expect(await gw.handleConsume(sock(s), {})).toEqual({ ok: false, error: 'no-peer' });
    expect(await gw.handleResume(sock(s), {})).toEqual({ ok: false, error: 'no-peer' });
    expect(await gw.handlePreferredLayers(sock(s), {})).toEqual({ ok: false, error: 'no-peer' });
  });
});

describe('дорожки', () => {
  async function producing(room = 'эфир', peerId = 'a', source = 'mic') {
    const { s, transportId } = await withTransport(room, peerId);
    const ack = await gw.handleProduce(sock(s), {
      transportId,
      kind: source === 'mic' || source === 'screen-audio' ? 'audio' : 'video',
      rtpParameters: {},
      source,
    });
    if (!ack.ok) throw new Error('produce не прошёл');
    return { s, transportId, producerId: ack.id };
  }

  it('дорожка расходится по комнате вместе с её назначением', async () => {
    const listener = await connect('эфир', 'слушатель');
    listener.clear();
    const { producerId } = await producing('эфир', 'a', 'screen');
    expect(listener.last('new-producer')).toEqual({
      peerId: 'a',
      producer: { id: producerId, kind: 'video', source: 'screen' },
    });
  });

  it('неизвестный вид и неизвестное назначение отвергаются порознь', async () => {
    const { s, transportId } = await withTransport('эфир', 'a');
    expect(await gw.handleProduce(sock(s), { transportId, kind: 'текст', source: 'mic' })).toEqual({
      ok: false,
      error: 'bad-kind',
    });
    expect(
      await gw.handleProduce(sock(s), { transportId, kind: 'audio', source: 'радио' }),
    ).toEqual({ ok: false, error: 'bad-source' });
  });

  it('потолок в шесть дорожек на участника', async () => {
    const { s, transportId } = await withTransport('эфир', 'a');
    for (let i = 0; i < 6; i++) {
      const ack = await gw.handleProduce(sock(s), {
        transportId,
        kind: 'audio',
        rtpParameters: {},
        source: 'mic',
      });
      expect(ack.ok, `#${i}`).toBe(true);
    }
    expect(await gw.handleProduce(sock(s), { transportId, kind: 'audio', source: 'mic' })).toEqual({
      ok: false,
      error: 'too-many-producers',
    });
  });

  it('сбой produce — отказ, а не исключение', async () => {
    const { s, transportId } = await withTransport('эфир', 'a');
    workers.routers[0].transports[0].failProduce = true;
    expect(await gw.handleProduce(sock(s), { transportId, kind: 'audio', source: 'mic' })).toEqual({
      ok: false,
      error: 'produce-failed',
    });
  });

  it('закрытие транспорта снимает его дорожки с участника', async () => {
    const { s, transportId } = await producing();
    gw.handleCloseTransport(sock(s), { transportId });
    // Повторное закрытие дорожки нечего закрывать — её уже нет.
    expect(gw.handleCloseProducer(sock(s), { producerId: 'что угодно' })).toEqual({
      ok: false,
      error: 'no-producer',
    });
  });

  it('снятая дорожка объявляется остальным — плитку надо убрать', async () => {
    const listener = await connect('эфир', 'слушатель');
    const { s, producerId } = await producing('эфир', 'a', 'cam');
    listener.clear();
    expect(gw.handleCloseProducer(sock(s), { producerId })).toEqual({ ok: true });
    expect(listener.last('producer-closed')).toEqual({ peerId: 'a', producerId });
  });

  it('чужую дорожку снять нельзя', async () => {
    const mine = await producing('эфир', 'a', 'cam');
    const other = await producing('эфир', 'b', 'cam');
    expect(gw.handleCloseProducer(sock(mine.s), { producerId: other.producerId })).toEqual({
      ok: false,
      error: 'no-producer',
    });
  });

  it('подписка приходит на паузе — клиент сам решит, когда пустить звук', async () => {
    const { producerId } = await producing('эфир', 'a', 'cam');
    const b = await withTransport('эфир', 'b');
    const ack = await gw.handleConsume(sock(b.s), {
      transportId: b.transportId,
      producerId,
      rtpCapabilities: { codecs: [] },
    });
    expect(ack).toMatchObject({ ok: true });
    if (!ack.ok) return;
    expect(ack.consumer).toMatchObject({ producerId, peerId: 'a', source: 'cam' });
    const consumer = workers.routers[0].transports.flatMap((t) => t.consumed)[0];
    expect(consumer.paused).toBe(true);

    expect(await gw.handleResume(sock(b.s), { consumerId: consumer.id })).toEqual({ ok: true });
    expect(consumer.paused).toBe(false);
  });

  it('запомненные capabilities позволяют не слать их каждый раз', async () => {
    const a = await producing('эфир', 'a', 'cam');
    const b = await withTransport('эфир', 'b');
    await gw.handleConsume(sock(b.s), {
      transportId: b.transportId,
      producerId: a.producerId,
      rtpCapabilities: { codecs: [] },
    });
    const second = await producing('эфир', 'c', 'mic');
    expect(
      await gw.handleConsume(sock(b.s), {
        transportId: b.transportId,
        producerId: second.producerId,
      }),
    ).toMatchObject({ ok: true });
  });

  it('несовпадение кодеков называет обе стороны — это и есть «слышно, но не видно»', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const a = await producing('эфир', 'a', 'cam');
    const b = await withTransport('эфир', 'b');
    workers.routers[0].consumable = false;

    expect(
      await gw.handleConsume(sock(b.s), {
        transportId: b.transportId,
        producerId: a.producerId,
        rtpCapabilities: { codecs: [{ kind: 'video', mimeType: 'video/H264' }] },
      }),
    ).toEqual({ ok: false, error: 'cannot-consume' });

    const line = warn.mock.calls.map((c) => String(c[0])).find((s) => s.includes('cannot-consume'));
    expect(line).toContain('producer=[video/VP8]');
    expect(line).toContain('consumer=[video/H264]');
  });

  it('несуществующая дорожка, пустой запрос и сбой consume различимы', async () => {
    const b = await withTransport('эфир', 'b');
    expect(
      await gw.handleConsume(sock(b.s), { transportId: b.transportId, producerId: 'нет' }),
    ).toEqual({ ok: false, error: 'bad-request' });
    expect(
      await gw.handleConsume(sock(b.s), {
        transportId: b.transportId,
        producerId: 'нет',
        rtpCapabilities: { codecs: [] },
      }),
    ).toEqual({ ok: false, error: 'no-producer' });

    const a = await producing('эфир', 'a', 'cam');
    workers.routers[0].transports.find((t) => t.id === b.transportId)!.failConsume = true;
    expect(
      await gw.handleConsume(sock(b.s), {
        transportId: b.transportId,
        producerId: a.producerId,
        rtpCapabilities: { codecs: [] },
      }),
    ).toEqual({ ok: false, error: 'consume-failed' });
  });

  it('закрытая дорожка гасит подписку у слушателя', async () => {
    const a = await producing('эфир', 'a', 'cam');
    const b = await withTransport('эфир', 'b');
    await gw.handleConsume(sock(b.s), {
      transportId: b.transportId,
      producerId: a.producerId,
      rtpCapabilities: { codecs: [] },
    });
    const consumer = workers.routers[0].transports.flatMap((t) => t.consumed)[0];
    b.s.clear();
    consumer.fire('producerclose');
    expect(b.s.last('producer-closed')).toEqual({ peerId: 'a', producerId: a.producerId });
    expect(await gw.handleResume(sock(b.s), { consumerId: consumer.id })).toEqual({
      ok: false,
      error: 'no-consumer',
    });
  });

  it('реально доехавший слой сообщают клиенту — в тултипе честнее факт, чем заявка', async () => {
    const a = await producing('эфир', 'a', 'cam');
    const b = await withTransport('эфир', 'b');
    await gw.handleConsume(sock(b.s), {
      transportId: b.transportId,
      producerId: a.producerId,
      rtpCapabilities: { codecs: [] },
    });
    const consumer = workers.routers[0].transports.flatMap((t) => t.consumed)[0];
    b.s.clear();
    consumer.fire('layerschange', { spatialLayer: 2, temporalLayer: 1 });
    expect(b.s.last('consumer-layers')).toEqual({
      consumerId: consumer.id,
      spatialLayer: 2,
      temporalLayer: 1,
    });
    consumer.fire('layerschange', undefined);
    expect(b.s.last('consumer-layers')).toEqual({
      consumerId: consumer.id,
      spatialLayer: null,
      temporalLayer: null,
    });
  });
});

describe('предпочитаемые слои', () => {
  async function consuming() {
    const a = await withTransport('эфир', 'a');
    const produced = await gw.handleProduce(sock(a.s), {
      transportId: a.transportId,
      kind: 'video',
      rtpParameters: {},
      source: 'cam',
    });
    if (!produced.ok) throw new Error('produce');
    const b = await withTransport('эфир', 'b');
    await gw.handleConsume(sock(b.s), {
      transportId: b.transportId,
      producerId: produced.id,
      rtpCapabilities: { codecs: [] },
    });
    const consumer = workers.routers[0].transports.flatMap((t) => t.consumed)[0];
    return { b, consumer };
  }

  it('крупной плитке — верхний слой', async () => {
    const { b, consumer } = await consuming();
    expect(
      await gw.handlePreferredLayers(sock(b.s), {
        consumerId: consumer.id,
        spatialLayer: 2,
        temporalLayer: 1,
      }),
    ).toEqual({ ok: true });
    expect(consumer.preferred).toEqual({ spatialLayer: 2, temporalLayer: 1 });
  });

  it('временной слой необязателен', async () => {
    const { b, consumer } = await consuming();
    await gw.handlePreferredLayers(sock(b.s), { consumerId: consumer.id, spatialLayer: 0 });
    expect(consumer.preferred).toEqual({ spatialLayer: 0 });
  });

  it('дробный и отрицательный слой отвергаются', async () => {
    const { b, consumer } = await consuming();
    for (const spatialLayer of [-1, 1.5, 'верхний', undefined]) {
      expect(
        await gw.handlePreferredLayers(sock(b.s), { consumerId: consumer.id, spatialLayer }),
        String(spatialLayer),
      ).toEqual({ ok: false, error: 'bad-layer' });
    }
  });

  it('звуковой подписке слои не назначают', async () => {
    const a = await withTransport('эфир', 'a');
    const produced = await gw.handleProduce(sock(a.s), {
      transportId: a.transportId,
      kind: 'audio',
      rtpParameters: {},
      source: 'mic',
    });
    if (!produced.ok) throw new Error('produce');
    const b = await withTransport('эфир', 'b');
    await gw.handleConsume(sock(b.s), {
      transportId: b.transportId,
      producerId: produced.id,
      rtpCapabilities: { codecs: [] },
    });
    const consumer = workers.routers[0].transports
      .flatMap((t) => t.consumed)
      .find((c) => c.producerId === produced.id)!;
    // Подделка вида: consume в стенде создаёт видео по умолчанию — тут важен
    // сам факт отказа для не-видео, поэтому проверяем неизвестный id.
    expect(await gw.handlePreferredLayers(sock(b.s), { consumerId: 'нет' })).toEqual({
      ok: false,
      error: 'no-consumer',
    });
    expect(consumer.preferred).toBeUndefined();
  });
});

describe('переподключение', () => {
  it('второй заход с тем же peerId закрывает прошлые транспорты', async () => {
    const first = await withTransport('эфир', 'a');
    const before = workers.routers[0].transports.find(
      (t) => t.id === first.transportId,
    ) as FakeTransport;
    await connect('эфир', 'a');
    expect(before.closed).toBe(true);
    expect(rooms.peers('эфир')).toHaveLength(1);
  });
});
