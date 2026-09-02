import { Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { randomBytes, randomUUID } from 'node:crypto';
import { resetAddressDoor } from '../auth/auth';
import { AttachmentRow, ChannelRow, DeviceRow, IdentityRow, ServerRow } from '../db/entities';
import { resetDatabase, testDatabase } from '../db/testing';
import { fingerprint as fingerprintOf } from '../identity/crypto';
import { IdentityService } from '../identity/identity.service';
import { OwnerService } from '../identity/owner.service';
import { PrefsService } from '../identity/prefs.service';
import { ReadsService } from '../identity/reads.service';
import { RolesService } from '../identity/roles.service';
import { issueSession } from '../identity/session';
import { RetentionService } from '../db/retention.service';
import { AuditService } from '../settings/audit.service';
import { OverviewService } from '../settings/overview.service';
import { SettingsService } from '../settings/settings.service';
import type { Attachment, UploadsService } from '../uploads';
import type { Channel, PersistedRegistry, ServerEntry } from './registry';
import { ChatService } from './chat.service';
import { DmService } from './dm.service';
import { RegistryService, channelSlug } from './registry.service';
import { SignalingGateway } from './signaling.gateway';
import { FakeServer, asSocket, type FakeSocket } from './testkit';

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
/**
 * Ждать, пока произойдёт то, чего ждём, — и упасть, если не дождались.
 *
 * Молчаливая сдача по таймауту здесь дороже, чем кажется: следом обычно идёт
 * `clear()` или проверка «этого не приходило», и не дождавшийся `until`
 * превращает их в бессмыслицу — снимок приезжает уже после очистки и выглядит
 * эхом, которого не было.
 *
 * Ждём и по виртуальному времени, и по настоящему. Часы у стенда фальшивые, но
 * ответ базы — настоящий ввод-вывод: фиксированное число оборотов цикла на
 * спокойной машине проходит с запасом, а на загруженном раннере кончается
 * раньше, чем приезжает ответ. Настоящее время спрашиваем у `hrtime` — его
 * подмена таймеров не трогает.
 */
export async function until(check: () => boolean, what = 'ожидаемое событие'): Promise<void> {
  const deadline = process.hrtime.bigint() + 5_000_000_000n;
  while (!check() && process.hrtime.bigint() < deadline) await vi.advanceTimersByTimeAsync(5);
  if (!check()) throw new Error(`не дождались: ${what}`);
}

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
    // Дверь по адресу — модульная переменная на весь процесс: её ставит
    // `afterInit` каждого поднятого гейтвея. Не вернув её открытой, мы оставили
    // бы следующему файлу дверь от чужой, уже мёртвой базы.
    resetAddressDoor();
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
  /**
   * Подметание сирот. Настоящее живёт в `UploadsService` и проверено своими
   * тестами вместе с диском; гейтвею от него нужен ровно один ответ — сколько
   * унесено, — а каталог загрузок здесь ставить незачем: тест панели проверяет,
   * что кнопка доходит до подметания, а не как оно устроено.
   */
  async sweep(): Promise<number> {
    swept.calls += 1;
    return swept.removed;
  },
};

/** Сколько раз панель попросила подмести файлы и что подметание ей ответило. */
export const swept = { calls: 0, removed: 0 };

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
  const dmService = new DmService(db);
  await dmService.onModuleInit();
  // Настройки настоящие и на той же базе. Таблица после `resetDatabase` пуста,
  // то есть это «инсталляция, где панель не открывали ни разу»: каждый ответ —
  // умолчание каталога, равное поведению relay до этапа C. Тесту, который
  // ничего не настраивал, разницы не видно, и в этом весь смысл.
  const settings = new SettingsService(db);
  await settings.onModuleInit();
  const chat = new ChatService(db, registry, dmService, settings);
  await chat.onModuleInit();
  const identities = new IdentityService(db, settings);
  const owner = new OwnerService(db);
  const roles = new RolesService(db);
  const reads = new ReadsService(db);
  const prefs = new PrefsService(db);
  // Ретенция и журнал настоящие: панель зовёт их обоих, и подделка отвечала бы
  // «удалено ноль» на непустую таблицу. Таймер ретенции при этом не заводим
  // (`onModuleInit` не зовём) — прогон и так живёт на поддельных часах.
  const retention = new RetentionService(db, settings);
  const audit = new AuditService(db);
  const overview = new OverviewService(db, settings, retention);
  swept.calls = 0;
  swept.removed = 0;
  const gw = new SignalingGateway(
    uploads as unknown as UploadsService,
    chat,
    registry,
    identities,
    owner,
    roles,
    reads,
    prefs,
    dmService,
    settings,
    overview,
    audit,
    retention,
  );
  gw.server = server.asServer();
  // Узнавание личности вешается миддлварой — заводим её и здесь, иначе тест
  // проверял бы гейтвей, у которого этой двери нет вовсе.
  gw.afterInit(server.asServer());
  return {
    gw,
    server,
    registry,
    chat,
    dm: dmService,
    identities,
    owner,
    roles,
    reads,
    prefs,
    settings,
    overview,
    audit,
    retention,
  };
}

/**
 * Личность в базе и кука её сессии. Челлендж здесь не гоняем намеренно: он
 * проверен в identity.service.test, а гейтвею предъявляют именно куку — и
 * именно её разбор мы и хотим видеть.
 */
export async function personCookie(
  nick: string,
  // Когда эта личность завелась. Нужно ровно тихому часу новичка: он считает
  // возраст, и «давно здесь» иначе нечем изобразить — часы у стенда идут только
  // вперёд, а таймеры у него фальшивые.
  opts: { born?: Date } = {},
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
    createdAt: opts.born ?? new Date(),
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

/**
 * Обрыв связи — так, как его видит гейтвей.
 *
 * Порядок здесь не косметический: socket.io убирает сокет из своей карты ДО
 * того, как позовёт обработчик отключения, и всё, что считает живых по этой
 * карте (присутствие), обязано видеть его уже ушедшим. Позови мы обработчик
 * первым — тест доказывал бы поведение, которого в жизни не бывает.
 */
export function disconnect(gw: SignalingGateway, server: FakeServer, sock: FakeSocket) {
  server.remove(sock.id);
  gw.handleDisconnect(asSocket(sock));
}

/** Прокрутить дебаунсы (presence, реестр каналов, активность чата). */
export function settle() {
  vi.advanceTimersByTime(200);
}

// ── Готовые ходы, которые повторяются во многих файлах ────────────────────

// Правку настройки открывает общий стенд настроек: им же пользуются тесты
// личностей и двери, а две одинаковые `tune` разошлись бы в первый же день.
export { tune } from '../settings/settings.testkit';

/** Сделать человека владельцем инсталляции — тем же путём, что и ссылка. */
export async function makeOwner(owner: OwnerService, identityId: string): Promise<void> {
  const { token } = await owner.issue();
  await owner.claim(token, identityId);
}

/**
 * Попытка подключения вместе с тем, чем ответила дверь. `ip` — откуда пришли:
 * его спрашивает список закрытых адресов, и подставить его иначе нечем.
 */
export async function knock(
  gw: SignalingGateway,
  server: FakeServer,
  cookie: string,
  id?: string,
  ip?: string,
) {
  const sock = server.connect({ id, cookie, ip });
  const refused = await server.run(sock);
  if (!refused) gw.handleConnection(asSocket(sock));
  return { sock, refused };
}

/**
 * Адрес канала по его имени — тем же расчётом, что и сервер (`channelSlug`).
 *
 * Считать его в тесте руками нельзя: слаг несёт метку своего сервера, и
 * литерал «болталка» в ожидании означал бы, что тест проверяет не поведение, а
 * собственную догадку о том, как оно устроено.
 */
export function slugOf(name: string, serverId = 'srv'): string {
  return channelSlug(name, serverId);
}

/** Свой сервер с текстовым и голосовым каналами — то, чем владеет создатель. */
export async function ownServer(gw: SignalingGateway, sock: FakeSocket, id = 'srv') {
  await gw.handleServerCreate(asSocket(sock), { id, name: 'мой' });
  await gw.handleChannelCreate(asSocket(sock), { serverId: id, type: 'text', name: 'болталка' });
  await gw.handleChannelCreate(asSocket(sock), { serverId: id, type: 'voice', name: 'эфир' });
  settle();
}

/** Сказать что-нибудь в канале и вернуть id сказанного. */
export async function say(gw: SignalingGateway, sock: FakeSocket, slug: string, text: string) {
  await gw.handleChatJoin(asSocket(sock), { room: slug });
  await gw.handleChatMessage(asSocket(sock), { text });
  return (sock.last('chat') as { id: string }).id;
}
