import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io';
import { asSocket } from './testkit';
import type { SignalingGateway } from './signaling.gateway';
import { SETTINGS } from '../settings/catalog';
import { readSession } from '../identity/session';
import {
  connect,
  connectAs,
  database,
  makeGateway,
  makeOwner,
  personCookie,
  say,
  swept,
  tune,
  useGatewayStand,
} from './gateway.testkit';

/**
 * Админ-панель: дверь, состояние, запись, люди и действия.
 *
 * Половина этого файла — про одну-единственную вещь: КАЖДОЕ событие панели
 * проверяет владение само. Проверяется это перебором подписок самого гейтвея, а
 * не списком, набранным здесь руками: список рано или поздно отстанет от кода, и
 * отстанет он молча — восьмое событие останется открытым, а тест будет зелёным.
 */

useGatewayStand();

const gatewaySource = readFileSync(
  fileURLToPath(new URL('./signaling.gateway.ts', import.meta.url)),
  'utf8',
);

/** Все события панели, какие подписывает гейтвей. Источник — он сам. */
const PANEL_EVENTS = [...gatewaySource.matchAll(/@SubscribeMessage\('(admin-[a-z-]+)'\)/g)].map(
  (m) => m[1],
);

type Refusable = { ok: boolean; error?: string };

/**
 * Как постучаться в каждое событие панели. Тела заведомо годные: проверяем
 * дверь, а не разбор запроса, — иначе отказ мог бы прийти по другой причине и
 * дыру в двери было бы не отличить от опечатки в теле.
 */
const KNOCK: Record<string, (gw: SignalingGateway, sock: Socket) => Promise<Refusable>> = {
  'admin-state': (gw, s) => gw.handleAdminState(s),
  'admin-set': (gw, s) => gw.handleAdminSet(s, { key: 'direct.enabled', value: false }),
  'admin-reset': (gw, s) => gw.handleAdminReset(s, { group: 'direct', confirm: true }),
  'admin-people': (gw, s) => gw.handleAdminPeople(s, {}),
  'admin-bans': (gw, s) => gw.handleAdminBans(s),
  'admin-audit': (gw, s) => gw.handleAdminAudit(s, {}),
  'admin-action': (gw, s) => gw.handleAdminAction(s, { action: 'export', confirm: true }),
};

/** Владелец инсталляции на связи. Возвращает его сокет и его же личность. */
async function ownerOnline(id = 'boss') {
  const stand = await makeGateway();
  const boss = await personCookie('Хозяин');
  await makeOwner(stand.owner, boss.identityId);
  const sock = await connectAs(stand.gw, stand.server, boss.cookie, { id });
  return { ...stand, boss, sock };
}

describe('дверь', () => {
  it('не владельцу отвечает forbidden на каждое событие панели', async () => {
    const { gw, server } = await makeGateway();
    const plain = await connectAs(gw, server, (await personCookie('никто')).cookie);

    // Событий у панели больше трёх, и перебираем мы их все: событие, забывшее
    // спросить владение, — это настройки инсталляции, открытые кому угодно.
    expect(PANEL_EVENTS.length).toBeGreaterThan(0);
    for (const event of PANEL_EVENTS) {
      const knock = KNOCK[event];
      expect(knock, `событие ${event} не перебрано этим тестом`).toBeTypeOf('function');
      expect(await knock(gw, asSocket(plain)), event).toEqual({ ok: false, error: 'forbidden' });
    }
    // И наоборот: в таблице нет того, чего гейтвей не подписывает, — иначе
    // «перебрали все» означало бы «перебрали выдуманные».
    expect(Object.keys(KNOCK).sort()).toEqual([...PANEL_EVENTS].sort());
  });

  it('сокету без личности отказывает так же — на каждом событии', async () => {
    // Клиент до челленджа и старый клиент вовсе без ключа: власть спрашивается
    // у личности, и её отсутствие обязано читаться как «не владелец», а не как
    // «проверить не у кого».
    const { gw, server } = await makeGateway();
    const nobody = connect(gw, server);
    for (const event of PANEL_EVENTS) {
      expect(await KNOCK[event](gw, asSocket(nobody)), event).toEqual({
        ok: false,
        error: 'forbidden',
      });
    }
  });

  it('бывшему владельцу отказывает сразу после потери власти', async () => {
    // Ссылка владельца переводит власть мгновенно и не спрашивает прежнего.
    // Ждать переподключения нельзя: бывший хозяин ещё часами правил бы чужую
    // инсталляцию из открытой вкладки.
    const { gw, server, owner, sock } = await ownerOnline();
    expect((await gw.handleAdminState(asSocket(sock))).ok).toBe(true);

    const next = await personCookie('Новый хозяин');
    await makeOwner(owner, next.identityId);
    await gw.syncOwner();

    for (const event of PANEL_EVENTS) {
      expect(await KNOCK[event](gw, asSocket(sock)), event).toEqual({
        ok: false,
        error: 'forbidden',
      });
    }
    expect(server.all.size).toBeGreaterThan(0);
  });
});

describe('состояние', () => {
  it('отдаёт каталог, значения и сводку одним ответом', async () => {
    const { gw, sock } = await ownerOnline();
    const res = await gw.handleAdminState(asSocket(sock));
    if (!res.ok) throw new Error('панель не открылась');

    // Каталог уезжает с сервера целиком: панель рисует поля по НЕМУ, а не по
    // своей копии, которая в старом клиенте отстала бы на выпуск.
    expect(res.catalog.length).toBe(SETTINGS.length);
    expect(res.catalog.map((s) => s.key)).toContain('messages.retentionMode');
    // Значения — `public()`, то есть всё, включая непомеченное `client`:
    // владельцу в панели нужны и стоп-слова, и пороги блокировки.
    expect(res.values['moderation.bannedWords']).toEqual([]);
    expect(res.values['direct.enabled']).toBe(true);

    expect(res.overview.people).toBe(1);
    expect(res.overview.online).toBe(1);
    expect(res.overview.bans).toBe(0);
    expect(res.overview.channels).toBeGreaterThan(0);
    expect(res.overview.retention).toEqual({ mode: 'days', days: 14 });
    // Своей политики у переписки нет — она общая с каналами, и сводка говорит
    // это пустотой, а не копией общей.
    expect(res.overview.directRetention).toBe(null);
  });

  it('не отдаёт значения секретов', async () => {
    const { gw, sock } = await ownerOnline();
    // Пароль ставим ПОСЛЕ подключения: с ним дверь инсталляции требует пропуск,
    // а проверяем мы не её.
    process.env.SITE_PASSWORD = 'тайна';
    const res = await gw.handleAdminState(asSocket(sock));
    if (!res.ok) throw new Error('панель не открылась');

    expect(res.values['access.sitePasswordSet']).toBe(true);
    expect(JSON.stringify(res)).not.toContain('тайна');
  });

  it('считает людей, баны и занятое место запросом, а не памятью', async () => {
    const { gw, sock, roles, boss } = await ownerOnline();
    const anya = await personCookie('Аня');
    await roles.ban(anya.identityId, null, boss.identityId);
    await database().query(
      `INSERT INTO attachments (id, name, size, mime, kind) VALUES ('f1', 'кот.png', 2048, 'image/png', 'image')`,
    );

    const res = await gw.handleAdminState(asSocket(sock));
    if (!res.ok) throw new Error('панель не открылась');
    expect(res.overview.people).toBe(2);
    expect(res.overview.bans).toBe(1);
    expect(res.overview.storageBytes).toBe(2048);
    // Квота каталога загрузок — 2 ГиБ по умолчанию (сегодняшнее поведение).
    expect(res.overview.storageQuotaBytes).toBe(2 * 1024 ** 3);
  });
});

describe('запись', () => {
  it('пишет, отвечает и уведомляет вторую сессию владельца', async () => {
    const { gw, server, boss, sock } = await ownerOnline();
    // Вторая вкладка того же человека: панель, открытая на втором устройстве,
    // обязана узнать о правке — иначе она сохранит поверх неё вчерашнее.
    const second = await connectAs(gw, server, boss.cookie, { id: 'boss-2' });

    const res = await gw.handleAdminSet(asSocket(sock), {
      key: 'moderation.bannedWords',
      value: ['редиска'],
    });
    expect(res).toEqual({
      ok: true,
      key: 'moderation.bannedWords',
      changed: true,
      value: ['редиска'],
    });
    expect(second.last('admin-changed')).toEqual({
      keys: ['moderation.bannedWords'],
      values: { 'moderation.bannedWords': ['редиска'] },
    });
    // Себе не шлём: спросивший уже получил ответ на своё же событие.
    expect(sock.got('admin-changed')).toBe(false);
  });

  it('повторная запись того же значения ничего не меняет и никого не будит', async () => {
    const { gw, server, boss, sock } = await ownerOnline();
    const second = await connectAs(gw, server, boss.cookie, { id: 'boss-2' });
    const res = await gw.handleAdminSet(asSocket(sock), { key: 'direct.enabled', value: true });
    expect(res).toEqual({ ok: true, key: 'direct.enabled', changed: false, value: true });
    expect(second.got('admin-changed')).toBe(false);
  });

  it('на негодном значении отвечает причиной из каталога', async () => {
    const { gw, sock } = await ownerOnline();
    const s = asSocket(sock);
    expect(await gw.handleAdminSet(s, { key: 'нет.такого', value: 1 })).toEqual({
      ok: false,
      error: 'unknown-key',
    });
    expect(await gw.handleAdminSet(s, { key: 'direct.enabled', value: 'да' })).toEqual({
      ok: false,
      error: 'wrong-type',
    });
    expect(
      await gw.handleAdminSet(s, { key: 'access.maxDevicesPerIdentity', value: 9999 }),
    ).toEqual({ ok: false, error: 'out-of-range' });
    expect(await gw.handleAdminSet(s, { key: 'access.identityCreation', value: 'иногда' })).toEqual(
      {
        ok: false,
        error: 'not-an-option',
      },
    );
    // Инфраструктурное живёт в окружении, и «сохранено» на нём было бы враньём.
    expect(await gw.handleAdminSet(s, { key: 'voice.turnUrls', value: 'turn:x' })).toEqual({
      ok: false,
      error: 'read-only',
    });
  });

  it('опасное без подтверждения не проходит', async () => {
    // Подтверждение — поле в запросе, а не доверие к тому, что панель показала
    // диалог: диалог рисует клиент, а закрывает инсталляцию сервер.
    const { gw, sock, settings } = await ownerOnline();
    expect(
      await gw.handleAdminSet(asSocket(sock), { key: 'maintenance.mode', value: true }),
    ).toEqual({ ok: false, error: 'needs-confirm' });
    expect(settings.get('maintenance.mode')).toBe(false);

    const done = await gw.handleAdminSet(asSocket(sock), {
      key: 'maintenance.mode',
      value: true,
      confirm: true,
    });
    expect(done).toEqual({ ok: true, key: 'maintenance.mode', changed: true, value: true });
    expect(settings.get('maintenance.mode')).toBe(true);
  });

  it('секрет общей дорогой не пишется', async () => {
    // У пароля инсталляции своя дорога — со scrypt и отзывом выданных
    // пропусков. «Сохранено» здесь означало бы пароль открытым текстом в jsonb.
    const { gw, sock } = await ownerOnline();
    expect(
      await gw.handleAdminSet(asSocket(sock), {
        key: 'access.sitePasswordSet',
        value: 'новый',
        confirm: true,
      }),
    ).toEqual({ ok: false, error: 'secret-path' });
  });

  it('правка попадает в журнал вместе с «было» и «стало»', async () => {
    const { gw, sock } = await ownerOnline();
    await gw.handleAdminSet(asSocket(sock), { key: 'people.nickMinLength', value: 3 });
    const page = await gw.handleAdminAudit(asSocket(sock), {});
    if (!page.ok) throw new Error('журнал не открылся');
    expect(page.entries.find((e) => e.action === 'setting-changed')).toMatchObject({
      action: 'setting-changed',
      target: 'people.nickMinLength',
      actorNick: 'Хозяин',
      detail: { from: 1, to: 3 },
    });
  });

  it('негодный курсор журнала — пустая страница, а не первая', async () => {
    // Первая означала бы, что панель, сбившись, тихо листает по кругу одно и то
    // же начало журнала.
    const { gw, sock } = await ownerOnline();
    await gw.handleAdminSet(asSocket(sock), { key: 'people.nickMinLength', value: 3 });
    expect(await gw.handleAdminAudit(asSocket(sock), { cursor: { at: 'вчера', id: 5 } })).toEqual({
      ok: true,
      entries: [],
      more: false,
    });
  });
});

describe('сброс группы', () => {
  it('без подтверждения не сбрасывает', async () => {
    const { gw, sock, settings } = await ownerOnline();
    await tune(settings, 'direct.enabled', false);
    expect(await gw.handleAdminReset(asSocket(sock), { group: 'direct' })).toEqual({
      ok: false,
      error: 'needs-confirm',
    });
    expect(settings.get('direct.enabled')).toBe(false);
  });

  it('с подтверждением возвращает изменённое и будит вторую сессию', async () => {
    const { gw, server, boss, sock, settings } = await ownerOnline();
    await tune(settings, 'direct.enabled', false);
    const second = await connectAs(gw, server, boss.cookie, { id: 'boss-2' });

    const res = await gw.handleAdminReset(asSocket(sock), { group: 'direct', confirm: true });
    if (!res.ok) throw new Error('сброс не прошёл');
    expect(res.changed).toEqual(['direct.enabled']);
    expect(res.values['direct.enabled']).toBe(true);
    expect(second.last('admin-changed')).toEqual({
      keys: ['direct.enabled'],
      values: { 'direct.enabled': true },
    });
  });

  it('неизвестной группе отвечает как неизвестному ключу', async () => {
    const { gw, sock } = await ownerOnline();
    expect(await gw.handleAdminReset(asSocket(sock), { group: 'нет', confirm: true })).toEqual({
      ok: false,
      error: 'unknown-key',
    });
  });
});

describe('люди', () => {
  it('отдаёт лицо, ник, отпечаток, устройства и статус', async () => {
    const { gw, sock, roles, boss } = await ownerOnline();
    const anya = await personCookie('Аня');
    await roles.ban(anya.identityId, null, boss.identityId);

    const res = await gw.handleAdminPeople(asSocket(sock), {});
    if (!res.ok) throw new Error('люди не пришли');
    const row = res.people.find((p) => p.fingerprint === anya.fingerprint);
    expect(row).toMatchObject({ nick: 'Аня', banned: true, owner: false });
    expect(row?.devices).toHaveLength(1);
    expect(row?.devices[0]).toMatchObject({ name: 'тестовое устройство', revoked: false });
    // Владелец в той же таблице и помечен: банить его нельзя, и панель обязана
    // знать об этом до нажатия.
    expect(res.people.find((p) => p.fingerprint === boss.fingerprint)).toMatchObject({
      owner: true,
      banned: false,
    });
    // Страница одна — продолжать нечем.
    expect(res.cursor).toBeUndefined();
  });

  it('ищет и по нику, и по отпечатку', async () => {
    const { gw, sock } = await ownerOnline();
    const anya = await personCookie('Аня');
    await personCookie('Борис');

    const byNick = await gw.handleAdminPeople(asSocket(sock), { query: 'ня' });
    if (!byNick.ok) throw new Error('люди не пришли');
    expect(byNick.people.map((p) => p.nick)).toEqual(['Аня']);

    const byPrint = await gw.handleAdminPeople(asSocket(sock), { query: anya.fingerprint });
    if (!byPrint.ok) throw new Error('люди не пришли');
    expect(byPrint.people.map((p) => p.nick)).toEqual(['Аня']);

    // Знак подстановки в запросе — это буква, а не «любой знак»: иначе поиск
    // врал бы тем тише, чем реже им пользуются.
    const wildcard = await gw.handleAdminPeople(asSocket(sock), { query: '%' });
    if (!wildcard.ok) throw new Error('люди не пришли');
    expect(wildcard.people).toEqual([]);
  });

  it('страница не теряет людей на границе и не показывает их дважды', async () => {
    // Ровно та же беда и то же лекарство, что у ленты канала и у журнала:
    // курсор полный (время заведения и id), потому что личности заводятся по
    // две в одну миллисекунду — с одной связки устройств.
    const { gw, sock } = await ownerOnline();
    for (let i = 0; i < 51; i += 1) await personCookie(`человек ${i}`);

    const first = await gw.handleAdminPeople(asSocket(sock), {});
    if (!first.ok || !first.cursor) throw new Error('первая страница без продолжения');
    expect(first.people).toHaveLength(50);

    const second = await gw.handleAdminPeople(asSocket(sock), { cursor: first.cursor });
    if (!second.ok) throw new Error('люди не пришли');
    // Всего 52: полсотни новичков на первой странице, остаток и владелец — на
    // второй, и ни одного человека в обеих сразу.
    expect(second.people).toHaveLength(2);
    expect(second.cursor).toBeUndefined();
    const all = [...first.people, ...second.people].map((p) => p.fingerprint);
    expect(new Set(all).size).toBe(52);
  });

  it('негодный курсор — пустая страница', async () => {
    const { gw, sock } = await ownerOnline();
    const res = await gw.handleAdminPeople(asSocket(sock), { cursor: 'что-то не то' });
    expect(res).toEqual({ ok: true, people: [] });
  });

  it('банит и разбанивает по отпечатку', async () => {
    const { gw, server, sock } = await ownerOnline();
    const anya = await personCookie('Аня');
    const hers = await connectAs(gw, server, anya.cookie, { id: 'anya' });

    expect(
      await gw.handleAdminAction(asSocket(sock), {
        action: 'ban',
        target: anya.fingerprint,
        confirm: true,
      }),
    ).toEqual({ ok: true, action: 'ban' });
    // Бан действует под живым сокетом, а не со следующего входа.
    expect(hers.got('banned')).toBe(true);
    expect(hers.disconnected).toBe(true);

    const bans = await gw.handleAdminBans(asSocket(sock));
    if (!bans.ok) throw new Error('баны не пришли');
    expect(bans.bans.map((b) => b.fingerprint)).toEqual([anya.fingerprint]);

    expect(
      await gw.handleAdminAction(asSocket(sock), {
        action: 'unban',
        target: anya.fingerprint,
        confirm: true,
      }),
    ).toEqual({ ok: true, action: 'unban' });
    const after = await gw.handleAdminBans(asSocket(sock));
    expect(after).toEqual({ ok: true, bans: [] });
  });

  it('не даёт забанить самого владельца', async () => {
    // Строка бана на инсталляцию и строка владельца — одна и та же пара ключей
    // в таблице: забаненный владелец означал бы инсталляцию без хозяина.
    const { gw, sock, boss } = await ownerOnline();
    expect(
      await gw.handleAdminAction(asSocket(sock), {
        action: 'ban',
        target: boss.fingerprint,
        confirm: true,
      }),
    ).toEqual({ ok: false, error: 'forbidden' });
  });

  it('незнакомый отпечаток — not-found и на бане, и на разбане', async () => {
    const { gw, sock } = await ownerOnline();
    const s = asSocket(sock);
    const anya = await personCookie('Аня');
    expect(
      await gw.handleAdminAction(s, { action: 'ban', target: 'нет-такого', confirm: true }),
    ).toEqual({ ok: false, error: 'not-found' });
    // Отпечаток настоящий, а бана не было — тоже not-found: снимать нечего.
    expect(
      await gw.handleAdminAction(s, { action: 'unban', target: anya.fingerprint, confirm: true }),
    ).toEqual({ ok: false, error: 'not-found' });
  });
});

describe('действия', () => {
  it('незнакомое действие отвергает, а не угадывает', async () => {
    const { gw, sock } = await ownerOnline();
    expect(
      await gw.handleAdminAction(asSocket(sock), { action: 'самоуничтожение', confirm: true }),
    ).toEqual({ ok: false, error: 'unsupported' });
  });

  it('подтверждения просит всё, кроме выгрузки', async () => {
    // Белый список безопасного, а не чёрный список опасного: действие,
    // добавленное завтра, окажется опасным по умолчанию.
    const { gw, sock } = await ownerOnline();
    const s = asSocket(sock);
    for (const action of ['owner-link', 'retention-run', 'files-sweep', 'import'] as const) {
      expect(await gw.handleAdminAction(s, { action }), action).toEqual({
        ok: false,
        error: 'needs-confirm',
      });
    }
    expect((await gw.handleAdminAction(s, { action: 'export' })).ok).toBe(true);
  });

  it('перевыпуск ссылки владельца отдаёт ключ ровно один раз', async () => {
    const { gw, sock, owner } = await ownerOnline();
    const first = await gw.handleAdminAction(asSocket(sock), {
      action: 'owner-link',
      confirm: true,
    });
    if (!first.ok || !first.link) throw new Error('ссылку не выдали');

    // Второй запрос выдаёт ДРУГОЙ ключ, а прежний перестаёт работать: живой
    // ключ на инсталляции ровно один, иначе «перевыпустил, потому что старый
    // мог утечь» не значило бы ничего.
    const second = await gw.handleAdminAction(asSocket(sock), {
      action: 'owner-link',
      confirm: true,
    });
    if (!second.ok || !second.link) throw new Error('ссылку не выдали');
    expect(second.link.token).not.toBe(first.link.token);

    const stranger = await personCookie('Прохожий');
    expect(await owner.claim(first.link.token, stranger.identityId)).toEqual({
      ok: false,
      reason: 'expired',
    });

    // И больше нигде: в журнале записан факт выпуска, а не сам ключ.
    const journal = await gw.handleAdminAudit(asSocket(sock), {});
    if (!journal.ok) throw new Error('журнал не открылся');
    // Трижды: раз — стендом, чтобы власть кому-то принадлежала, и дважды — панелью.
    expect(journal.entries.filter((e) => e.action === 'owner-link-issued')).toHaveLength(3);
    expect(JSON.stringify(journal.entries)).not.toContain(second.link.token);
  });

  it('экспорт настроек не содержит секретов', async () => {
    const { gw, sock, settings } = await ownerOnline();
    await tune(settings, 'appearance.installName', 'Контора');
    process.env.SITE_PASSWORD = 'тайна';

    const res = await gw.handleAdminAction(asSocket(sock), { action: 'export' });
    if (!res.ok || !res.settings) throw new Error('выгрузка не пришла');
    expect(res.settings.values['appearance.installName']).toBe('Контора');
    // Ни значения, ни признака «задано»: файл ездит по почте и лежит в чужих
    // каталогах, и сообщать ему, заперта ли дверь, незачем.
    expect(Object.keys(res.settings.values)).not.toContain('access.sitePasswordSet');
    expect(JSON.stringify(res.settings)).not.toContain('тайна');
    // Инфраструктурного тоже нет: его не принял бы и сам каталог.
    expect(Object.keys(res.settings.values)).not.toContain('voice.turnUrls');
  });

  it('импорт применяет годное и перечисляет отвергнутое', async () => {
    const { gw, server, boss, sock, settings } = await ownerOnline();
    const second = await connectAs(gw, server, boss.cookie, { id: 'boss-2' });

    const res = await gw.handleAdminAction(asSocket(sock), {
      action: 'import',
      confirm: true,
      values: {
        'direct.enabled': false,
        'нет.такого': 1,
        'access.maxDevicesPerIdentity': 9999,
        'access.sitePasswordSet': 'тайна',
        // Уже такое: в отчёт не попадает ни применённым, ни отвергнутым —
        // «применено» о работе, которой не было, рассказывать не должно.
        'people.nickMinLength': 1,
      },
    });
    if (!res.ok || !res.imported) throw new Error('импорт не прошёл');
    expect(res.imported.applied).toEqual(['direct.enabled']);
    expect(res.imported.rejected).toEqual([
      { key: 'нет.такого', reason: 'unknown-key' },
      { key: 'access.maxDevicesPerIdentity', reason: 'out-of-range' },
      { key: 'access.sitePasswordSet', reason: 'secret-path' },
    ]);
    expect(settings.get('direct.enabled')).toBe(false);
    expect(second.got('admin-changed')).toBe(true);

    // Одна запись на весь импорт — человек нажал один раз; отвергнутое живёт
    // только в ней, потому что строки `setting-changed` у него и нет.
    const journal = await gw.handleAdminAudit(asSocket(sock), {});
    if (!journal.ok) throw new Error('журнал не открылся');
    const imported = journal.entries.find((e) => e.action === 'settings-imported');
    expect(imported?.detail).toMatchObject({ applied: 1 });
    expect(JSON.stringify(imported?.detail)).not.toContain('тайна');
  });

  it('импорт не из объекта отвергает целиком', async () => {
    const { gw, sock } = await ownerOnline();
    expect(
      await gw.handleAdminAction(asSocket(sock), {
        action: 'import',
        confirm: true,
        values: [1, 2],
      }),
    ).toEqual({ ok: false, error: 'wrong-type' });
  });

  it('прогон ретенции удаляет сказанное и попадает в журнал', async () => {
    const { gw, sock, settings } = await ownerOnline();
    await say(gw, sock, 'obshchii', 'здрасьте');
    // «Не хранить вовсе» — самый быстрый способ увидеть, что проход настоящий.
    await tune(settings, 'messages.retentionMode', 'ephemeral');

    const res = await gw.handleAdminAction(asSocket(sock), {
      action: 'retention-run',
      confirm: true,
    });
    expect(res).toEqual({ ok: true, action: 'retention-run', count: 1 });
    expect(Number(await messagesLeft())).toBe(0);

    const journal = await gw.handleAdminAudit(asSocket(sock), {});
    if (!journal.ok) throw new Error('журнал не открылся');
    expect(journal.entries.find((e) => e.action === 'retention-run')).toMatchObject({
      detail: { removed: 1 },
    });
  });

  it('подметание файлов доходит до самого подметания', async () => {
    const { gw, sock } = await ownerOnline();
    swept.removed = 3;
    const res = await gw.handleAdminAction(asSocket(sock), {
      action: 'files-sweep',
      confirm: true,
    });
    expect(res).toEqual({ ok: true, action: 'files-sweep', count: 3 });
    expect(swept.calls).toBe(1);
  });

  it('отзыв сессий обесценивает выданные куки и рвёт чужие сокеты', async () => {
    const { gw, server, sock, boss } = await ownerOnline();
    const anya = await personCookie('Аня');
    const hers = await connectAs(gw, server, anya.cookie, { id: 'anya' });
    const token = boss.cookie.split('=')[1];
    expect(readSession(token)).not.toBe(null);

    const res = await gw.handleAdminAction(asSocket(sock), {
      action: 'revoke-sessions',
      confirm: true,
    });
    expect(res).toEqual({ ok: true, action: 'revoke-sessions', count: 1 });
    // Своя кука умирает вместе с чужими: «все» значит все, а человеку это
    // ничего не стоит — клиент проходит челлендж заново сам.
    expect(readSession(token)).toBe(null);
    expect(hers.disconnected).toBe(true);
    // Свой сокет остаётся живым: оборвав его, мы не доставили бы этот же ответ.
    expect(sock.disconnected).toBe(false);
  });

  it('отзывает чужое устройство и выгоняет его сокеты', async () => {
    const { gw, server, sock } = await ownerOnline();
    const anya = await personCookie('Аня');
    const hers = await connectAs(gw, server, anya.cookie, { id: 'anya' });
    const people = await gw.handleAdminPeople(asSocket(sock), { query: 'Аня' });
    if (!people.ok) throw new Error('люди не пришли');
    const device = people.people[0].devices[0].id;

    expect(
      await gw.handleAdminAction(asSocket(sock), {
        action: 'revoke-device',
        target: device,
        confirm: true,
      }),
    ).toEqual({ ok: true, action: 'revoke-device', count: 1 });
    expect(hers.disconnected).toBe(true);

    // Повторный отзыв — уже не работа: устройство отозвано.
    expect(
      await gw.handleAdminAction(asSocket(sock), {
        action: 'revoke-device',
        target: device,
        confirm: true,
      }),
    ).toEqual({ ok: false, error: 'not-found' });

    // В журнал уезжает отпечаток личности, а не uuid устройства: строку читают
    // глазами через год.
    const journal = await gw.handleAdminAudit(asSocket(sock), {});
    if (!journal.ok) throw new Error('журнал не открылся');
    expect(journal.entries.find((e) => e.action === 'device-revoked')).toMatchObject({
      target: anya.fingerprint,
      detail: { nick: 'Аня' },
    });
  });

  it('не даёт отозвать устройство, с которого сам и смотрит', async () => {
    // Ключ этого устройства — единственный способ вернуться: панель, позволившая
    // нажать здесь, отняла бы у инсталляции хозяина одним движением.
    const { gw, sock, boss } = await ownerOnline();
    const mine = await gw.handleAdminPeople(asSocket(sock), { query: boss.fingerprint });
    if (!mine.ok) throw new Error('люди не пришли');
    expect(
      await gw.handleAdminAction(asSocket(sock), {
        action: 'revoke-device',
        target: mine.people[0].devices[0].id,
        confirm: true,
      }),
    ).toEqual({ ok: false, error: 'forbidden' });

    // И пустая цель — это «такого устройства нет», а не тишина.
    expect(
      await gw.handleAdminAction(asSocket(sock), { action: 'revoke-device', confirm: true }),
    ).toEqual({ ok: false, error: 'not-found' });
  });
});

/** Сколько реплик осталось в базе — проверка того, что проход был настоящим. */
async function messagesLeft(): Promise<string> {
  const [row] = await database().query('SELECT count(*) AS n FROM messages');
  return (row as { n: string }).n;
}
