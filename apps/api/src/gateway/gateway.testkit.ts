import { Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { randomBytes, randomUUID } from 'node:crypto';
import { AttachmentRow, ChannelRow, DeviceRow, IdentityRow, ServerRow } from '../db/entities';
import { resetDatabase, testDatabase } from '../db/testing';
import { fingerprint as fingerprintOf } from '../identity/crypto';
import { IdentityService } from '../identity/identity.service';
import { OwnerService } from '../identity/owner.service';
import { PrefsService } from '../identity/prefs.service';
import { ReadsService } from '../identity/reads.service';
import { RolesService } from '../identity/roles.service';
import { issueSession } from '../identity/session';
import type { Attachment, UploadsService } from '../uploads';
import type { Channel, PersistedRegistry, ServerEntry } from './registry';
import { ChatService } from './chat.service';
import { RegistryService } from './registry.service';
import { SignalingGateway } from './signaling.gateway';
import { FakeServer, asSocket } from './testkit';

/**
 * Общий стенд для тестов гейтвея.
 *
 * Гейтвей разрезан по владельцам состояния (периметр, голосовые сессии,
 * чат-сессии, витрина реестра, модерация, упоминания), и тесты идут за ними
 * файл в файл. Стенд у всех один: настоящая база, фейковый socket.io-сервер и
 * пара помощников, которые заводят человека с личностью и подключают его.
 *
 * Настоящая база, а не подделка, — намеренно: гейтвей спрашивает у неё права и
 * видимость, и подделка отвечала бы «да» на то, чего в таблицах нет.
 * Доставку же, наоборот, не проверяем: её обеспечивает socket.io, а нас
 * интересует, КОМУ гейтвей адресует ответ (см. ./testkit).
 */

/** Главный сервер инсталляции: несносимый, без создателя, без пароля. */
export const MAIN = 'relay-main';

/** Приватные поля гейтвея — тесту нужно видеть сам реестр, а не только рассылки. */
export type AnyGw = SignalingGateway & {
  registry: { servers: ServerEntry[]; channels: Channel[] };
};

let db: DataSource;

/** База стенда: нужна тестам, которые проверяют не рассылку, а запись. */
export function database(): DataSource {
  return db;
}

/**
 * Обвязка на файл: база на весь прогон, фейковые таймеры и немой логгер на
 * каждый тест. Переменные окружения чистим до теста, а не после: их ставят
 * сами тесты, и забытый `SITE_PASSWORD` запирал бы всё, что идёт следом.
 */
export function useGatewayStand() {
  beforeAll(async () => {
    db = await testDatabase();
  });

  afterAll(async () => {
    await db?.destroy();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    delete process.env.SITE_PASSWORD;
    delete process.env.SFU_URL;
    delete process.env.SFU_SECRET;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
}

/**
 * Загрузки: гейтвею от них нужен ровно один ответ — «такая есть?». Сам файл и
 * его метаданные живут в базе, поэтому и здесь спрашиваем базу, а не Map:
 * подделка отвечала бы «есть» на то, чего чат в таблице вложений не найдёт.
 */
const uploads = {
  async exists(id: string | undefined): Promise<boolean> {
    if (!id) return false;
    return (await db.getRepository(AttachmentRow).countBy({ id })) > 0;
  },
};

/** Готовая загрузка в базе — то, что оставляет за собой POST /api/upload. */
export async function putUpload(id: string, att: Partial<Attachment> = {}) {
  await db.getRepository(AttachmentRow).insert({
    id,
    name: att.name ?? 'кот.png',
    size: att.size ?? 10,
    mime: att.mime ?? 'image/png',
    kind: att.kind ?? 'image',
  });
}

/**
 * Гейтвей поверх настоящей базы. `saved` — то, что уже лежало в реестре к
 * моменту старта: раньше это подсовывалось вместо содержимого файла, теперь
 * кладётся строками, потому что реестр читает их.
 */
export async function makeGateway(saved: PersistedRegistry = {}) {
  await resetDatabase(db);
  if (saved.servers?.length) {
    await db.getRepository(ServerRow).insert(
      saved.servers.map((s, position) => ({
        id: s.id,
        name: s.name,
        emoji: s.emoji ?? null,
        removable: s.removable !== false,
        passwordHash: s.passwordHash ?? null,
        creatorId: s.creatorId ?? null,
        creatorIdentityId: s.creatorIdentityId ?? null,
        position,
      })),
    );
  }
  if (saved.channels?.length) {
    await db.getRepository(ChannelRow).insert(
      saved.channels.map((c, position) => ({
        id: c.id,
        serverId: c.serverId,
        type: c.type,
        name: c.name,
        slug: c.slug,
        removable: c.removable !== false,
        mode: c.mode ?? null,
        creatorId: c.creatorId ?? null,
        creatorIdentityId: c.creatorIdentityId ?? null,
        position,
      })),
    );
  }

  const server = new FakeServer();
  // Пути старого файлового реестра уводим в несуществующий каталог: переезд с
  // 0.x проверяется отдельно, а здесь прогон не должен зависеть от того, лежит
  // ли рядом чужой registry.json.
  const registry = new RegistryService(
    db,
    '/nonexistent/relay/registry.json',
    '/nonexistent/relay/registry.json.migrated',
  );
  await registry.onModuleInit();
  const chat = new ChatService(db, registry);
  await chat.onModuleInit();
  const identities = new IdentityService(db);
  const owner = new OwnerService(db);
  const roles = new RolesService(db);
  const reads = new ReadsService(db);
  const prefs = new PrefsService(db);
  const gw = new SignalingGateway(
    uploads as unknown as UploadsService,
    chat,
    registry,
    identities,
    owner,
    roles,
    reads,
    prefs,
  );
  gw.server = server.asServer();
  // Узнавание личности вешается миддлварой — заводим её и здесь, иначе тест
  // проверял бы гейтвей, у которого этой двери нет вовсе.
  gw.afterInit(server.asServer());
  return { gw, server, registry, chat, identities, owner, roles, reads, prefs };
}

/**
 * Личность в базе и кука её сессии. Челлендж здесь не гоняем намеренно: он
 * проверен в identity.service.test, а гейтвею предъявляют именно куку — и
 * именно её разбор мы и хотим видеть.
 */
export async function personCookie(
  nick: string,
): Promise<{ cookie: string; fingerprint: string; identityId: string }> {
  const id = randomUUID();
  const deviceId = randomUUID();
  const key = randomBytes(32).toString('base64url');
  const fingerprint = fingerprintOf(key);
  await db.getRepository(IdentityRow).insert({
    id,
    publicKey: key,
    fingerprint,
    nick,
    createdAt: new Date(),
    lastSeenAt: null,
  });
  await db.getRepository(DeviceRow).insert({
    id: deviceId,
    identityId: id,
    publicKey: key,
    name: 'тестовое устройство',
    certificate: null,
    parentDeviceId: null,
    createdAt: new Date(),
    lastSeenAt: new Date(),
    revokedAt: null,
  });
  return {
    cookie: `relay_id=${issueSession({ identityId: id, deviceId }).value}`,
    fingerprint,
    identityId: id,
  };
}

/**
 * Подключение с предъявлением куки личности — как у вошедшего человека.
 *
 * `keep` оставляет то, что пришло на подключении (реестры серверов и каналов):
 * обычно тесту мешает этот шум, но там, где проверяются права, он и есть ответ.
 */
export async function connectAs(
  gw: SignalingGateway,
  server: FakeServer,
  cookie: string,
  opts: { id?: string; clientId?: string; keep?: boolean } = {},
) {
  const sock = server.connect({
    id: opts.id,
    cookie,
    auth: { ...(opts.clientId ? { clientId: opts.clientId } : {}) },
  });
  await server.run(sock);
  gw.handleConnection(asSocket(sock));
  if (!opts.keep) sock.clear();
  return sock;
}

/** Подключение с прохождением handleConnection — как в жизни. */
export function connect(
  gw: SignalingGateway,
  server: FakeServer,
  opts: {
    id?: string;
    clientId?: string;
    guest?: string;
    ip?: string;
    ua?: string;
    unlock?: string[];
  } = {},
) {
  const sock = server.connect({
    id: opts.id,
    ip: opts.ip,
    ua: opts.ua,
    auth: {
      ...(opts.clientId ? { clientId: opts.clientId } : {}),
      ...(opts.guest ? { guest: opts.guest } : {}),
      ...(opts.unlock ? { unlock: opts.unlock } : {}),
    },
  });
  gw.handleConnection(asSocket(sock));
  sock.clear();
  return sock;
}

/** Прокрутить дебаунсы (presence, реестр каналов, активность чата). */
export function settle() {
  vi.advanceTimersByTime(200);
}
