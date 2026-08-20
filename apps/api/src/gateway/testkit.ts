import type { Server, Socket } from 'socket.io';
import { PROTOCOL_VERSION } from './protocol';

/**
 * Поддельный socket.io для тестов гейтвея.
 *
 * Гейтвей — это почти целиком решения о том, КОМУ уходит событие: свой,
 * комната без отправителя, вся комната, все сокеты сервера, все кроме гостей.
 * Поднимать ради этого настоящий сервер бессмысленно (тогда проверяется
 * socket.io, а не наши правила) и дорого. Поэтому здесь ровно та часть
 * протокола, которой гейтвей пользуется: комнаты адаптера, карта сокетов и три
 * формы emit. Каждый сокет копит всё, что ему прислали, — по этому журналу и
 * пишутся проверки.
 */

export interface Emitted {
  event: string;
  data: unknown;
}

type Handshake = {
  auth: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  address: string;
};

export class FakeSocket {
  readonly emitted: Emitted[] = [];
  // socket.data гейтвей использует как мешок произвольных полей — так же и здесь.
  readonly data: Record<string, unknown> = {};
  readonly rooms = new Set<string>();
  disconnected = false;

  constructor(
    readonly id: string,
    private readonly hub: FakeServer,
    readonly handshake: Handshake,
  ) {}

  join(room: string): void {
    this.rooms.add(room);
    this.hub.addToRoom(room, this.id);
  }

  leave(room: string): void {
    this.rooms.delete(room);
    this.hub.removeFromRoom(room, this.id);
  }

  emit(event: string, data?: unknown): boolean {
    this.emitted.push({ event, data });
    return true;
  }

  /** `client.to(room)` — комната без самого отправителя. */
  to(room: string) {
    return {
      emit: (event: string, data?: unknown) => this.hub.deliver(room, event, data, this.id),
    };
  }

  disconnect(_close?: boolean): this {
    this.disconnected = true;
    this.hub.remove(this.id);
    return this;
  }

  // ── Разбор журнала ──────────────────────────────────────────────────────

  /** Все события с таким именем, по порядку. */
  all(event: string): unknown[] {
    return this.emitted.filter((e) => e.event === event).map((e) => e.data);
  }

  /** Последнее событие с таким именем (undefined — такого не было). */
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

export class FakeServer {
  readonly rooms = new Map<string, Set<string>>();
  readonly all = new Map<string, FakeSocket>();
  private seq = 0;

  readonly sockets = {
    sockets: this.all,
    adapter: { rooms: this.rooms },
  };

  /** `server.to(room)` — вся комната, включая отправителя. */
  to(room: string) {
    return {
      emit: (event: string, data?: unknown) => this.deliver(room, event, data),
    };
  }

  /**
   * Миддлвары socket.io. Гейтвей вешает сюда узнавание личности, и вешает
   * именно сюда потому, что здесь оно успевает до первого события клиента, —
   * значит и в тесте порядок обязан быть тот же (см. `run`).
   */
  private readonly middleware: ((socket: Socket, next: (err?: Error) => void) => void)[] = [];

  use(fn: (socket: Socket, next: (err?: Error) => void) => void): this {
    this.middleware.push(fn);
    return this;
  }

  /**
   * Прогнать миддлвары для сокета — то, что socket.io делает до `connection`.
   * Возвращает отказ, если дверь его дала: миддлвара, позвавшая `next(err)`,
   * обрывает подключение, и следующие за ней уже не работают.
   */
  async run(sock: FakeSocket): Promise<Error | undefined> {
    for (const fn of this.middleware) {
      const refused = await new Promise<Error | undefined>((resolve) =>
        fn(sock as unknown as Socket, (err?: Error) => resolve(err)),
      );
      if (refused) return refused;
    }
    return undefined;
  }

  connect(
    opts: {
      id?: string;
      auth?: Record<string, unknown>;
      ip?: string;
      ua?: string;
      cookie?: string;
    } = {},
  ) {
    const id = opts.id ?? `sock-${++this.seq}`;
    const sock = new FakeSocket(id, this, {
      // Версию контракта тестовый сокет называет сам: её спрашивает дверь, и
      // без неё каждый тест проверял бы отказ устаревшему клиенту вместо того,
      // что в нём написано. Сказать своё — можно, для тестов самой двери.
      auth: { protocol: PROTOCOL_VERSION, ...(opts.auth ?? {}) },
      headers: {
        ...(opts.ua ? { 'user-agent': opts.ua } : {}),
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
      },
      address: opts.ip ?? '10.0.0.1',
    });
    this.all.set(id, sock);
    // socket.io держит каждый сокет в комнате его собственного id.
    sock.join(id);
    return sock;
  }

  remove(id: string): void {
    const sock = this.all.get(id);
    if (sock) for (const room of [...sock.rooms]) sock.leave(room);
    this.all.delete(id);
  }

  addToRoom(room: string, id: string): void {
    (this.rooms.get(room) ?? this.rooms.set(room, new Set()).get(room)!).add(id);
  }

  removeFromRoom(room: string, id: string): void {
    const set = this.rooms.get(room);
    if (!set) return;
    set.delete(id);
    if (!set.size) this.rooms.delete(room);
  }

  deliver(room: string, event: string, data: unknown, except?: string): void {
    for (const id of this.rooms.get(room) ?? []) {
      if (id === except) continue;
      this.all.get(id)?.emit(event, data);
    }
  }

  /** Журналы всех сокетов разом — удобно после широковещательных рассылок. */
  clearAll(): void {
    for (const sock of this.all.values()) sock.clear();
  }

  asServer(): Server {
    return this as unknown as Server;
  }
}

export function asSocket(sock: FakeSocket): Socket {
  return sock as unknown as Socket;
}
