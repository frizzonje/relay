import { Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { randomBytes, randomUUID } from 'node:crypto';
import { issueGuestToken, issueToken, verifyGuestToken } from '../auth/auth';
import {
  AttachmentRow,
  ChannelRow,
  DeviceRow,
  IdentityRow,
  MessageRow,
  ServerRow,
} from '../db/entities';
import { resetDatabase, testDatabase } from '../db/testing';
import { fingerprint as fingerprintOf } from '../identity/crypto';
import { IdentityService } from '../identity/identity.service';
import { OwnerService } from '../identity/owner.service';
import { RolesService } from '../identity/roles.service';
import { issueSession } from '../identity/session';
import type { Attachment, UploadsService } from '../uploads';
import type { Channel, PersistedRegistry, ServerEntry } from './registry';
import { ChatService } from './chat.service';
import { RegistryService } from './registry.service';
import { FakeServer, asSocket } from './testkit';

/**
 * Гейтвей — это правила о том, кому что видно и кому что можно. Почти каждая
 * его строка отвечает на один из двух вопросов: вправе ли этот сокет сделать
 * то, что просит, и кому уйдёт результат. Проверяем именно это, а не «дошло ли
 * сообщение» — доставку обеспечивает socket.io, и подменять её здесь незачем
 * (см. ./testkit).
 *
 * Отдельно и подробно — закрытые серверы. Пароль там запирает не кнопку, а
 * четыре разные двери (реестр каналов, presence, вход в эфир, пропуск в
 * медиасервер), и любая незапертая обесценивает остальные три.
 */

// Живость медиасервера — сетевой пинг с кэшем на уровне модуля. Кэш пережил бы
// границу теста, поэтому подменяем целиком.
const sfuHealthy = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../sfu/sfu-health', () => ({ sfuHealthy }));

import { SignalingGateway } from './signaling.gateway';

const MAIN = 'relay-main';

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
async function putUpload(id: string, att: Partial<Attachment> = {}) {
  await db.getRepository(AttachmentRow).insert({
    id,
    name: att.name ?? 'кот.png',
    size: att.size ?? 10,
    mime: att.mime ?? 'image/png',
    kind: att.kind ?? 'image',
  });
}

/** Приватные поля гейтвея — тесту нужно видеть сам реестр, а не только рассылки. */
type AnyGw = SignalingGateway & { registry: { servers: ServerEntry[]; channels: Channel[] } };

let db: DataSource;

beforeAll(async () => {
  db = await testDatabase();
});

afterAll(async () => {
  await db?.destroy();
});

/**
 * Гейтвей поверх настоящей базы. `saved` — то, что уже лежало в реестре к
 * моменту старта: раньше это подсовывалось вместо содержимого файла, теперь
 * кладётся строками, потому что реестр читает их.
 */
async function makeGateway(saved: PersistedRegistry = {}) {
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
  const gw = new SignalingGateway(
    uploads as unknown as UploadsService,
    chat,
    registry,
    identities,
    owner,
    roles,
  );
  gw.server = server.asServer();
  // Узнавание личности вешается миддлварой — заводим её и здесь, иначе тест
  // проверял бы гейтвей, у которого этой двери нет вовсе.
  gw.afterInit(server.asServer());
  return { gw, server, registry, chat, identities, owner, roles };
}

/**
 * Личность в базе и кука её сессии. Челлендж здесь не гоняем намеренно: он
 * проверен в identity.service.test, а гейтвею предъявляют именно куку — и
 * именно её разбор мы и хотим видеть.
 */
async function personCookie(
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
async function connectAs(
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
function connect(
  gw: SignalingGateway,
  server: FakeServer,
  opts: { id?: string; clientId?: string; guest?: string; ip?: string; ua?: string } = {},
) {
  const sock = server.connect({
    id: opts.id,
    ip: opts.ip,
    ua: opts.ua,
    auth: {
      ...(opts.clientId ? { clientId: opts.clientId } : {}),
      ...(opts.guest ? { guest: opts.guest } : {}),
    },
  });
  gw.handleConnection(asSocket(sock));
  sock.clear();
  return sock;
}

/** Прокрутить дебаунсы (presence, реестр каналов, активность чата). */
function settle() {
  vi.advanceTimersByTime(200);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  delete process.env.SITE_PASSWORD;
  delete process.env.SFU_URL;
  delete process.env.SFU_SECRET;
  sfuHealthy.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Подключение ───────────────────────────────────────────────────────────

describe('подключение', () => {
  it('без пропуска сокет отключают, а не пускают наблюдать', async () => {
    process.env.SITE_PASSWORD = 'секрет';
    const { gw, server } = await makeGateway();
    const sock = server.connect();
    gw.handleConnection(asSocket(sock));
    expect(sock.disconnected).toBe(true);
    expect(sock.emitted).toHaveLength(0);
  });

  it('с верным пропуском в куке пускают', async () => {
    process.env.SITE_PASSWORD = 'секрет';
    const { gw, server } = await makeGateway();
    const sock = server.connect();
    sock.handshake.headers.cookie = `relay_pass=${issueToken().value}`;
    gw.handleConnection(asSocket(sock));
    expect(sock.disconnected).toBe(false);
    expect(sock.got('servers')).toBe(true);
  });

  it('новичок сразу получает реестры и состав эфиров', async () => {
    const { gw, server } = await makeGateway();
    const sock = server.connect();
    gw.handleConnection(asSocket(sock));
    expect(sock.emitted.map((e) => e.event)).toEqual(['servers', 'channels', 'voice-presence']);
    expect((sock.last('servers') as { id: string }[]).map((s) => s.id)).toEqual([MAIN]);
    expect((sock.last('channels') as { slug: string }[]).map((c) => c.slug).sort()).toEqual(
      ['obshchii', 'voice-obshchii', 'voice-obshchii-sfu'].sort(),
    );
  });

  it('дефолтный SFU-канал приходит помеченным — иначе клиент не поймёт транспорт', async () => {
    const { gw, server } = await makeGateway();
    const sock = server.connect();
    gw.handleConnection(asSocket(sock));
    const channels = sock.last('channels') as { slug: string; mode?: string }[];
    expect(channels.find((c) => c.slug === 'voice-obshchii-sfu')?.mode).toBe('sfu');
    expect(channels.find((c) => c.slug === 'voice-obshchii')?.mode).toBeUndefined();
  });

  it('гость по инвайту получает только свой эфир — реестров ему не показывают', async () => {
    const { gw, server } = await makeGateway();
    const host = connect(gw, server, { id: 'host' });
    gw.handleJoin(asSocket(host), { room: 'voice-obshchii', name: 'хозяин' });
    settle();

    const { token } = issueGuestToken('voice-obshchii');
    const guest = server.connect({ id: 'guest', auth: { guest: token } });
    gw.handleConnection(asSocket(guest));

    expect(guest.emitted.map((e) => e.event)).toEqual(['voice-presence']);
    expect(Object.keys(guest.last('voice-presence') as object)).toEqual(['voice-obshchii']);
    expect(guest.data.guest).toBe(true);
  });

  it('гость на пустой канал получает пустой срез, а не чужие комнаты', async () => {
    const { gw, server } = await makeGateway();
    const other = connect(gw, server, { id: 'other' });
    gw.handleJoin(asSocket(other), { room: 'voice-obshchii', name: 'кто-то' });
    settle();

    const { token } = issueGuestToken('voice-obshchii-sfu');
    const guest = server.connect({ auth: { guest: token } });
    gw.handleConnection(asSocket(guest));
    expect(guest.last('voice-presence')).toEqual({});
  });

  it('протухший гостевой токен — не пропуск: при заданном пароле сайта отключают', async () => {
    process.env.SITE_PASSWORD = 'секрет';
    const { gw, server } = await makeGateway();
    const { token } = issueGuestToken('voice-obshchii', { ttlMs: -1000 });
    const sock = server.connect({ auth: { guest: token } });
    gw.handleConnection(asSocket(sock));
    expect(sock.disconnected).toBe(true);
  });

  it('восстановление сессии отменяет отложенный выход — моргание сети не рвёт звонок', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B' });
    settle();
    server.clearAll();

    gw.handleDisconnect(asSocket(a));
    vi.advanceTimersByTime(1000);
    gw.handleConnection(asSocket(a));
    vi.advanceTimersByTime(60_000);

    expect(b.all('peer-left')).toHaveLength(0);
  });

  it('не вернулся за грейс — остальным сообщают об уходе', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B' });
    settle();
    server.clearAll();

    gw.handleDisconnect(asSocket(a));
    vi.advanceTimersByTime(60_000);
    expect(b.last('peer-left')).toEqual({ id: 'a' });
  });

  it('clientId из handshake обрезается по длине, а пустой владельцем не делает', async () => {
    const { gw, server } = await makeGateway();
    const long = connect(gw, server, { clientId: 'x'.repeat(200) });
    expect((long.data.clientId as string).length).toBe(64);
    const blank = connect(gw, server, { clientId: '   ' });
    expect(blank.data.clientId).toBeUndefined();
  });
});

// ── Реестр серверов ───────────────────────────────────────────────────────

describe('server-create', () => {
  it('создаёт сервер и раздаёт обновлённый реестр всем', async () => {
    const { gw, server, registry } = await makeGateway();
    const a = connect(gw, server, { clientId: 'dev-a' });
    const b = connect(gw, server);
    await gw.handleServerCreate(asSocket(a), { id: 'srv', name: 'мой', emoji: '🌚' });
    settle();

    const seen = b.last('servers') as { id: string; name: string; emoji?: string }[];
    expect(seen.map((s) => s.id)).toEqual([MAIN, 'srv']);
    expect(seen[1]).toMatchObject({ name: 'мой', emoji: '🌚', removable: true });

    // И переживёт рестарт: сервер в базе, а не только в памяти процесса.
    await registry.flush();
    expect(await db.getRepository(ServerRow).findOneBy({ id: 'srv' })).toMatchObject({
      name: 'мой',
      emoji: '🌚',
      creatorId: 'dev-a',
    });
  });

  it('создателю сервер приходит с флагом mine, остальным — без', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { clientId: 'dev-a' });
    const other = connect(gw, server, { clientId: 'dev-b' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'мой' });
    settle();

    const find = (s: { last(e: string): unknown }) =>
      (s.last('servers') as { id: string; mine?: boolean }[]).find((x) => x.id === 'srv');
    expect(find(owner)?.mine).toBe(true);
    expect(find(other)?.mine).toBeUndefined();
  });

  it('наружу уходит флаг locked, но не хэш пароля', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { clientId: 'dev-a' });
    await gw.handleServerCreate(asSocket(a), { id: 'srv', name: 'тайный', password: 'пароль' });
    settle();
    const srv = (a.last('servers') as Record<string, unknown>[]).find((s) => s.id === 'srv')!;
    expect(srv.locked).toBe(true);
    expect(Object.keys(srv)).not.toContain('passwordHash');
  });

  it('создатель закрытого сервера сразу разблокирован — второй раз пароль не спрашивают', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { clientId: 'dev-a' });
    await gw.handleServerCreate(asSocket(a), { id: 'srv', name: 'тайный', password: 'пароль' });
    expect((a.data.unlocked as Set<string>).has('srv')).toBe(true);
  });

  it('повторный create с тем же id не плодит дубликат', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server);
    await gw.handleServerCreate(asSocket(a), { id: 'srv', name: 'раз' });
    await gw.handleServerCreate(asSocket(a), { id: 'srv', name: 'два' });
    expect((gw as AnyGw).registry.servers.filter((s) => s.id === 'srv')).toHaveLength(1);
  });

  it('без id или без имени сервер не появляется', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server);
    await gw.handleServerCreate(asSocket(a), { id: '', name: 'мой' });
    await gw.handleServerCreate(asSocket(a), { id: 'srv', name: '   ' });
    await gw.handleServerCreate(asSocket(a), { id: 42, name: 'мой' });
    expect((gw as AnyGw).registry.servers).toHaveLength(1);
  });

  it('имя и emoji режутся по длине, пустой emoji не сохраняется', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server);
    await gw.handleServerCreate(asSocket(a), {
      id: 'srv',
      name: 'и'.repeat(100),
      emoji: 'э'.repeat(20),
    });
    await gw.handleServerCreate(asSocket(a), { id: 'srv-2', name: 'второй', emoji: '  ' });
    settle();
    const srv = (gw as AnyGw).registry.servers.find((s) => s.id === 'srv')!;
    expect(srv.name).toHaveLength(32);
    expect(srv.emoji).toHaveLength(8);
    // Из одних пробелов emoji не рождается — наружу такой сервер уходит без поля.
    const public2 = (a.last('servers') as Record<string, unknown>[]).find((s) => s.id === 'srv-2')!;
    expect(public2).not.toHaveProperty('emoji');
  });

  it('потолок в 20 серверов держится', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server);
    for (let i = 0; i < 25; i++) {
      await gw.handleServerCreate(asSocket(a), { id: `srv-${i}`, name: `s${i}` });
      // Бакет на 40 токенов — двигаем время, чтобы упереться именно в потолок.
      vi.advanceTimersByTime(1000);
    }
    expect((gw as AnyGw).registry.servers).toHaveLength(20);
  });

  it('гость сервера не создаёт', async () => {
    const { gw, server } = await makeGateway();
    const { token } = issueGuestToken('voice-obshchii');
    const guest = connect(gw, server, { guest: token });
    await gw.handleServerCreate(asSocket(guest), { id: 'srv', name: 'мой' });
    expect((gw as AnyGw).registry.servers).toHaveLength(1);
  });

  it('сохранённые серверы поднимаются вместе с дефолтными, дефолт — источник правды', async () => {
    const { gw } = await makeGateway({
      servers: [
        { id: 'srv', name: 'сохранённый', removable: true },
        { id: MAIN, name: 'подмена', removable: true },
      ],
    });
    expect((gw as AnyGw).registry.servers.map((s) => s.id)).toEqual([MAIN, 'srv']);
    expect((gw as AnyGw).registry.servers[0].removable).toBe(false);
  });

  it('удалённый сервер уносит свои каналы и их переписку', async () => {
    const { gw, server, registry } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev-owner' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'мой' });
    await gw.handleChannelCreate(asSocket(owner), { serverId: 'srv', type: 'text', name: 'чат' });
    await gw.handleChatJoin(asSocket(owner), { room: 'чат', name: 'Хозяин' });
    await gw.handleChatMessage(asSocket(owner), { text: 'привет' });

    expect(await gw.handleServerDelete(asSocket(owner), { id: 'srv' })).toEqual({ ok: true });
    await registry.flush();

    // Канал-сирота теперь невозможен не по договорённости, а по внешнему ключу:
    // сервера нет — нет и каналов, а вместе с каналом уходит его переписка.
    expect((gw as AnyGw).registry.channels.some((c) => c.serverId === 'srv')).toBe(false);
    expect(await db.getRepository(ChannelRow).countBy({ serverId: 'srv' })).toBe(0);
    expect(await db.getRepository(MessageRow).count()).toBe(0);
  });

  it('канал, выведенный из дефолтов, не возвращается из сохранённого реестра', async () => {
    const { gw } = await makeGateway({
      servers: [{ id: MAIN, name: 'relay', removable: false }],
      channels: [
        {
          id: 'text-general',
          serverId: MAIN,
          type: 'text',
          name: 'general',
          slug: 'general',
          removable: false,
        },
      ],
    });
    expect((gw as AnyGw).registry.channels.find((c) => c.id === 'text-general')).toBeUndefined();
  });

  it('отказ базы не роняет живой реестр в памяти', async () => {
    const { gw, server, registry } = await makeGateway();
    const a = connect(gw, server);
    vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('база отвалилась'));
    await gw.handleServerCreate(asSocket(a), { id: 'srv', name: 'мой' });
    await registry.flush();
    // Записать не вышло, но сервер жив: люди, уже сидящие в relay, не должны
    // терять только что созданное из-за того, что база моргнула.
    expect((gw as AnyGw).registry.servers.map((s) => s.id)).toContain('srv');
  });
});

describe('server-unlock', () => {
  async function withLocked() {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev-owner' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'тайный', password: 'пароль' });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'text',
      name: 'тайный чат',
    });
    settle();
    server.clearAll();
    return { gw, server, owner };
  }

  it('верный пароль открывает каналы и состав их эфиров', async () => {
    const { gw, server } = await withLocked();
    const guest = connect(gw, server, { id: 'guest' });
    gw.handleConnection(asSocket(guest));
    expect((guest.last('channels') as { slug: string }[]).map((c) => c.slug)).not.toContain(
      'тайный-чат',
    );
    guest.clear();

    await gw.handleServerUnlock(asSocket(guest), { id: 'srv', password: 'пароль' });
    expect(guest.last('server-unlock-result')).toEqual({ id: 'srv', ok: true });
    expect((guest.last('channels') as { slug: string }[]).map((c) => c.slug)).toContain(
      'тайный-чат',
    );
    expect(guest.got('voice-presence')).toBe(true);
  });

  it('неверный пароль ничего не открывает', async () => {
    const { gw, server } = await withLocked();
    const guest = connect(gw, server, { id: 'guest' });
    await gw.handleServerUnlock(asSocket(guest), { id: 'srv', password: 'не тот' });
    expect(guest.last('server-unlock-result')).toEqual({ id: 'srv', ok: false });
    expect(guest.got('channels')).toBe(false);
  });

  it('несуществующий сервер — отказ, а не молчание', async () => {
    const { gw, server } = await withLocked();
    const a = connect(gw, server);
    await gw.handleServerUnlock(asSocket(a), { id: 'нет', password: 'x' });
    expect(a.last('server-unlock-result')).toEqual({ id: 'нет', ok: false });
  });

  it('открытый сервер разблокируется без пароля', async () => {
    const { gw, server } = await withLocked();
    const a = connect(gw, server);
    await gw.handleServerUnlock(asSocket(a), { id: MAIN, password: '' });
    expect(a.last('server-unlock-result')).toEqual({ id: MAIN, ok: true });
  });

  it('повторная разблокировка тем же паролем идёт из кэша и всё равно открывает', async () => {
    const { gw, server } = await withLocked();
    const first = connect(gw, server, { id: 'first' });
    await gw.handleServerUnlock(asSocket(first), { id: 'srv', password: 'пароль' });
    const second = connect(gw, server, { id: 'second' });
    await gw.handleServerUnlock(asSocket(second), { id: 'srv', password: 'пароль' });
    expect(second.last('server-unlock-result')).toEqual({ id: 'srv', ok: true });
  });

  it('после порога неудач адрес уходит в простой — хэш больше не считается', async () => {
    const { gw, server } = await withLocked();
    const a = connect(gw, server, { id: 'attacker', ip: '9.9.9.9' });
    for (let i = 0; i < 9; i++) {
      await gw.handleServerUnlock(asSocket(a), { id: 'srv', password: `мимо-${i}` });
      vi.advanceTimersByTime(1000);
    }
    a.clear();
    await gw.handleServerUnlock(asSocket(a), { id: 'srv', password: 'пароль' });
    expect(a.last('server-unlock-result')).toEqual({ id: 'srv', ok: false });
  });

  it('простой вяжется к адресу, а не к сокету: реконнект его не сбрасывает', async () => {
    const { gw, server } = await withLocked();
    for (let i = 0; i < 9; i++) {
      const tmp = connect(gw, server, { id: `att-${i}`, ip: '9.9.9.9' });
      await gw.handleServerUnlock(asSocket(tmp), { id: 'srv', password: 'мимо' });
      vi.advanceTimersByTime(1000);
    }
    const fresh = connect(gw, server, { id: 'fresh', ip: '9.9.9.9' });
    await gw.handleServerUnlock(asSocket(fresh), { id: 'srv', password: 'пароль' });
    expect(fresh.last('server-unlock-result')).toEqual({ id: 'srv', ok: false });

    // А сосед по другому адресу не пострадал.
    const neighbour = connect(gw, server, { id: 'neighbour', ip: '8.8.8.8' });
    await gw.handleServerUnlock(asSocket(neighbour), { id: 'srv', password: 'пароль' });
    expect(neighbour.last('server-unlock-result')).toEqual({ id: 'srv', ok: true });
  });

  it('гость пароли не подбирает', async () => {
    const { gw, server } = await withLocked();
    const { token } = issueGuestToken('voice-obshchii');
    const guest = connect(gw, server, { guest: token });
    await gw.handleServerUnlock(asSocket(guest), { id: 'srv', password: 'пароль' });
    expect(guest.got('server-unlock-result')).toBe(false);
  });
});

describe('server-delete', () => {
  async function withServer(clientId = 'dev-a') {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'мой' });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'text',
      name: 'болталка',
    });
    await gw.handleChannelCreate(asSocket(owner), { serverId: 'srv', type: 'voice', name: 'эфир' });
    settle();
    server.clearAll();
    return { gw, server, owner };
  }

  it('владелец удаляет сервер вместе с его каналами', async () => {
    const { gw, owner } = await withServer();
    expect(await gw.handleServerDelete(asSocket(owner), { id: 'srv' })).toEqual({ ok: true });
    settle();
    expect((gw as AnyGw).registry.servers.map((s) => s.id)).toEqual([MAIN]);
    expect((gw as AnyGw).registry.channels.some((c) => c.serverId === 'srv')).toBe(false);
    expect((owner.last('channels') as unknown[]).length).toBe(3);
  });

  it('читателей текстового канала выписывают явно, а не оставляют гадать', async () => {
    const { gw, server, owner } = await withServer();
    const reader = connect(gw, server, { id: 'reader' });
    await gw.handleChatJoin(asSocket(reader), { room: 'болталка', name: 'Читатель' });
    reader.clear();

    await gw.handleServerDelete(asSocket(owner), { id: 'srv' });
    expect(reader.last('chat-closed')).toEqual({ slug: 'болталка' });
    expect(reader.data.chatRoom).toBeUndefined();
  });

  it('главный сервер не удаляется', async () => {
    const { gw, owner } = await withServer();
    expect(await gw.handleServerDelete(asSocket(owner), { id: MAIN })).toEqual({
      ok: false,
      error: 'not-found',
    });
  });

  it('чужой сервер удалить нельзя', async () => {
    const { gw, server } = await withServer('dev-owner');
    const stranger = connect(gw, server, { clientId: 'dev-stranger' });
    expect(await gw.handleServerDelete(asSocket(stranger), { id: 'srv' })).toEqual({
      ok: false,
      error: 'not-owner',
    });
    expect((gw as AnyGw).registry.servers.map((s) => s.id)).toContain('srv');
  });

  it('запись без создателя (создана до правила владения) остаётся общей', async () => {
    const { gw, server } = await makeGateway({
      servers: [{ id: 'старый', name: 'ничей', removable: true }],
    });
    const anyone = connect(gw, server, { clientId: 'dev-кто-угодно' });
    expect(await gw.handleServerDelete(asSocket(anyone), { id: 'старый' })).toEqual({ ok: true });
  });

  it('закрытый сервер удаляет только тот, кто ввёл пароль', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev-owner' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'тайный', password: 'п' });
    // Тот же clientId: владение не спасает, пока пароль не введён.
    const stranger = connect(gw, server, { clientId: 'dev-owner' });
    expect(await gw.handleServerDelete(asSocket(stranger), { id: 'srv' })).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });

  it('живой разговор дороже уборки: сервер с людьми в эфире не удаляется', async () => {
    const { gw, server, owner } = await withServer();
    const talker = connect(gw, server, { id: 'talker' });
    gw.handleJoin(asSocket(talker), { room: 'эфир', name: 'Говорящий' });
    expect(await gw.handleServerDelete(asSocket(owner), { id: 'srv' })).toEqual({
      ok: false,
      error: 'occupied',
      occupants: 1,
    });
  });

  it('пустой id — not-found, гость — forbidden', async () => {
    const { gw, server, owner } = await withServer();
    expect(await gw.handleServerDelete(asSocket(owner), {})).toEqual({
      ok: false,
      error: 'not-found',
    });
    const { token } = issueGuestToken('voice-obshchii');
    const guest = connect(gw, server, { guest: token });
    expect(await gw.handleServerDelete(asSocket(guest), { id: 'srv' })).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });
});

describe('server-stats', () => {
  it('владельцу — цена удаления: каналы, сообщения, люди в эфире', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev-owner' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'мой' });
    await gw.handleChannelCreate(asSocket(owner), { serverId: 'srv', type: 'text', name: 'чат' });
    await gw.handleChannelCreate(asSocket(owner), { serverId: 'srv', type: 'voice', name: 'эфир' });
    await gw.handleChatJoin(asSocket(owner), { room: 'чат', name: 'Хозяин' });
    await gw.handleChatMessage(asSocket(owner), { text: 'привет' });

    const talker = connect(gw, server, { id: 'talker' });
    gw.handleJoin(asSocket(talker), { room: 'эфир', name: 'Гость' });

    expect(await gw.handleServerStats(asSocket(owner), { id: 'srv' })).toEqual({
      ok: true,
      channels: 2,
      messages: 1,
      occupants: 1,
    });
  });

  it('чужому серверу срез не показывают', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { clientId: 'dev-owner' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'мой' });
    const stranger = connect(gw, server, { clientId: 'dev-stranger' });
    expect(await gw.handleServerStats(asSocket(stranger), { id: 'srv' })).toEqual({ ok: false });
  });

  it('главный сервер (неудаляемый) среза не даёт', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server);
    expect(await gw.handleServerStats(asSocket(a), { id: MAIN })).toEqual({ ok: false });
  });

  it('закрытый сервер без введённого пароля молчит', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { clientId: 'dev' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'тайный', password: 'п' });
    const other = connect(gw, server, { clientId: 'dev' });
    expect(await gw.handleServerStats(asSocket(other), { id: 'srv' })).toEqual({ ok: false });
  });
});

// ── Реестр каналов ────────────────────────────────────────────────────────

describe('channel-create', () => {
  async function withOwnServer() {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev-owner' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'мой' });
    settle();
    server.clearAll();
    return { gw, server, owner };
  }

  it('создаёт канал со слагом из имени', async () => {
    const { gw, owner } = await withOwnServer();
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'text',
      name: 'Общий Чат!',
    });
    const ch = (gw as AnyGw).registry.channels.find((c) => c.serverId === 'srv')!;
    expect(ch.slug).toBe('общий-чат');
    expect(ch.type).toBe('text');
    expect(ch.creatorId).toBe('dev-owner');
  });

  it('слаг режется по длине и не копит дефисы', async () => {
    const { gw, owner } = await withOwnServer();
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'text',
      name: 'а   б   в '.repeat(6),
    });
    const ch = (gw as AnyGw).registry.channels.find((c) => c.serverId === 'srv')!;
    expect(ch.slug.length).toBeLessThanOrEqual(32);
    expect(ch.slug).not.toMatch(/--/);
  });

  it('имя из одной пунктуации канала не даёт', async () => {
    const { gw, owner } = await withOwnServer();
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'text',
      name: '!!! ???',
    });
    expect((gw as AnyGw).registry.channels.some((c) => c.serverId === 'srv')).toBe(false);
  });

  it('в главный сервер каналы не добавляют — набор там фиксирован', async () => {
    const { gw, owner } = await withOwnServer();
    await gw.handleChannelCreate(asSocket(owner), { serverId: MAIN, type: 'text', name: 'лишний' });
    // serverId по умолчанию — тоже главный, то есть тот же запрет.
    await gw.handleChannelCreate(asSocket(owner), { type: 'text', name: 'лишний-2' });
    expect((gw as AnyGw).registry.channels).toHaveLength(3);
  });

  it('несуществующий сервер и неизвестный тип канала не создают', async () => {
    const { gw, owner } = await withOwnServer();
    await gw.handleChannelCreate(asSocket(owner), { serverId: 'нет', type: 'text', name: 'висяк' });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'видео',
      name: 'что-то',
    });
    expect((gw as AnyGw).registry.channels).toHaveLength(3);
  });

  it('дубликат слага того же типа не создаётся, а другого типа — можно', async () => {
    const { gw, owner } = await withOwnServer();
    await gw.handleChannelCreate(asSocket(owner), { serverId: 'srv', type: 'text', name: 'общий' });
    await gw.handleChannelCreate(asSocket(owner), { serverId: 'srv', type: 'text', name: 'общий' });
    expect((gw as AnyGw).registry.channels.filter((c) => c.slug === 'общий')).toHaveLength(1);
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'voice',
      name: 'общий',
    });
    expect((gw as AnyGw).registry.channels.filter((c) => c.slug === 'общий')).toHaveLength(2);
  });

  it('режим sfu пишется только голосовым', async () => {
    const { gw, owner } = await withOwnServer();
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'voice',
      name: 'через сервер',
      mode: 'sfu',
    });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'text',
      name: 'текст',
      mode: 'sfu',
    });
    expect((gw as AnyGw).registry.channels.find((c) => c.slug === 'через-сервер')!.mode).toBe(
      'sfu',
    );
    expect((gw as AnyGw).registry.channels.find((c) => c.slug === 'текст')!.mode).toBeUndefined();
  });

  it('в закрытый сервер канал заводит только разблокировавший', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { clientId: 'dev-owner' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'тайный', password: 'п' });
    const stranger = connect(gw, server, { clientId: 'dev-stranger' });
    await gw.handleChannelCreate(asSocket(stranger), {
      serverId: 'srv',
      type: 'text',
      name: 'вторжение',
    });
    expect((gw as AnyGw).registry.channels.some((c) => c.slug === 'вторжение')).toBe(false);
  });

  it('потолок в 50 каналов держится', async () => {
    const { gw, owner } = await withOwnServer();
    for (let i = 0; i < 60; i++) {
      await gw.handleChannelCreate(asSocket(owner), {
        serverId: 'srv',
        type: 'text',
        name: `ch${i}`,
      });
      vi.advanceTimersByTime(1000);
    }
    expect((gw as AnyGw).registry.channels).toHaveLength(50);
  });

  it('гость каналов не создаёт', async () => {
    const { gw, server } = await withOwnServer();
    const { token } = issueGuestToken('voice-obshchii');
    const guest = connect(gw, server, { guest: token });
    await gw.handleChannelCreate(asSocket(guest), {
      serverId: 'srv',
      type: 'text',
      name: 'гостевой',
    });
    expect((gw as AnyGw).registry.channels).toHaveLength(3);
  });
});

describe('channel-mode', () => {
  async function withVoice() {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev-owner' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'мой' });
    await gw.handleChannelCreate(asSocket(owner), { serverId: 'srv', type: 'voice', name: 'эфир' });
    await gw.handleChannelCreate(asSocket(owner), { serverId: 'srv', type: 'text', name: 'чат' });
    settle();
    server.clearAll();
    const voice = (gw as AnyGw).registry.channels.find((c) => c.slug === 'эфир')!;
    return { gw, server, owner, voice };
  }

  it('переводит канал на медиасервер и говорит об этом тем, кто в нём сидит', async () => {
    const { gw, server, owner, voice } = await withVoice();
    const talker = connect(gw, server, { id: 'talker' });
    gw.handleJoin(asSocket(talker), { room: 'эфир', name: 'Т' });
    talker.clear();

    await gw.handleChannelMode(asSocket(owner), { id: voice.id, mode: 'sfu' });
    expect(voice.mode).toBe('sfu');
    expect(talker.last('voice-mode')).toEqual({ room: 'эфир', mode: 'sfu' });
  });

  it('возврат на p2p стирает поле, а не пишет строку', async () => {
    const { gw, owner, voice } = await withVoice();
    await gw.handleChannelMode(asSocket(owner), { id: voice.id, mode: 'sfu' });
    await gw.handleChannelMode(asSocket(owner), { id: voice.id, mode: 'p2p' });
    expect(voice).not.toHaveProperty('mode');
  });

  it('тот же режим второй раз ничего не рассылает', async () => {
    const { gw, server, owner, voice } = await withVoice();
    const talker = connect(gw, server, { id: 'talker' });
    gw.handleJoin(asSocket(talker), { room: 'эфир', name: 'Т' });
    await gw.handleChannelMode(asSocket(owner), { id: voice.id, mode: 'p2p' });
    expect(talker.got('voice-mode')).toBe(false);
  });

  it('текстовому каналу режим не меняют', async () => {
    const { gw, owner } = await withVoice();
    const text = (gw as AnyGw).registry.channels.find((c) => c.slug === 'чат')!;
    await gw.handleChannelMode(asSocket(owner), { id: text.id, mode: 'sfu' });
    expect(text.mode).toBeUndefined();
  });

  it('дефолтный канал остаётся на p2p — он обязан работать без медиасервера', async () => {
    const { gw, owner } = await withVoice();
    const def = (gw as AnyGw).registry.channels.find((c) => c.slug === 'voice-obshchii')!;
    await gw.handleChannelMode(asSocket(owner), { id: def.id, mode: 'sfu' });
    expect(def.mode).toBeUndefined();
  });

  it('чужой канал не переключают', async () => {
    const { gw, server, voice } = await withVoice();
    const stranger = connect(gw, server, { clientId: 'dev-stranger' });
    await gw.handleChannelMode(asSocket(stranger), { id: voice.id, mode: 'sfu' });
    expect(voice.mode).toBeUndefined();
  });

  it('без id, с неизвестным режимом или по чужому id — ничего', async () => {
    const { gw, owner, voice } = await withVoice();
    await gw.handleChannelMode(asSocket(owner), { id: voice.id, mode: 'спутник' });
    await gw.handleChannelMode(asSocket(owner), { mode: 'sfu' });
    await gw.handleChannelMode(asSocket(owner), { id: 'нет-такого', mode: 'sfu' });
    expect(voice.mode).toBeUndefined();
  });
});

describe('channel-rename / channel-delete / channel-stats', () => {
  async function withChannels() {
    const { gw, server, registry } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev-owner' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'мой' });
    await gw.handleChannelCreate(asSocket(owner), { serverId: 'srv', type: 'text', name: 'чат' });
    await gw.handleChannelCreate(asSocket(owner), { serverId: 'srv', type: 'voice', name: 'эфир' });
    settle();
    server.clearAll();
    const text = (gw as AnyGw).registry.channels.find((c) => c.slug === 'чат')!;
    const voice = (gw as AnyGw).registry.channels.find((c) => c.slug === 'эфир')!;
    return { gw, server, owner, text, voice, registry };
  }

  it('переименование меняет имя, но не слаг — переписка и комната остаются', async () => {
    const { gw, owner, text } = await withChannels();
    await gw.handleChatJoin(asSocket(owner), { room: 'чат', name: 'Хозяин' });
    await gw.handleChatMessage(asSocket(owner), { text: 'до' });

    expect(
      await gw.handleChannelRename(asSocket(owner), { id: text.id, name: 'Болталка' }),
    ).toEqual({
      ok: true,
    });
    expect(text.name).toBe('Болталка');
    expect(text.slug).toBe('чат');
    expect(owner.data.chatRoom).toBe('chat:чат');
  });

  it('пустое имя отвергается внятно', async () => {
    const { gw, owner, text } = await withChannels();
    expect(await gw.handleChannelRename(asSocket(owner), { id: text.id, name: '   ' })).toEqual({
      ok: false,
      error: 'bad-name',
    });
  });

  it('то же имя — успех без лишней записи', async () => {
    const { gw, owner, text, registry } = await withChannels();
    const persist = vi.spyOn(registry, 'persist');
    expect(await gw.handleChannelRename(asSocket(owner), { id: text.id, name: 'чат' })).toEqual({
      ok: true,
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it('дефолтный и чужой каналы не переименовывают', async () => {
    const { gw, server, text } = await withChannels();
    const owner2 = connect(gw, server, { clientId: 'dev-owner' });
    const def = (gw as AnyGw).registry.channels.find((c) => c.slug === 'obshchii')!;
    expect(await gw.handleChannelRename(asSocket(owner2), { id: def.id, name: 'моё' })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    const stranger = connect(gw, server, { clientId: 'dev-stranger' });
    expect(await gw.handleChannelRename(asSocket(stranger), { id: text.id, name: 'моё' })).toEqual({
      ok: false,
      error: 'not-owner',
    });
  });

  it('несуществующий id и пустой id одинаково not-found', async () => {
    const { gw, owner } = await withChannels();
    expect(await gw.handleChannelRename(asSocket(owner), { name: 'моё' })).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(await gw.handleChannelRename(asSocket(owner), { id: 'нет', name: 'моё' })).toEqual({
      ok: false,
      error: 'not-found',
    });
  });

  it('голосовой канал с людьми не удаляется, опустевший — удаляется', async () => {
    const { gw, server, owner, voice } = await withChannels();
    const talker = connect(gw, server, { id: 'talker' });
    gw.handleJoin(asSocket(talker), { room: 'эфир', name: 'Т' });
    expect(await gw.handleChannelDelete(asSocket(owner), { id: voice.id })).toEqual({
      ok: false,
      error: 'occupied',
      occupants: 1,
    });
    gw.handleLeave(asSocket(talker));
    expect(await gw.handleChannelDelete(asSocket(owner), { id: voice.id })).toEqual({ ok: true });
  });

  it('текстовый канал уносит историю, читателей выписывают, слаг не наследуется', async () => {
    const { gw, server, owner, text } = await withChannels();
    const reader = connect(gw, server, { id: 'reader' });
    await gw.handleChatJoin(asSocket(reader), { room: 'чат', name: 'Читатель' });
    await gw.handleChatMessage(asSocket(reader), { text: 'привет' });
    reader.clear();

    expect(await gw.handleChannelDelete(asSocket(owner), { id: text.id })).toEqual({ ok: true });
    expect(reader.last('chat-closed')).toEqual({ slug: 'чат' });
    expect(reader.data.chatRoom).toBeUndefined();

    await gw.handleChannelCreate(asSocket(owner), { serverId: 'srv', type: 'text', name: 'чат' });
    const again = connect(gw, server, { id: 'again' });
    await gw.handleChatJoin(asSocket(again), { room: 'чат', name: 'Новичок' });
    expect(again.last('chat-history')).toMatchObject({ slug: 'чат', messages: [], more: false });
  });

  it('пустой id, дефолтный канал и гость — три разных отказа', async () => {
    const { gw, server, owner } = await withChannels();
    expect(await gw.handleChannelDelete(asSocket(owner), {})).toEqual({
      ok: false,
      error: 'not-found',
    });
    const def = (gw as AnyGw).registry.channels.find((c) => c.slug === 'obshchii')!;
    expect(await gw.handleChannelDelete(asSocket(owner), { id: def.id })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    const { token } = issueGuestToken('voice-obshchii');
    const guest = connect(gw, server, { guest: token });
    expect(await gw.handleChannelDelete(asSocket(guest), { id: def.id })).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });

  it('срез канала: сколько внутри людей и сколько сообщений', async () => {
    const { gw, server, owner, text, voice } = await withChannels();
    const reader = connect(gw, server, { id: 'reader' });
    await gw.handleChatJoin(asSocket(reader), { room: 'чат', name: 'Читатель' });
    await gw.handleChatMessage(asSocket(reader), { text: 'раз' });
    await gw.handleChatMessage(asSocket(reader), { text: 'два' });
    expect(await gw.handleChannelStats(asSocket(owner), { id: text.id })).toEqual({
      ok: true,
      occupants: 1,
      messages: 2,
    });
    expect(await gw.handleChannelStats(asSocket(owner), { id: voice.id })).toEqual({
      ok: true,
      occupants: 0,
      messages: 0,
    });
  });

  it('срез чужого канала не выдают', async () => {
    const { gw, server, text } = await withChannels();
    const stranger = connect(gw, server, { clientId: 'dev-stranger' });
    expect(await gw.handleChannelStats(asSocket(stranger), { id: text.id })).toEqual({ ok: false });
  });

  it('канал закрытого сервера отвечает «нет доступа» раньше, чем «не твой»', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev-owner' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'тайный', password: 'п' });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'text',
      name: 'скрытый',
    });
    const hidden = (gw as AnyGw).registry.channels.find((c) => c.slug === 'скрытый')!;

    // Тот же clientId, что у владельца: если бы владение проверялось первым,
    // ответ был бы «ok». Порядок проверок скрывает даже существование канала.
    const stranger = connect(gw, server, { clientId: 'dev-owner' });
    expect(
      await gw.handleChannelRename(asSocket(stranger), { id: hidden.id, name: 'моё' }),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });
});

// ── Инвайты и пропуск в медиасервер ───────────────────────────────────────

describe('invite-create', () => {
  it('выдаёт токен на видимый голосовой канал', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server);
    const res = gw.handleInviteCreate(asSocket(a), { room: 'voice-obshchii' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(verifyGuestToken(res.token)?.slug).toBe('voice-obshchii');
    expect(res.exp).toBeGreaterThan(Date.now());
  });

  it('на текстовый канал и на несуществующий — отказ', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server);
    expect(gw.handleInviteCreate(asSocket(a), { room: 'obshchii' })).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(gw.handleInviteCreate(asSocket(a), { room: 'нет' })).toEqual({
      ok: false,
      error: 'not-found',
    });
  });

  it('канал закрытого сервера не приглашает, пока пароль не введён', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'тайный', password: 'п' });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'voice',
      name: 'тайный эфир',
    });

    const stranger = connect(gw, server);
    expect(gw.handleInviteCreate(asSocket(stranger), { room: 'тайный-эфир' })).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(gw.handleInviteCreate(asSocket(owner), { room: 'тайный-эфир' })).toMatchObject({
      ok: true,
    });
  });

  it('гость инвайтов не раздаёт', async () => {
    const { gw, server } = await makeGateway();
    const { token } = issueGuestToken('voice-obshchii');
    const guest = connect(gw, server, { guest: token });
    expect(gw.handleInviteCreate(asSocket(guest), { room: 'voice-obshchii' })).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });

  it('ссылка в открытый канал раздаёт голос, в закрытый — только слух', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'тайный', password: 'п' });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'voice',
      name: 'тайный эфир',
    });

    const open = gw.handleInviteCreate(asSocket(owner), { room: 'voice-obshchii' });
    expect(open).toMatchObject({ ok: true, listen: false });
    if (open.ok) expect(verifyGuestToken(open.token)?.listen).toBe(false);

    // Пароль запирает и голос: приглашающий раздаёт по ссылке ровно то, что
    // имеет сам, а пароля он не отдавал.
    const locked = gw.handleInviteCreate(asSocket(owner), { room: 'тайный-эфир' });
    expect(locked).toMatchObject({ ok: true, listen: true });
    if (locked.ok) expect(verifyGuestToken(locked.token)?.listen).toBe(true);
  });
});

// ── Слушатель и «выгнать гостя» ───────────────────────────────────────────

describe('гость-слушатель', () => {
  it('в presence он помечен слушателем, а микрофон у него выключен', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const { token } = issueGuestToken('voice-obshchii', { listen: true });
    const guest = connect(gw, server, { id: 'guest', guest: token });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    gw.handleJoin(asSocket(guest), { room: 'voice-obshchii', name: 'Гость' });
    settle();

    expect(a.last('voice-presence')).toMatchObject({
      'voice-obshchii': [
        { id: 'a', micOn: true },
        { id: 'guest', guest: true, listen: true, micOn: false },
      ],
    });
    // Даже если клиент шлёт «микрофон включён»: включать ему нечего, и врать
    // об этом остальным — худшее, что тут можно сделать.
    gw.handleMediaUpdate(asSocket(guest), { micOn: true, camOn: false, screenOn: false });
    settle();
    expect(
      (a.last('voice-presence') as Record<string, { micOn: boolean }[]>)['voice-obshchii'][1],
    ).toMatchObject({ micOn: false });
  });

  it('остальные узнают о его правах вместе с ним самим', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    const { token } = issueGuestToken('voice-obshchii', { listen: true });
    const guest = connect(gw, server, { id: 'guest', guest: token });
    a.clear();
    gw.handleJoin(asSocket(guest), { room: 'voice-obshchii', name: 'Гость' });
    expect(a.last('peer-joined')).toEqual({
      id: 'guest',
      name: 'Гость',
      guest: true,
      listen: true,
    });
  });

  it('пропуск в медиасервер уходит с клеймом: отдавать дорожки ему там не дадут', async () => {
    process.env.SFU_URL = 'https://relay.example/sfu';
    process.env.SFU_SECRET = 'секрет-медиасервера';
    const { gw, server } = await makeGateway();
    const { token } = issueGuestToken('voice-obshchii-sfu', { listen: true });
    const guest = connect(gw, server, { guest: token });
    const res = await gw.handleSfuToken(asSocket(guest), { room: 'voice-obshchii-sfu' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const claims = JSON.parse(
      Buffer.from(res.token.split('.')[1], 'base64url').toString('utf8'),
    ) as { listen?: boolean };
    expect(claims.listen).toBe(true);
  });
});

describe('guest-kick', () => {
  /** Гость в эфире общего канала + обычный участник рядом. */
  async function withGuest(opts: { listen?: boolean } = {}) {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a', clientId: 'dev-a' });
    const { token } = issueGuestToken('voice-obshchii', opts);
    const guest = connect(gw, server, { id: 'guest', clientId: 'dev-guest', guest: token });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    gw.handleJoin(asSocket(guest), { room: 'voice-obshchii', name: 'Гость' });
    settle();
    server.clearAll();
    return { gw, server, a, guest, token };
  }

  it('любой не-гость выгоняет гостя: тому говорят прямо, остальным — как об уходе', async () => {
    const { gw, a, guest } = await withGuest();
    expect(gw.handleGuestKick(asSocket(a), { id: 'guest' })).toEqual({ ok: true });
    expect(guest.last('kicked')).toEqual({ room: 'voice-obshchii' });
    expect(a.last('peer-left')).toEqual({ id: 'guest' });
    expect(guest.rooms.has('voice-obshchii')).toBe(false);
  });

  it('по той же ссылке он не возвращается, пока не выйдет пауза', async () => {
    const { gw, server, a } = await withGuest();
    gw.handleGuestKick(asSocket(a), { id: 'guest' });
    const { token } = issueGuestToken('voice-obshchii');

    // Новая вкладка, новый сокет — но то же устройство.
    const again = server.connect({
      id: 'guest-2',
      auth: { clientId: 'dev-guest', guest: token },
    });
    gw.handleConnection(asSocket(again));
    expect(again.last('kicked')).toEqual({ room: 'voice-obshchii' });
    expect(again.got('voice-presence')).toBe(false);
    // И дверь с другой стороны: `join` сокетом, открытым до исключения.
    gw.handleJoin(asSocket(again), { room: 'voice-obshchii', name: 'Гость' });
    expect(again.rooms.has('voice-obshchii')).toBe(false);
  });

  it('час прошёл — пускают снова', async () => {
    const { gw, server, a } = await withGuest();
    gw.handleGuestKick(asSocket(a), { id: 'guest' });
    vi.advanceTimersByTime(60 * 60 * 1000 + 1000);
    const { token } = issueGuestToken('voice-obshchii');
    const again = server.connect({ id: 'guest-3', auth: { clientId: 'dev-guest', guest: token } });
    gw.handleConnection(asSocket(again));
    expect(again.got('kicked')).toBe(false);
    expect(again.got('voice-presence')).toBe(true);
  });

  it('гость гостя не выгоняет', async () => {
    const { gw, server, guest } = await withGuest();
    const { token } = issueGuestToken('voice-obshchii');
    const other = connect(gw, server, { id: 'guest-b', clientId: 'dev-b', guest: token });
    gw.handleJoin(asSocket(other), { room: 'voice-obshchii', name: 'Второй' });
    expect(gw.handleGuestKick(asSocket(other), { id: 'guest' })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(guest.got('kicked')).toBe(false);
  });

  it('не-гостя не выгнать вовсе, а вышедшего — уже не за что', async () => {
    const { gw, a, guest } = await withGuest();
    expect(gw.handleGuestKick(asSocket(a), { id: 'a' })).toEqual({
      ok: false,
      error: 'not-found',
    });
    gw.handleLeave(asSocket(guest));
    expect(gw.handleGuestKick(asSocket(a), { id: 'guest' })).toEqual({
      ok: false,
      error: 'not-found',
    });
  });

  it('из закрытого канала выгоняет только тот, кто ввёл пароль', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev-owner' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'тайный', password: 'п' });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'voice',
      name: 'тайный эфир',
    });
    const { token } = issueGuestToken('тайный-эфир', { listen: true });
    const guest = connect(gw, server, { id: 'guest', clientId: 'dev-guest', guest: token });
    gw.handleJoin(asSocket(guest), { room: 'тайный-эфир', name: 'Гость' });
    settle();

    // Канала он не видит — значит и того, кто в нём сидит, для него нет.
    const stranger = connect(gw, server, { id: 'stranger', clientId: 'dev-x' });
    expect(gw.handleGuestKick(asSocket(stranger), { id: 'guest' })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(gw.handleGuestKick(asSocket(owner), { id: 'guest' })).toEqual({ ok: true });
  });
});

describe('sfu-token', () => {
  async function withSfuChannel() {
    process.env.SFU_URL = 'https://relay.example/sfu';
    process.env.SFU_SECRET = 'секрет-медиасервера';
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev-owner' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'мой' });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'voice',
      name: 'эфир',
      mode: 'sfu',
    });
    settle();
    return { gw, server, owner };
  }

  it('выдаёт пропуск с адресом медиасервера и запоминает выдачу', async () => {
    const { gw, owner } = await withSfuChannel();
    const res = await gw.handleSfuToken(asSocket(owner), { room: 'эфир', name: 'Хозяин' });
    expect(res).toMatchObject({ ok: true, url: 'https://relay.example/sfu' });
    expect(owner.data.sfuPassRoom).toBe('эфир');
  });

  it('без настроенного медиасервера — unavailable', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server);
    expect(await gw.handleSfuToken(asSocket(a), { room: 'voice-obshchii-sfu' })).toEqual({
      ok: false,
      error: 'unavailable',
    });
  });

  it('настроен, но лежит — тоже unavailable: пропуск в мёртвый сервер хуже отказа', async () => {
    const { gw, owner } = await withSfuChannel();
    sfuHealthy.mockResolvedValue(false);
    expect(await gw.handleSfuToken(asSocket(owner), { room: 'эфир' })).toEqual({
      ok: false,
      error: 'unavailable',
    });
  });

  it('p2p-каналу пропуск не положен', async () => {
    const { gw, owner } = await withSfuChannel();
    expect(await gw.handleSfuToken(asSocket(owner), { room: 'voice-obshchii' })).toEqual({
      ok: false,
      error: 'not-sfu',
    });
  });

  it('вне комнаты и без указания комнаты — not-in-room', async () => {
    const { gw, owner } = await withSfuChannel();
    expect(await gw.handleSfuToken(asSocket(owner), {})).toEqual({
      ok: false,
      error: 'not-in-room',
    });
  });

  it('комнату берут из сокета, если её не назвали', async () => {
    const { gw, owner } = await withSfuChannel();
    gw.handleJoin(asSocket(owner), { room: 'эфир', name: 'Хозяин' });
    expect(await gw.handleSfuToken(asSocket(owner), {})).toMatchObject({ ok: true });
  });

  it('гость проходит в свою комнату и только в неё', async () => {
    const { gw, server } = await withSfuChannel();
    const { token } = issueGuestToken('эфир');
    const guest = connect(gw, server, { guest: token });
    expect(await gw.handleSfuToken(asSocket(guest), { room: 'эфир' })).toMatchObject({ ok: true });
    expect(await gw.handleSfuToken(asSocket(guest), { room: 'voice-obshchii-sfu' })).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });

  it('канал закрытого сервера запирает и медиасервер', async () => {
    process.env.SFU_URL = 'https://relay.example/sfu';
    process.env.SFU_SECRET = 'секрет';
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'тайный', password: 'п' });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'voice',
      name: 'тайный эфир',
      mode: 'sfu',
    });
    const stranger = connect(gw, server);
    expect(await gw.handleSfuToken(asSocket(stranger), { room: 'тайный-эфир' })).toEqual({
      ok: false,
      error: 'not-sfu',
    });
  });
});

// ── Голосовой канал ───────────────────────────────────────────────────────

describe('join / leave', () => {
  it('новичку — список пиров, остальным — уведомление', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    b.clear();
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B' });

    expect(b.last('peers')).toEqual([{ id: 'a', name: 'A' }]);
    expect(a.last('peer-joined')).toEqual({ id: 'b', name: 'B' });
    expect(b.got('peer-joined')).toBe(false);
  });

  it('пустая комната игнорируется, длинная — обрезается', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    gw.handleJoin(asSocket(a), { room: '   ' });
    expect(a.data.room).toBeUndefined();
    gw.handleJoin(asSocket(a), { room: 'к'.repeat(100) });
    expect((a.data.room as string).length).toBe(32);
  });

  it('повторный join выводит из прежней комнаты', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const watcher = connect(gw, server, { id: 'watcher' });
    gw.handleJoin(asSocket(watcher), { room: 'voice-obshchii', name: 'W' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    watcher.clear();
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii-sfu', name: 'A' });
    expect(watcher.last('peer-left')).toEqual({ id: 'a' });
    expect(a.rooms.has('voice-obshchii')).toBe(false);
  });

  it('перезагрузка страницы не двоит участника: призрак прошлой вкладки уходит', async () => {
    const { gw, server } = await makeGateway();
    const watcher = connect(gw, server, { id: 'watcher' });
    gw.handleJoin(asSocket(watcher), { room: 'voice-obshchii', name: 'W' });

    const first = connect(gw, server, { id: 'tab-1', clientId: 'dev-a' });
    gw.handleJoin(asSocket(first), { room: 'voice-obshchii', name: 'A' });
    // Вкладку перезагрузили: сокета уже нет, а комната о нём ещё помнит.
    gw.handleDisconnect(asSocket(first));
    server.all.delete('tab-1');
    watcher.clear();

    const second = connect(gw, server, { id: 'tab-2', clientId: 'dev-a' });
    gw.handleJoin(asSocket(second), { room: 'voice-obshchii', name: 'A' });
    expect(watcher.all('peer-left')).toContainEqual({ id: 'tab-1' });
    expect((second.last('peers') as { id: string }[]).map((p) => p.id)).toEqual(['watcher']);
  });

  it('второй живой таб того же устройства выводится штатно', async () => {
    const { gw, server } = await makeGateway();
    const first = connect(gw, server, { id: 'tab-1', clientId: 'dev-a' });
    gw.handleJoin(asSocket(first), { room: 'voice-obshchii', name: 'A' });
    const second = connect(gw, server, { id: 'tab-2', clientId: 'dev-a' });
    gw.handleJoin(asSocket(second), { room: 'voice-obshchii', name: 'A' });
    expect(first.data.room).toBeUndefined();
  });

  it('отвалившийся пир не попадает в список пиров новичка', async () => {
    const { gw, server } = await makeGateway();
    const ghost = connect(gw, server, { id: 'ghost' });
    gw.handleJoin(asSocket(ghost), { room: 'voice-obshchii', name: 'G' });
    server.all.delete('ghost');

    const fresh = connect(gw, server, { id: 'fresh' });
    gw.handleJoin(asSocket(fresh), { room: 'voice-obshchii', name: 'F' });
    expect(fresh.last('peers')).toEqual([]);
  });

  it('транспорт называет клиент, а молчащему его подставляет выданный пропуск', async () => {
    process.env.SFU_URL = 'https://relay.example/sfu';
    process.env.SFU_SECRET = 'секрет';
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A', transport: 'sfu' });
    expect(a.data.transport).toBe('sfu');

    const b = connect(gw, server, { id: 'b' });
    await gw.handleSfuToken(asSocket(b), { room: 'voice-obshchii-sfu', name: 'B' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii-sfu', name: 'B' });
    expect(b.data.transport).toBe('sfu');

    const c = connect(gw, server, { id: 'c' });
    gw.handleJoin(asSocket(c), { room: 'voice-obshchii', name: 'C' });
    expect(c.data.transport).toBe('p2p');
  });

  it('расщепление комнаты по транспортам попадает в лог', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A', transport: 'p2p' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B', transport: 'sfu' });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('split across transports'))).toBe(
      true,
    );
  });

  it('в канал закрытого сервера по одному слагу не войти', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'тайный', password: 'п' });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'voice',
      name: 'тайный эфир',
    });

    const stranger = connect(gw, server, { id: 'stranger' });
    gw.handleJoin(asSocket(stranger), { room: 'тайный-эфир', name: 'Ч' });
    expect(stranger.data.room).toBeUndefined();
  });

  it('комната-сирота (канал удалили под разговором) остаётся доступной', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    gw.handleJoin(asSocket(a), { room: 'ничей-эфир', name: 'A' });
    expect(a.data.room).toBe('ничей-эфир');
  });

  it('гость не заходит в чужую комнату, но в свою — да', async () => {
    const { gw, server } = await makeGateway();
    const { token } = issueGuestToken('voice-obshchii');
    const guest = connect(gw, server, { guest: token });
    gw.handleJoin(asSocket(guest), { room: 'voice-obshchii-sfu', name: 'Г' });
    expect(guest.data.room).toBeUndefined();
    gw.handleJoin(asSocket(guest), { room: 'voice-obshchii', name: 'Г' });
    expect(guest.data.room).toBe('voice-obshchii');
  });

  it('гость помечен гостем и в списке пиров, и в уведомлении', async () => {
    const { gw, server } = await makeGateway();
    const { token } = issueGuestToken('voice-obshchii');
    const guest = connect(gw, server, { id: 'guest', guest: token });
    gw.handleJoin(asSocket(guest), { room: 'voice-obshchii', name: 'Г' });

    const host = connect(gw, server, { id: 'host' });
    gw.handleJoin(asSocket(host), { room: 'voice-obshchii', name: 'Х' });
    expect(host.last('peers')).toEqual([{ id: 'guest', name: 'Г', guest: true }]);
    expect(guest.last('peer-joined')).toEqual({ id: 'host', name: 'Х' });
  });

  it('clientId из join принимают только если в handshake его не было', async () => {
    const { gw, server } = await makeGateway();
    const named = connect(gw, server, { id: 'a', clientId: 'dev-настоящий' });
    gw.handleJoin(asSocket(named), { room: 'voice-obshchii', name: 'A', clientId: 'dev-чужой' });
    expect(named.data.clientId).toBe('dev-настоящий');

    const silent = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(silent), { room: 'voice-obshchii', name: 'B', clientId: 'dev-старый' });
    expect(silent.data.clientId).toBe('dev-старый');
  });

  it('выход снимает состояние сокета и сообщает комнате', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a', clientId: 'dev-a' });
    const b = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B' });
    b.clear();
    gw.handleLeave(asSocket(a));
    expect(b.last('peer-left')).toEqual({ id: 'a' });
    expect(a.data.room).toBeUndefined();
    expect(a.data.transport).toBeUndefined();
  });

  it('выход из комнаты, в которой не был, — не событие', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B' });
    b.clear();
    gw.handleLeave(asSocket(a));
    expect(b.got('peer-left')).toBe(false);
  });
});

describe('presence', () => {
  it('состав эфиров рассылают всем, включая тех, кто сам не в звонке', async () => {
    const { gw, server } = await makeGateway();
    const talker = connect(gw, server, { id: 'talker' });
    const watcher = connect(gw, server, { id: 'watcher' });
    gw.handleJoin(asSocket(talker), { room: 'voice-obshchii', name: 'Т' });
    settle();
    expect(watcher.last('voice-presence')).toEqual({
      'voice-obshchii': [
        { id: 'talker', name: 'Т', micOn: true, deafened: false, transport: 'p2p' },
      ],
    });
  });

  it('пачка событий схлопывается в одну рассылку', async () => {
    const { gw, server } = await makeGateway();
    const watcher = connect(gw, server, { id: 'watcher' });
    for (let i = 0; i < 5; i++) {
      const s = connect(gw, server, { id: `p${i}` });
      gw.handleJoin(asSocket(s), { room: 'voice-obshchii', name: `P${i}` });
    }
    watcher.clear();
    settle();
    expect(watcher.all('voice-presence')).toHaveLength(1);
  });

  it('комнату, за которой нет видимого канала, посторонним не показывают', async () => {
    const { gw, server } = await makeGateway();
    const inventor = connect(gw, server, { id: 'inventor' });
    const watcher = connect(gw, server, { id: 'watcher' });
    gw.handleJoin(asSocket(inventor), { room: 'выдуманный-канал', name: 'И' });
    settle();
    expect(watcher.last('voice-presence')).toEqual({});
    // А сам он свою комнату видит: не показать было бы враньём.
    expect(Object.keys(inventor.last('voice-presence') as object)).toEqual(['выдуманный-канал']);
  });

  it('эфир закрытого сервера не виден до ввода пароля', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'тайный', password: 'п' });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'voice',
      name: 'тайный эфир',
    });
    gw.handleJoin(asSocket(owner), { room: 'тайный-эфир', name: 'Х' });

    const stranger = connect(gw, server, { id: 'stranger' });
    settle();
    expect(stranger.last('voice-presence')).toEqual({});
    expect(Object.keys(owner.last('voice-presence') as object)).toContain('тайный-эфир');
  });

  it('гостю достаётся только его комната', async () => {
    const { gw, server } = await makeGateway();
    const other = connect(gw, server, { id: 'other' });
    gw.handleJoin(asSocket(other), { room: 'voice-obshchii-sfu', name: 'O' });

    const { token } = issueGuestToken('voice-obshchii');
    const guest = connect(gw, server, { id: 'guest', guest: token });
    gw.handleJoin(asSocket(guest), { room: 'voice-obshchii', name: 'Г' });
    guest.clear();
    settle();
    expect(Object.keys(guest.last('voice-presence') as object)).toEqual(['voice-obshchii']);
  });

  it('безымянный участник показывается как Аноним', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii' });
    settle();
    const presence = a.last('voice-presence') as Record<string, { name: string }[]>;
    expect(presence['voice-obshchii'][0].name).toBe('Аноним');
  });
});

describe('media-update', () => {
  /** Заход + первое состояние медиа, как его шлёт живой клиент сразу после join. */
  async function inCall() {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    const watcher = connect(gw, server, { id: 'watcher' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B' });
    gw.handleMediaUpdate(asSocket(a), {});
    settle();
    server.clearAll();
    return { gw, server, a, b, watcher };
  }

  it('состояние камеры и экрана уходит в комнату, но не в presence', async () => {
    const { gw, a, b, watcher } = await inCall();
    gw.handleMediaUpdate(asSocket(a), { camOn: true, screenOn: true });
    expect(b.last('media-update')).toEqual({
      from: 'a',
      camOn: true,
      screenOn: true,
      micOn: true,
      deafened: false,
    });
    settle();
    expect(watcher.got('voice-presence')).toBe(false);
  });

  it('смена мута доходит до presence — индикаторы видны и вне эфира', async () => {
    const { gw, a, watcher } = await inCall();
    gw.handleMediaUpdate(asSocket(a), { micOn: false, deafened: true });
    settle();
    const presence = watcher.last('voice-presence') as Record<string, Record<string, unknown>[]>;
    expect(presence['voice-obshchii'].find((p) => p.id === 'a')).toMatchObject({
      micOn: false,
      deafened: true,
    });
  });

  it('повтор того же состояния на весь сервер не рассылают', async () => {
    const { gw, server, a, watcher } = await inCall();
    gw.handleMediaUpdate(asSocket(a), { micOn: false });
    settle();
    server.clearAll();
    gw.handleMediaUpdate(asSocket(a), { micOn: false });
    settle();
    expect(watcher.got('voice-presence')).toBe(false);
  });

  it('вне эфира media-update ничего не делает', async () => {
    const { gw, server } = await makeGateway();
    const loner = connect(gw, server, { id: 'loner' });
    gw.handleMediaUpdate(asSocket(loner), { micOn: false });
    expect(loner.data.micOn).toBeUndefined();
  });

  it('новый заход не тащит мут прошлого', async () => {
    const { gw, a } = await inCall();
    gw.handleMediaUpdate(asSocket(a), { micOn: false });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii-sfu', name: 'A' });
    expect(a.data.micOn).toBeUndefined();
  });
});

describe('сигналинг', () => {
  async function pair() {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B' });
    settle();
    server.clearAll();
    return { gw, server, a, b };
  }

  it('offer доходит адресату вместе с именем отправителя', async () => {
    const { gw, a, b } = await pair();
    gw.handleOffer(asSocket(a), { to: 'b', sdp: 'v=0' });
    expect(b.last('offer')).toEqual({ from: 'a', name: 'A', sdp: 'v=0' });
  });

  it('answer и ice-candidate ходят так же', async () => {
    const { gw, a, b } = await pair();
    gw.handleAnswer(asSocket(b), { to: 'a', sdp: 'v=0-ответ' });
    gw.handleIceCandidate(asSocket(a), { to: 'b', candidate: { candidate: 'host' } });
    expect(a.last('answer')).toEqual({ from: 'b', sdp: 'v=0-ответ' });
    expect(b.last('ice-candidate')).toEqual({ from: 'a', candidate: { candidate: 'host' } });
  });

  it('в чужую комнату сигнал не пересылают', async () => {
    const { gw, server, a } = await pair();
    const outsider = connect(gw, server, { id: 'outsider' });
    gw.handleJoin(asSocket(outsider), { room: 'voice-obshchii-sfu', name: 'O' });
    outsider.clear();
    gw.handleOffer(asSocket(a), { to: 'outsider', sdp: 'v=0' });
    expect(outsider.got('offer')).toBe(false);
  });

  it('несуществующий адресат, нестроковый адрес и отправитель вне комнаты — молчание', async () => {
    const { gw, server } = await makeGateway();
    const loner = connect(gw, server, { id: 'loner' });
    gw.handleOffer(asSocket(loner), { to: 'нет', sdp: 'v=0' });
    gw.handleOffer(asSocket(loner), { to: 42, sdp: 'v=0' });
    expect(loner.emitted).toHaveLength(0);
  });
});

describe('rename', () => {
  it('меняет подпись в эфире и в ростере чата', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'Старое' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B' });
    await gw.handleChatJoin(asSocket(a), { room: 'obshchii', name: 'Старое' });
    settle();
    server.clearAll();

    gw.handleRename(asSocket(a), { name: 'Новое' });
    expect(b.last('peer-renamed')).toEqual({ id: 'a', name: 'Новое' });
    expect(a.last('chat-roster')).toEqual(['Новое']);
    settle();
    const presence = b.last('voice-presence') as Record<string, { name: string }[]>;
    expect(presence['voice-obshchii'].map((p) => p.name)).toContain('Новое');
  });

  it('пустое имя и то же имя ничего не меняют', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B' });
    b.clear();
    gw.handleRename(asSocket(a), { name: '  ' });
    gw.handleRename(asSocket(a), { name: 'A' });
    expect(b.got('peer-renamed')).toBe(false);
  });
});

// ── Текстовый канал ───────────────────────────────────────────────────────

describe('chat-join', () => {
  it('новичку — история и ростер', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    await gw.handleChatJoin(asSocket(a), { room: 'obshchii', name: 'A' });
    await gw.handleChatMessage(asSocket(a), { text: 'первое' });

    const b = connect(gw, server, { id: 'b' });
    await gw.handleChatJoin(asSocket(b), { room: 'obshchii', name: 'B' });
    expect(b.last('chat-history')).toMatchObject({
      slug: 'obshchii',
      messages: [expect.objectContaining({ text: 'первое' })],
      more: false,
    });
    expect(b.last('chat-roster')).toEqual(['A', 'B']);
  });

  it('несуществующий канал отвечает chat-closed, а не тишиной', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    await gw.handleChatJoin(asSocket(a), { room: 'нет-такого', name: 'A' });
    expect(a.last('chat-closed')).toEqual({ slug: 'нет-такого' });
    expect(a.data.chatRoom).toBeUndefined();
  });

  it('канал закрытого сервера молча не пускает — вводить пароль никто не запрещал', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'тайный', password: 'п' });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'text',
      name: 'тайный чат',
    });

    const stranger = connect(gw, server, { id: 'stranger' });
    await gw.handleChatJoin(asSocket(stranger), { room: 'тайный-чат', name: 'Ч' });
    expect(stranger.data.chatRoom).toBeUndefined();
    expect(stranger.got('chat-closed')).toBe(false);
  });

  it('неудачный вход не выбрасывает из канала, где человек уже сидит', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    await gw.handleChatJoin(asSocket(a), { room: 'obshchii', name: 'A' });
    await gw.handleChatJoin(asSocket(a), { room: 'нет-такого', name: 'A' });
    expect(a.data.chatRoom).toBe('chat:obshchii');
  });

  it('переход в другой канал выводит из прежнего', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'мой' });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'text',
      name: 'второй',
    });

    const a = connect(gw, server, { id: 'a' });
    await gw.handleChatJoin(asSocket(a), { room: 'obshchii', name: 'A' });
    await gw.handleChatJoin(asSocket(a), { room: 'второй', name: 'A' });
    expect(a.data.chatRoom).toBe('chat:второй');
    expect(a.rooms.has('chat:obshchii')).toBe(false);
  });

  it('без имени человек становится Анонимом', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    await gw.handleChatJoin(asSocket(a), { room: 'obshchii' });
    expect(a.data.chatName).toBe('Аноним');
  });

  it('выход из чата обновляет ростер оставшимся', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    await gw.handleChatJoin(asSocket(a), { room: 'obshchii', name: 'A' });
    await gw.handleChatJoin(asSocket(b), { room: 'obshchii', name: 'B' });
    b.clear();
    gw.handleChatLeave(asSocket(a));
    expect(b.last('chat-roster')).toEqual(['B']);
  });

  it('гость в текстовые каналы не заходит', async () => {
    const { gw, server } = await makeGateway();
    const { token } = issueGuestToken('voice-obshchii');
    const guest = connect(gw, server, { guest: token });
    await gw.handleChatJoin(asSocket(guest), { room: 'obshchii', name: 'Г' });
    expect(guest.data.chatRoom).toBeUndefined();
  });
});

describe('chat-message', () => {
  async function inChat() {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    await gw.handleChatJoin(asSocket(a), { room: 'obshchii', name: 'A' });
    await gw.handleChatJoin(asSocket(b), { room: 'obshchii', name: 'B' });
    server.clearAll();
    return { gw, server, a, b };
  }

  it('сообщение доходит и до автора, и до соседа', async () => {
    const { gw, a, b } = await inChat();
    await gw.handleChatMessage(asSocket(a), { text: 'привет' });
    expect(a.last('chat')).toMatchObject({ name: 'A', text: 'привет' });
    expect(b.last('chat')).toMatchObject({ name: 'A', text: 'привет' });
  });

  it('пустое сообщение без вложения не отправляется', async () => {
    const { gw, a } = await inChat();
    await gw.handleChatMessage(asSocket(a), { text: '   ' });
    await gw.handleChatMessage(asSocket(a), {});
    expect(a.got('chat')).toBe(false);
  });

  it('вне канала писать нечем', async () => {
    const { gw, server } = await makeGateway();
    const loner = connect(gw, server, { id: 'loner' });
    await gw.handleChatMessage(asSocket(loner), { text: 'ау' });
    expect(loner.got('chat')).toBe(false);
  });

  it('текст режется до 500 символов', async () => {
    const { gw, a } = await inChat();
    await gw.handleChatMessage(asSocket(a), { text: 'я'.repeat(900) });
    expect((a.last('chat') as { text: string }).text).toHaveLength(500);
  });

  it('вложение берут из реестра, а не из тела сообщения', async () => {
    const { gw, a } = await inChat();
    await putUpload('up-1');
    await gw.handleChatMessage(asSocket(a), { text: '', uploadId: 'up-1' });
    expect((a.last('chat') as { attachment: Attachment }).attachment).toMatchObject({
      url: '/uploads/up-1',
      kind: 'image',
    });

    a.clear();
    await gw.handleChatMessage(asSocket(a), { text: '', uploadId: 'нет-такого' });
    expect(a.got('chat')).toBe(false);
  });

  it('спойлер — метка сообщения: общий реестр не мутируется', async () => {
    const { gw, a } = await inChat();
    const stored: Attachment = {
      url: '/uploads/up-1',
      name: 'кот.png',
      size: 10,
      mime: 'image/png',
      kind: 'image',
    };
    await putUpload('up-1');
    await gw.handleChatMessage(asSocket(a), { text: '', uploadId: 'up-1', spoiler: true });
    expect((a.last('chat') as { attachment: Attachment }).attachment.spoiler).toBe(true);
    expect(stored.spoiler).toBeUndefined();
  });

  it('ответ хранит снимок цитаты — правка оригинала его не трогает', async () => {
    const { gw, a, b } = await inChat();
    await gw.handleChatMessage(asSocket(a), { text: 'исходное' });
    const src = a.last('chat') as { id: string };
    await gw.handleChatMessage(asSocket(b), { text: 'ответ', replyTo: src.id });
    const reply = b.last('chat') as { replyTo?: { id: string; name: string; text: string } };
    expect(reply.replyTo).toEqual({ id: src.id, name: 'A', text: 'исходное' });

    await gw.handleChatEdit(asSocket(a), { id: src.id, text: 'переписал' });
    expect(reply.replyTo!.text).toBe('исходное');
  });

  it('ответ на несуществующее сообщение просто теряет цитату', async () => {
    const { gw, a } = await inChat();
    await gw.handleChatMessage(asSocket(a), { text: 'ответ', replyTo: 'нет-такого' });
    expect(a.last('chat')).not.toHaveProperty('replyTo');
  });

  it('в канал входят на последнюю страницу, остальное подтягивают вверх', async () => {
    const { gw, server, a } = await inChat();
    for (let i = 0; i < 60; i++) {
      await gw.handleChatMessage(asSocket(a), { text: `${i}` });
      vi.advanceTimersByTime(200);
    }
    const fresh = connect(gw, server, { id: 'fresh' });
    await gw.handleChatJoin(asSocket(fresh), { room: 'obshchii', name: 'F' });

    // Пятьдесят свежих и честное «выше есть ещё» — а не обрезанная лента,
    // молча притворяющаяся всей историей, как было до базы.
    const page = fresh.last('chat-history') as {
      messages: { text: string; id: string; ts: number }[];
      more: boolean;
    };
    expect(page.messages).toHaveLength(50);
    expect(page.messages[0].text).toBe('10');
    expect(page.messages[49].text).toBe('59');
    expect(page.more).toBe(true);

    const top = page.messages[0];
    const older = await gw.handleChatHistoryMore(asSocket(fresh), {
      beforeTs: top.ts,
      beforeId: top.id,
    });
    expect(older.messages.map((m) => m.text)).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
    ]);
    // Выше десятого — начало канала, и это разные вещи с «страница кончилась».
    expect(older.more).toBe(false);
  });

  it('пинг активности схлопывается и уходит тем, кому канал виден', async () => {
    const { gw, server, a } = await inChat();
    const watcher = connect(gw, server, { id: 'watcher' });
    await gw.handleChatMessage(asSocket(a), { text: 'раз' });
    await gw.handleChatMessage(asSocket(a), { text: 'два' });
    settle();
    expect(watcher.all('chat-activity')).toHaveLength(1);
    expect(watcher.last('chat-activity')).toMatchObject({ slug: 'obshchii' });
  });

  it('активность в канале закрытого сервера посторонним не рассылают', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'тайный', password: 'п' });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'text',
      name: 'тайный чат',
    });
    await gw.handleChatJoin(asSocket(owner), { room: 'тайный-чат', name: 'Х' });
    const stranger = connect(gw, server, { id: 'stranger' });
    settle();
    server.clearAll();

    await gw.handleChatMessage(asSocket(owner), { text: 'секрет' });
    settle();
    expect(stranger.got('chat-activity')).toBe(false);
    expect(owner.got('chat-activity')).toBe(true);
  });

  it('время последней реплики приезжает вместе с реестром каналов', async () => {
    const { gw, server, a } = await inChat();
    await gw.handleChatMessage(asSocket(a), { text: 'привет' });
    const ts = (a.last('chat') as { ts: number }).ts;
    const fresh = connect(gw, server, { id: 'fresh' });
    gw.handleConnection(asSocket(fresh));
    const channels = fresh.last('channels') as { slug: string; lastTs?: number }[];
    expect(channels.find((c) => c.slug === 'obshchii')?.lastTs).toBe(ts);
  });

  it('гость в чат не пишет', async () => {
    const { gw, server } = await makeGateway();
    const { token } = issueGuestToken('voice-obshchii');
    const guest = connect(gw, server, { guest: token });
    guest.data.chatRoom = 'chat:obshchii';
    await gw.handleChatMessage(asSocket(guest), { text: 'вторжение' });
    expect(guest.got('chat')).toBe(false);
  });
});

describe('chat-edit / chat-delete / chat-react / chat-typing', () => {
  async function withMessage() {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    await gw.handleChatJoin(asSocket(a), { room: 'obshchii', name: 'A' });
    await gw.handleChatJoin(asSocket(b), { room: 'obshchii', name: 'B' });
    await gw.handleChatMessage(asSocket(a), { text: 'исходное' });
    const id = (a.last('chat') as { id: string }).id;
    server.clearAll();
    return { gw, server, a, b, id };
  }

  it('автор правит своё сообщение', async () => {
    const { gw, a, b, id } = await withMessage();
    await gw.handleChatEdit(asSocket(a), { id, text: 'переписал' });
    expect(b.last('chat-edited')).toMatchObject({ id, text: 'переписал' });
    expect((b.last('chat-edited') as { editedTs: number }).editedTs).toBeGreaterThan(0);
  });

  it('чужое сообщение не правят', async () => {
    const { gw, b, id } = await withMessage();
    await gw.handleChatEdit(asSocket(b), { id, text: 'подмена' });
    expect(b.got('chat-edited')).toBe(false);
  });

  it('пустой текст правки и правку без id игнорируют', async () => {
    const { gw, a, id } = await withMessage();
    await gw.handleChatEdit(asSocket(a), { id, text: '   ' });
    await gw.handleChatEdit(asSocket(a), { text: 'без id' });
    expect(a.got('chat-edited')).toBe(false);
  });

  it('автор удаляет своё сообщение, и оно пропадает из истории', async () => {
    const { gw, server, a, b, id } = await withMessage();
    await gw.handleChatDelete(asSocket(a), { id });
    expect(b.last('chat-deleted')).toEqual({ id });
    const fresh = connect(gw, server, { id: 'fresh' });
    await gw.handleChatJoin(asSocket(fresh), { room: 'obshchii', name: 'F' });
    expect(fresh.last('chat-history')).toMatchObject({ messages: [], more: false });
  });

  it('чужое и несуществующее сообщение не удаляют', async () => {
    const { gw, a, b, id } = await withMessage();
    await gw.handleChatDelete(asSocket(b), { id });
    await gw.handleChatDelete(asSocket(a), { id: 'нет-такого' });
    await gw.handleChatDelete(asSocket(a), {});
    expect(a.got('chat-deleted')).toBe(false);
  });

  it('реакция ставится и снимается тем же нажатием', async () => {
    const { gw, a, b, id } = await withMessage();
    await gw.handleChatReact(asSocket(b), { id, emoji: '🔥' });
    expect(a.last('chat-reaction')).toEqual({ id, reactions: { '🔥': ['B'] } });
    await gw.handleChatReact(asSocket(b), { id, emoji: '🔥' });
    expect(a.last('chat-reaction')).toEqual({ id, reactions: {} });
  });

  it('реакции складываются по участникам', async () => {
    const { gw, a, b, id } = await withMessage();
    await gw.handleChatReact(asSocket(a), { id, emoji: '👍' });
    await gw.handleChatReact(asSocket(b), { id, emoji: '👍' });
    expect(a.last('chat-reaction')).toEqual({ id, reactions: { '👍': ['A', 'B'] } });
  });

  it('эмодзи вне белого списка и чужой id не проходят', async () => {
    const { gw, a, id } = await withMessage();
    await gw.handleChatReact(asSocket(a), { id, emoji: '🍆' });
    await gw.handleChatReact(asSocket(a), { id: 'нет', emoji: '👍' });
    expect(a.got('chat-reaction')).toBe(false);
  });

  it('«печатает» уходит соседям, но не себе', async () => {
    const { gw, a, b } = await withMessage();
    gw.handleChatTyping(asSocket(a));
    expect(b.last('chat-typing')).toEqual({ name: 'A' });
    expect(a.got('chat-typing')).toBe(false);
  });

  it('вне канала правка, удаление, реакция и «печатает» молчат', async () => {
    const { gw, server } = await makeGateway();
    const loner = connect(gw, server, { id: 'loner' });
    gw.handleChatTyping(asSocket(loner));
    await gw.handleChatEdit(asSocket(loner), { id: 'x', text: 'y' });
    await gw.handleChatDelete(asSocket(loner), { id: 'x' });
    await gw.handleChatReact(asSocket(loner), { id: 'x', emoji: '👍' });
    expect(loner.emitted).toHaveLength(0);
  });
});

// ── Общие заслоны ─────────────────────────────────────────────────────────

describe('ограничение частоты', () => {
  it('бакет пустеет и гасит флуд, а через секунду наполняется снова', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    await gw.handleChatJoin(asSocket(a), { room: 'obshchii', name: 'A' });
    server.clearAll();

    for (let i = 0; i < 60; i++) await gw.handleChatMessage(asSocket(a), { text: `${i}` });
    const sent = a.all('chat').length;
    expect(sent).toBeLessThan(60);
    expect(sent).toBeGreaterThan(0);

    vi.advanceTimersByTime(1000);
    a.clear();
    await gw.handleChatMessage(asSocket(a), { text: 'после паузы' });
    expect(a.got('chat')).toBe(true);
  });

  it('негоциацию бакет не трогает: она бывает бурстовой законно', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B' });
    b.clear();
    for (let i = 0; i < 200; i++) {
      gw.handleIceCandidate(asSocket(a), { to: 'b', candidate: i });
    }
    expect(b.all('ice-candidate')).toHaveLength(200);
  });
});

describe('voice-diag', () => {
  it('веха клиента уходит в лог одной строкой', async () => {
    const log = vi.spyOn(Logger.prototype, 'log');
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    gw.handleVoiceDiag(asSocket(a), { event: 'sfu-fallback\nподмена', detail: 'таймаут  ice' });
    const line = log.mock.calls.map((c) => String(c[0])).find((s) => s.includes('diag'));
    expect(line).toBeDefined();
    expect(line).not.toContain('\n');
    expect(line).toContain('таймаут ice');
  });

  it('пустая веха в лог не идёт', async () => {
    const log = vi.spyOn(Logger.prototype, 'log');
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    log.mockClear();
    gw.handleVoiceDiag(asSocket(a), { event: '   ' });
    gw.handleVoiceDiag(asSocket(a), {});
    expect(log.mock.calls.some((c) => String(c[0]).includes('diag'))).toBe(false);
  });
});

// ── Личность ──────────────────────────────────────────────────────────────

/**
 * Гейтвей узнаёт говорящего по куке сессии, а не по тому, как он представился.
 * Разница здесь ровно одна и вся суть в ней: пока имя приходит из тела
 * сообщения, лицо рядом с ним — украшение, потому что назваться чужим именем
 * можно одним `join`.
 */
describe('личность в эфире и в ленте', () => {
  it('имя в голосовом берётся у сервера, а не из тела', async () => {
    const { gw, server } = await makeGateway();
    const { cookie, fingerprint } = await personCookie('Аня');
    const a = await connectAs(gw, server, cookie, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B' });
    b.clear();

    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'Самозванец' });

    expect(b.last('peer-joined')).toMatchObject({ name: 'Аня', fingerprint });
    settle();
    const presence = b.last('voice-presence') as Record<
      string,
      { name: string; fingerprint?: string }[]
    >;
    expect(presence['voice-obshchii']).toContainEqual(
      expect.objectContaining({ name: 'Аня', fingerprint }),
    );
  });

  it('реплика уносит с собой отпечаток автора', async () => {
    // Из него рисуется лицо в ленте — и оно должно приезжать с сообщением, а
    // не подбираться клиентом по имени: имена не уникальны.
    const { gw, server } = await makeGateway();
    const { cookie, fingerprint } = await personCookie('Аня');
    const a = await connectAs(gw, server, cookie, { id: 'a' });
    await gw.handleChatJoin(asSocket(a), { room: 'obshchii', name: 'Самозванец' });
    a.clear();

    await gw.handleChatMessage(asSocket(a), { text: 'привет' });
    expect(a.last('chat')).toMatchObject({ name: 'Аня', fingerprint, text: 'привет' });

    // И в истории тоже: лента открывается ею, а не только живыми событиями.
    const c = await connectAs(gw, server, cookie, { id: 'c' });
    await gw.handleChatJoin(asSocket(c), { room: 'obshchii' });
    const history = c.last('chat-history') as { messages: { fingerprint?: string }[] };
    expect(history.messages.at(-1)?.fingerprint).toBe(fingerprint);
  });

  it('тёзка не правит и не удаляет чужое', async () => {
    // Ровно тот случай, ради которого всё и затевалось: ники не уникальны, и
    // раньше «тот же тег» означало «тот же человек».
    const { gw, server } = await makeGateway();
    const mine = await personCookie('Аня');
    const other = await personCookie('Аня');
    const a = await connectAs(gw, server, mine.cookie, { id: 'a' });
    const b = await connectAs(gw, server, other.cookie, { id: 'b' });
    await gw.handleChatJoin(asSocket(a), { room: 'obshchii' });
    await gw.handleChatJoin(asSocket(b), { room: 'obshchii' });
    await gw.handleChatMessage(asSocket(a), { text: 'моё' });
    const id = (a.last('chat') as { id: string }).id;
    server.clearAll();

    await gw.handleChatEdit(asSocket(b), { id, text: 'подменённое' });
    await gw.handleChatDelete(asSocket(b), { id });
    expect(a.got('chat-edited')).toBe(false);
    expect(a.got('chat-deleted')).toBe(false);

    // А своё — правится: проверка отличает чужое от любого.
    await gw.handleChatEdit(asSocket(a), { id, text: 'поправленное' });
    expect(a.last('chat-edited')).toMatchObject({ id, text: 'поправленное' });
  });

  it('гость по инвайту остаётся при своём имени и без лица', async () => {
    // Ему личность взять неоткуда: ворота инсталляции он не проходил, за него
    // ручается токен приглашения — и подписывать челлендж ему нечем.
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    await gw.handleChatJoin(asSocket(a), { room: 'obshchii', name: 'Гость' });
    a.clear();

    await gw.handleChatMessage(asSocket(a), { text: 'здравствуйте' });
    const msg = a.last('chat') as { name: string; fingerprint?: string };
    expect(msg.name).toBe('Гость');
    expect(msg.fingerprint).toBeUndefined();
  });

  it('переименование перечитывает имя из базы, а не верит телу', async () => {
    // `rename` для личности — это «сходите перечитайте», а не «зовите меня
    // так»: имя меняется отдельным запросом, и сокет узнаёт о смене последним.
    const { gw, server, identities } = await makeGateway();
    const { cookie } = await personCookie('Аня');
    const a = await connectAs(gw, server, cookie, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii' });
    b.clear();

    const speaker = a.data.identity as { id: string };
    await identities.rename(speaker.id, 'Аня-Б');
    await gw.handleRename(asSocket(a), { name: 'Королева' });

    expect(b.last('peer-renamed')).toEqual({ id: 'a', name: 'Аня-Б' });
  });
});

// ── Права на реестр ───────────────────────────────────────────────────────

/** Сделать человека владельцем инсталляции — тем же путём, что и ссылка. */
async function makeOwner(owner: OwnerService, identityId: string): Promise<void> {
  const { token } = await owner.issue();
  await owner.claim(token, identityId);
}

describe('права на сервер: личность и владелец инсталляции', () => {
  it('созданный сервер записан на личность, а не на устройство', async () => {
    const { gw, server, registry } = await makeGateway();
    const anya = await personCookie('Аня');
    const a = await connectAs(gw, server, anya.cookie, { id: 'a', clientId: 'dev-a' });

    await gw.handleServerCreate(asSocket(a), { id: 'srv', name: 'мой' });
    await registry.flush();

    expect(await db.getRepository(ServerRow).findOneBy({ id: 'srv' })).toMatchObject({
      creatorIdentityId: anya.identityId,
      creatorId: null,
    });
  });

  it('свой сервер правится с другого устройства того же человека', async () => {
    // Ровно то, ради чего права переезжали с clientId: раньше сервер оставался
    // у той вкладки, в которой его создали.
    const { gw, server } = await makeGateway();
    const anya = await personCookie('Аня');
    const laptop = await connectAs(gw, server, anya.cookie, { id: 'a', clientId: 'dev-a' });
    await gw.handleServerCreate(asSocket(laptop), { id: 'srv', name: 'мой' });
    settle();

    const phone = await connectAs(gw, server, anya.cookie, {
      id: 'b',
      clientId: 'dev-b',
      keep: true,
    });
    const seen = (phone.last('servers') as { id: string; mine?: boolean }[]).find(
      (s) => s.id === 'srv',
    );
    expect(seen?.mine).toBe(true);
    expect(await gw.handleServerDelete(asSocket(phone), { id: 'srv' })).toEqual({ ok: true });
  });

  it('чужой человек чужой сервер не удаляет', async () => {
    const { gw, server } = await makeGateway();
    const anya = await personCookie('Аня');
    const boris = await personCookie('Борис');
    const a = await connectAs(gw, server, anya.cookie, { id: 'a' });
    await gw.handleServerCreate(asSocket(a), { id: 'srv', name: 'мой' });

    const b = await connectAs(gw, server, boris.cookie, { id: 'b' });
    expect(await gw.handleServerDelete(asSocket(b), { id: 'srv' })).toEqual({
      ok: false,
      error: 'not-owner',
    });
  });

  it('владелец инсталляции правит чужое', async () => {
    const { gw, server, owner } = await makeGateway();
    const anya = await personCookie('Аня');
    const boris = await personCookie('Борис');
    const a = await connectAs(gw, server, anya.cookie, { id: 'a' });
    await gw.handleServerCreate(asSocket(a), { id: 'srv', name: 'чужой' });

    await makeOwner(owner, boris.identityId);
    const b = await connectAs(gw, server, boris.cookie, { id: 'b', keep: true });

    const seen = (b.last('servers') as { id: string; mine?: boolean }[]).find(
      (s) => s.id === 'srv',
    );
    expect(seen?.mine).toBe(true);
    expect(await gw.handleServerDelete(asSocket(b), { id: 'srv' })).toEqual({ ok: true });
  });

  it('власть, взятая под живым сокетом, действует сразу — и сразу теряется', async () => {
    // Иначе бывший владелец удалял бы чужое до переподключения, а новый ждал бы
    // перезагрузки страницы, чтобы увидеть свои права.
    const { gw, server, owner } = await makeGateway();
    const anya = await personCookie('Аня');
    const boris = await personCookie('Борис');
    const a = await connectAs(gw, server, anya.cookie, { id: 'a' });
    const b = await connectAs(gw, server, boris.cookie, { id: 'b' });
    await gw.handleServerCreate(asSocket(a), { id: 'srv', name: 'мой' });

    await makeOwner(owner, boris.identityId);
    await gw.syncOwner();
    settle();
    const mine = (sock: { last(e: string): unknown }) =>
      (sock.last('servers') as { id: string; mine?: boolean }[]).find((s) => s.id === 'srv')?.mine;
    expect(mine(b)).toBe(true);

    // Ссылку перевыпустили и открыла её Аня — Борис перестал быть владельцем.
    await makeOwner(owner, anya.identityId);
    await gw.syncOwner();
    settle();
    expect(mine(b)).toBeUndefined();
    expect(await gw.handleServerDelete(asSocket(b), { id: 'srv' })).toEqual({
      ok: false,
      error: 'not-owner',
    });
  });

  it('унаследованный сервер остаётся за своим устройством', async () => {
    // Переписать clientId в личность нечем, поэтому старое правило для старых
    // записей продолжает работать — и не открывается чужой личностью с тем же
    // идентификатором.
    const { gw, server } = await makeGateway({
      servers: [{ id: 'old', name: 'старый', removable: true, creatorId: 'dev-old' }],
    });
    const anya = await personCookie('Аня');
    const stranger = await connectAs(gw, server, anya.cookie, { id: 'a', clientId: 'dev-new' });
    expect(await gw.handleServerDelete(asSocket(stranger), { id: 'old' })).toEqual({
      ok: false,
      error: 'not-owner',
    });

    const sameDevice = connect(gw, server, { id: 'b', clientId: 'dev-old' });
    expect(await gw.handleServerDelete(asSocket(sameDevice), { id: 'old' })).toEqual({ ok: true });
  });
});

// ── Модерация ─────────────────────────────────────────────────────────────

/** Попытка подключения вместе с тем, чем ответила дверь. */
async function knock(gw: SignalingGateway, server: FakeServer, cookie: string, id?: string) {
  const sock = server.connect({ id, cookie });
  const refused = await server.run(sock);
  if (!refused) gw.handleConnection(asSocket(sock));
  return { sock, refused };
}

/** Свой сервер с текстовым каналом — то, что модерирует его создатель. */
async function ownServer(gw: SignalingGateway, sock: FakeSocket, id = 'srv') {
  await gw.handleServerCreate(asSocket(sock), { id, name: 'мой' });
  await gw.handleChannelCreate(asSocket(sock), { serverId: id, type: 'text', name: 'болталка' });
  await gw.handleChannelCreate(asSocket(sock), { serverId: id, type: 'voice', name: 'эфир' });
  settle();
}

/** Сказать что-нибудь в канале и вернуть id сказанного. */
async function say(gw: SignalingGateway, sock: FakeSocket, slug: string, text: string) {
  await gw.handleChatJoin(asSocket(sock), { room: slug });
  await gw.handleChatMessage(asSocket(sock), { text });
  return (sock.last('chat') as { id: string }).id;
}

describe('бан', () => {
  it('забаненного на инсталляцию не пускают на порог', async () => {
    const { gw, server, roles, owner } = await makeGateway();
    const anya = await personCookie('Аня');
    const boss = await personCookie('Хозяин');
    await makeOwner(owner, boss.identityId);
    await roles.ban(anya.identityId, null, boss.identityId);

    const { sock, refused } = await knock(gw, server, anya.cookie);
    // Причина уезжает текстом ошибки: это единственный канал, который у
    // отвергнутого сокета есть, и без неё человек видит вечное «соединяюсь».
    expect(refused?.message).toBe('banned');
    expect(sock.got('servers')).toBe(false);
  });

  it('бан вступает в силу под живым сокетом, а не со следующего входа', async () => {
    // Иначе он длился бы ровно столько, сколько человек не перезагружает
    // страницу, — то есть весь скандал, из-за которого его и банили.
    const { gw, server, roles, owner } = await makeGateway();
    const anya = await personCookie('Аня');
    const boss = await personCookie('Хозяин');
    await makeOwner(owner, boss.identityId);
    const a = await connectAs(gw, server, anya.cookie, { id: 'a' });
    const b = await connectAs(gw, server, boss.cookie, { id: 'b' });

    const id = await say(gw, a, 'obshchii', 'здрасьте');
    await gw.handleChatJoin(asSocket(b), { room: 'obshchii' });
    expect(await gw.handleModerationBan(asSocket(b), { id, everywhere: true })).toEqual({ ok: true });

    expect(a.got('banned')).toBe(true);
    expect(a.disconnected).toBe(true);
    expect((await roles.rightsOf(anya.identityId)).banned).toBe(true);
  });

  it('бан со своего сервера прячет сервер и выписывает из его каналов', async () => {
    const { gw, server } = await makeGateway();
    const host = await personCookie('Хозяйка');
    const guest = await personCookie('Гость');
    const h = await connectAs(gw, server, host.cookie, { id: 'h' });
    await ownServer(gw, h);

    const g = await connectAs(gw, server, guest.cookie, { id: 'g' });
    const id = await say(gw, g, 'болталка', 'привет');
    gw.handleJoin(asSocket(g), { room: 'эфир' });
    await gw.handleChatJoin(asSocket(h), { room: 'болталка' });
    g.clear();

    expect(await gw.handleModerationBan(asSocket(h), { id })).toEqual({ ok: true });

    // С причиной: канал на месте, ушёл человек. Клиент по ней и говорит правду
    // вместо «канал удалён».
    expect(g.last('chat-closed')).toEqual({ slug: 'болталка', reason: 'banned' });
    expect(g.data.room).toBeUndefined();
    const servers = g.last('servers') as { id: string }[];
    expect(servers.map((s) => s.id)).toEqual([MAIN]);
    // Остальная инсталляция при этом на месте: бан со своего сервера — не бан
    // со всей инсталляции.
    const channels = g.last('channels') as { serverId: string }[];
    expect(channels.every((c) => c.serverId === MAIN)).toBe(true);
    expect(g.disconnected).toBe(false);
  });

  it('забаненный не возвращается ни в эфир, ни в реестр', async () => {
    const { gw, server, roles } = await makeGateway();
    const host = await personCookie('Хозяйка');
    const guest = await personCookie('Гость');
    const h = await connectAs(gw, server, host.cookie, { id: 'h' });
    await ownServer(gw, h);
    await roles.ban(guest.identityId, 'srv', host.identityId);

    const { sock: g } = await knock(gw, server, guest.cookie, 'g');
    expect((g.last('servers') as { id: string }[]).map((s) => s.id)).toEqual([MAIN]);

    gw.handleJoin(asSocket(g), { room: 'эфир' });
    expect(g.data.room).toBeUndefined();
    await gw.handleChatJoin(asSocket(g), { room: 'болталка' });
    expect(g.data.chatRoom).toBeUndefined();
  });

  it('создатель сервера банит только со своего сервера', async () => {
    const { gw, server } = await makeGateway();
    const host = await personCookie('Хозяйка');
    const guest = await personCookie('Гость');
    const h = await connectAs(gw, server, host.cookie, { id: 'h' });
    await ownServer(gw, h);
    const g = await connectAs(gw, server, guest.cookie, { id: 'g' });
    const id = await say(gw, g, 'болталка', 'привет');
    await gw.handleChatJoin(asSocket(h), { room: 'болталка' });

    expect(await gw.handleModerationBan(asSocket(h), { id, everywhere: true })).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });

  it('в чужом канале модерировать нечего', async () => {
    const { gw, server } = await makeGateway();
    const host = await personCookie('Хозяйка');
    const other = await personCookie('Посторонний');
    const h = await connectAs(gw, server, host.cookie, { id: 'h' });
    await ownServer(gw, h);
    const o = await connectAs(gw, server, other.cookie, { id: 'o' });
    const id = await say(gw, h, 'болталка', 'моё слово');
    await gw.handleChatJoin(asSocket(o), { room: 'болталка' });

    expect(await gw.handleModerationBan(asSocket(o), { id })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await gw.handleModerationBans(asSocket(o), { server: 'srv' })).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });

  it('владельца инсталляции не банят', async () => {
    // Строка бана на инсталляцию и строка владения — одна и та же пара ключей:
    // забаненный владелец означал бы инсталляцию вообще без владельца.
    const { gw, server, owner } = await makeGateway();
    const host = await personCookie('Хозяйка');
    const boss = await personCookie('Хозяин');
    await makeOwner(owner, boss.identityId);
    const h = await connectAs(gw, server, host.cookie, { id: 'h' });
    await ownServer(gw, h);
    const b = await connectAs(gw, server, boss.cookie, { id: 'b' });
    const id = await say(gw, b, 'болталка', 'зашёл посмотреть');
    await gw.handleChatJoin(asSocket(h), { room: 'болталка' });

    expect(await gw.handleModerationBan(asSocket(h), { id })).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });

  it('гостя по инвайту забанить нечем', async () => {
    // За него ручается токен приглашения, а не ключ: банить нечего, и
    // заканчивается разговор с ним через guest-kick.
    const { gw, server } = await makeGateway();
    const host = await personCookie('Хозяйка');
    const h = await connectAs(gw, server, host.cookie, { id: 'h' });
    await ownServer(gw, h);
    const nobody = connect(gw, server, { id: 'n' });
    const id = await say(gw, nobody, 'болталка', 'здрасьте');
    await gw.handleChatJoin(asSocket(h), { room: 'болталка' });

    expect(await gw.handleModerationBan(asSocket(h), { id })).toEqual({
      ok: false,
      error: 'not-found',
    });
  });

  it('список забаненных и разбан возвращают сервер на место', async () => {
    const { gw, server } = await makeGateway();
    const host = await personCookie('Хозяйка');
    const guest = await personCookie('Гость');
    const h = await connectAs(gw, server, host.cookie, { id: 'h' });
    await ownServer(gw, h);
    const g = await connectAs(gw, server, guest.cookie, { id: 'g' });
    const id = await say(gw, g, 'болталка', 'привет');
    await gw.handleChatJoin(asSocket(h), { room: 'болталка' });
    await gw.handleModerationBan(asSocket(h), { id });

    const list = await gw.handleModerationBans(asSocket(h), { server: 'srv' });
    expect(list).toMatchObject({
      ok: true,
      bans: [{ fingerprint: guest.fingerprint, nick: 'Гость', by: 'Хозяйка' }],
    });

    g.clear();
    expect(
      await gw.handleModerationUnban(asSocket(h), { fingerprint: guest.fingerprint, server: 'srv' }),
    ).toEqual({ ok: true });
    expect((g.last('servers') as { id: string }[]).map((s) => s.id)).toContain('srv');
  });

  it('модератор удаляет чужое сообщение, но не правит его', async () => {
    // Удалить сказанное — модерация; переписать сказанное чужим именем — подлог.
    const { gw, server } = await makeGateway();
    const host = await personCookie('Хозяйка');
    const guest = await personCookie('Гость');
    const h = await connectAs(gw, server, host.cookie, { id: 'h' });
    await ownServer(gw, h);
    const g = await connectAs(gw, server, guest.cookie, { id: 'g' });
    const id = await say(gw, g, 'болталка', 'дурное слово');
    await gw.handleChatJoin(asSocket(h), { room: 'болталка' });
    server.clearAll();

    await gw.handleChatEdit(asSocket(h), { id, text: 'подменённое' });
    expect(g.got('chat-edited')).toBe(false);

    await gw.handleChatDelete(asSocket(h), { id });
    expect(g.last('chat-deleted')).toEqual({ id });
  });

  it('в чужом канале своё удаляется, а чужое — нет', async () => {
    const { gw, server } = await makeGateway();
    const anya = await personCookie('Аня');
    const boris = await personCookie('Борис');
    const a = await connectAs(gw, server, anya.cookie, { id: 'a' });
    const b = await connectAs(gw, server, boris.cookie, { id: 'b' });
    const mine = await say(gw, a, 'obshchii', 'моё');
    await gw.handleChatJoin(asSocket(b), { room: 'obshchii' });
    server.clearAll();

    // Главный сервер не создавал никто — модератора у него нет, и правила в нём
    // прежние: каждый отвечает за своё.
    await gw.handleChatDelete(asSocket(b), { id: mine });
    expect(a.got('chat-deleted')).toBe(false);
    await gw.handleChatDelete(asSocket(a), { id: mine });
    expect(a.last('chat-deleted')).toEqual({ id: mine });
  });
});
