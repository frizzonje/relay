import type { types } from 'mediasoup';

/**
 * Поддельные mediasoup и socket.io для тестов медиасервера.
 *
 * Настоящий mediasoup — это C++-процессы, реальные UDP-порты и DTLS: поднимать
 * их ради проверки НАШИХ правил (кого пускаем, сколько транспортов на человека,
 * кому уходит `new-producer`) и дорого, и бессмысленно — проверялся бы
 * mediasoup. Здесь ровно та часть его поверхности, которой пользуются
 * rooms.service и sfu.gateway, плюс возможность заставить любой вызов упасть:
 * половина кода гейтвея — это как раз обработка отказов.
 */

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

class Emitter {
  private readonly handlers = new Map<string, ((...args: never[]) => void)[]>();

  on(event: string, fn: (...args: never[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return this;
  }

  /** Позвать обработчики так, как это сделал бы сам mediasoup. */
  fire(event: string, ...args: unknown[]): void {
    for (const fn of this.handlers.get(event) ?? []) (fn as (...a: unknown[]) => void)(...args);
  }
}

export class FakeProducer extends Emitter {
  readonly id = nextId('producer');
  closed = false;

  constructor(
    readonly kind: 'audio' | 'video',
    readonly appData: Record<string, unknown>,
    readonly rtpParameters: { codecs: { mimeType: string }[] } = {
      codecs: [{ mimeType: 'video/VP8' }],
    },
  ) {
    super();
  }

  close(): void {
    this.closed = true;
  }
}

export class FakeConsumer extends Emitter {
  readonly id = nextId('consumer');
  paused: boolean;
  preferred: unknown;
  /** Consumer закрылся под руками (producer ушёл между consume и resume). */
  failResume = false;
  readonly rtpParameters = { codecs: [{ mimeType: 'video/VP8' }] };

  constructor(
    readonly kind: 'audio' | 'video',
    readonly producerId: string,
    paused: boolean,
  ) {
    super();
    this.paused = paused;
  }

  async resume(): Promise<void> {
    if (this.failResume) throw new Error('consumer closed');
    this.paused = false;
  }

  async pause(): Promise<void> {
    if (this.failResume) throw new Error('consumer closed');
    this.paused = true;
  }

  closed = false;
  close(): void {
    this.closed = true;
  }

  async setPreferredLayers(layers: unknown): Promise<void> {
    this.preferred = layers;
  }
}

export class FakeTransport extends Emitter {
  readonly id = nextId('transport');
  closed = false;
  connectedWith: unknown;
  iceRestarts = 0;
  readonly iceParameters = { usernameFragment: 'u', password: 'p' };
  readonly iceCandidates: unknown[] = [];
  readonly dtlsParameters = { role: 'auto', fingerprints: [] };
  readonly produced: FakeProducer[] = [];
  readonly consumed: FakeConsumer[] = [];

  /** Что должно упасть — по одному флагу на вызов, который это умеет. */
  failConnect = false;
  failProduce = false;
  failConsume = false;

  async connect(opts: unknown): Promise<void> {
    if (this.failConnect) throw new Error('dtls отвалился');
    this.connectedWith = opts;
  }

  async restartIce(): Promise<typeof this.iceParameters> {
    this.iceRestarts++;
    return this.iceParameters;
  }

  /** С какими параметрами заводили каждую дорожку — по её id. */
  readonly produceOptions = new Map<string, Record<string, unknown>>();

  async produce(opts: {
    kind: 'audio' | 'video';
    rtpParameters?: unknown;
    appData: Record<string, unknown>;
    keyFrameRequestDelay?: number;
  }): Promise<FakeProducer> {
    if (this.failProduce) throw new Error('нет rtpParameters');
    const producer = new FakeProducer(opts.kind, opts.appData);
    this.produced.push(producer);
    this.produceOptions.set(producer.id, opts);
    return producer;
  }

  async consume(opts: {
    producerId: string;
    paused: boolean;
    kind?: 'audio' | 'video';
  }): Promise<FakeConsumer> {
    if (this.failConsume) throw new Error('не смог');
    const consumer = new FakeConsumer(opts.kind ?? 'video', opts.producerId, opts.paused);
    this.consumed.push(consumer);
    return consumer;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Закрытие транспорта уносит свои дорожки — именно на это опирается
    // rooms.service, закрывая при выходе только транспорты.
    for (const p of this.produced) p.fire('transportclose');
    for (const c of this.consumed) c.fire('transportclose');
    this.fire('@close');
  }
}

export class FakeRouter {
  readonly id = nextId('router');
  closed = false;
  readonly transports: FakeTransport[] = [];
  readonly rtpCapabilities = { codecs: [{ kind: 'video', mimeType: 'video/VP8' }] };
  /** Ответ canConsume — то самое место, где «слышно, но не видно». */
  consumable = true;
  failTransport = false;

  constructor(readonly mediaCodecs: unknown) {}

  readonly transportOptions: unknown[] = [];

  async createWebRtcTransport(options?: unknown): Promise<FakeTransport> {
    if (this.failTransport) throw new Error('порты кончились');
    this.transportOptions.push(options);
    const t = new FakeTransport();
    this.transports.push(t);
    return t;
  }

  canConsume(): boolean {
    return this.consumable;
  }

  close(): void {
    this.closed = true;
  }
}

export class FakeWorkers {
  readonly routers: FakeRouter[] = [];
  readonly servers: { id: string }[] = [];
  taken = 0;

  take() {
    this.taken++;
    const webRtcServer = { id: nextId('webrtc-server') };
    this.servers.push(webRtcServer);
    return {
      worker: {
        createRouter: async ({ mediaCodecs }: { mediaCodecs: unknown }) => {
          const router = new FakeRouter(mediaCodecs);
          this.routers.push(router);
          return router as unknown as types.Router;
        },
      } as unknown as types.Worker,
      webRtcServer: webRtcServer as unknown as types.WebRtcServer,
    };
  }
}

// ── socket.io ─────────────────────────────────────────────────────────────

export interface Emitted {
  event: string;
  data: unknown;
}

export class FakeSocket {
  readonly emitted: Emitted[] = [];
  readonly rooms = new Set<string>();
  disconnected = false;
  private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  constructor(
    readonly id: string,
    private readonly hub: FakeIo,
    readonly handshake: {
      auth: Record<string, unknown>;
      headers: Record<string, string | undefined>;
    },
    /** Сессия восстановлена socket.io после обрыва: тот же id, те же комнаты. */
    readonly recovered = false,
  ) {}

  on(event: string, fn: (...args: unknown[]) => void): this {
    (this.listeners.get(event) ?? this.listeners.set(event, []).get(event)!).push(fn);
    return this;
  }

  /** Соединение закрылось — с той причиной, которую назвал бы socket.io. */
  drop(reason: string): void {
    this.disconnected = true;
    for (const fn of this.listeners.get('disconnect') ?? []) fn(reason);
  }

  async join(room: string): Promise<void> {
    this.rooms.add(room);
    this.hub.addToRoom(room, this.id);
  }

  emit(event: string, data?: unknown): boolean {
    this.emitted.push({ event, data });
    return true;
  }

  to(room: string) {
    return {
      emit: (event: string, data?: unknown) => this.hub.deliver(room, event, data, this.id),
    };
  }

  disconnect(): this {
    this.disconnected = true;
    return this;
  }

  all(event: string): unknown[] {
    return this.emitted.filter((e) => e.event === event).map((e) => e.data);
  }

  last(event: string): unknown {
    const list = this.all(event);
    return list.length ? list[list.length - 1] : undefined;
  }

  got(event: string): boolean {
    return this.emitted.some((e) => e.event === event);
  }

  clear(): void {
    this.emitted.length = 0;
  }
}

export class FakeIo {
  readonly sockets = new Map<string, FakeSocket>();
  private readonly roomMembers = new Map<string, Set<string>>();
  private n = 0;

  connect(
    opts: { token?: unknown; ua?: string; id?: string; recovered?: boolean } = {},
  ): FakeSocket {
    const sock = new FakeSocket(
      opts.id ?? `sock-${++this.n}`,
      this,
      {
        auth: opts.token === undefined ? {} : { token: opts.token },
        headers: { 'user-agent': opts.ua },
      },
      opts.recovered ?? false,
    );
    // Восстановленный сокет приходит новым объектом под прежним id — рассылка
    // по id дальше доходит до него, а не до мёртвого.
    this.sockets.set(sock.id, sock);
    return sock;
  }

  /** Рассылка от имени сервера (`server.to(room)`); room может быть и id сокета. */
  to(room: string) {
    return { emit: (event: string, data?: unknown) => this.deliver(room, event, data) };
  }

  addToRoom(room: string, id: string): void {
    (this.roomMembers.get(room) ?? this.roomMembers.set(room, new Set()).get(room)!).add(id);
  }

  deliver(room: string, event: string, data: unknown, except?: string): void {
    // Как в socket.io: каждый сокет сидит в комнате имени своего id.
    const members = this.roomMembers.get(room) ?? (this.sockets.has(room) ? [room] : []);
    for (const id of members) {
      if (id === except) continue;
      this.sockets.get(id)?.emit(event, data);
    }
  }

  clearAll(): void {
    for (const s of this.sockets.values()) s.clear();
  }
}
