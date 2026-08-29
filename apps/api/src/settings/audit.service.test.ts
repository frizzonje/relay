import { Logger } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditRow, IdentityRow, RoleRow } from '../db/entities';
import { resetDatabase, testDatabase } from '../db/testing';
import { fingerprint as fingerprintOf } from '../identity/crypto';
import { OwnerService } from '../identity/owner.service';
import { RolesService } from '../identity/roles.service';
import { AuditService } from './audit.service';
import { freshSettings } from './settings.testkit';
import type { SettingsService } from './settings.service';

/**
 * Журнал проверяется на настоящей базе и настоящими действиями: его ценность
 * ровно в том, что запись переживает и перезапуск, и чистку сообщений, и
 * удаление личности того, кто действовал.
 *
 * Два утверждения здесь важнее прочих. Первое: запись НЕ СРЫВАЕТ ДЕЙСТВИЕ —
 * бан, не случившийся из-за недоступного журнала, хуже незаписанного бана.
 * Второе: систему узнают по пустому автору, а не по тексту ника, иначе человек
 * с подходящим именем подделает системную запись.
 */

let db: DataSource;
let audit: AuditService;

beforeAll(async () => {
  db = await testDatabase();
});

afterAll(async () => {
  await db?.destroy();
});

beforeEach(async () => {
  await resetDatabase(db);
  audit = new AuditService(db);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Личность в базе: журнал берёт из неё имя снимком, а лицо — соединением. */
async function person(nick: string): Promise<{ id: string; fingerprint: string }> {
  const id = randomUUID();
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
  return { id, fingerprint };
}

const settingsFor = (): Promise<SettingsService> => freshSettings(db);

/**
 * Часы, шагающие вперёд от вызова к вызову. Две записи подряд иначе легко
 * ложатся в одну миллисекунду, и порядок в странице начинает решать случайный
 * uuid — тест зеленел бы через раз. Там, где проверяется именно порядок, часы
 * обязаны быть свои.
 */
function ticking(): () => number {
  let at = Date.UTC(2026, 0, 1);
  return () => (at += 1000);
}

describe('настройки', () => {
  it('пишет изменение параметра со «стало» и «было»', async () => {
    const boss = await person('Хозяин');
    const settings = await settingsFor();

    await settings.set('messages.retentionDays', 30, boss.id);

    const { entries } = await audit.page();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: boss.fingerprint,
      actorNick: 'Хозяин',
      action: 'setting-changed',
      target: 'messages.retentionDays',
      detail: { from: 14, to: 30 },
    });
    // Системной эта запись не считается ни при каких обстоятельствах: автор
    // есть, и панель обязана нарисовать его лицо, а не машину.
    expect(entries[0].system).toBeUndefined();
  });

  it('не пишет ничего, когда значение и так было таким', async () => {
    const boss = await person('Хозяин');
    const settings = await settingsFor();

    const done = await settings.set('messages.retentionDays', 14, boss.id);

    expect(done).toEqual({ ok: true, changed: false, before: 14 });
    expect((await audit.page()).entries).toEqual([]);
  });

  it('общая дорога секрет не принимает — и в журнал от неё не попадает ничего', async () => {
    const boss = await person('Хозяин');
    const settings = await settingsFor();

    // План обещал здесь запись `password-changed`, но общая запись секрета
    // отбита ещё в задаче 3: у пароля своя дорога со scrypt и отзывом
    // пропусков, и в журнал пишет она. Проверяем то, что есть: секрет не
    // сохранён и в журнале нет ни строки — тем более со значением.
    const done = await settings.set('access.sitePasswordSet', 'тайна', boss.id);

    expect(done).toEqual({ ok: false, error: 'secret-path' });
    const { entries } = await audit.page();
    expect(entries).toEqual([]);
    expect(JSON.stringify(entries)).not.toContain('тайна');
  });

  it('сброс группы — одна запись со списком ключей, а не по записи на ключ', async () => {
    const boss = await person('Хозяин');
    const settings = await settingsFor();
    await settings.set('messages.retentionDays', 30, boss.id);
    await settings.set('messages.pinLimit', 7, boss.id);

    const changed = await settings.resetGroup('messages', boss.id);

    expect(changed.sort()).toEqual(['messages.pinLimit', 'messages.retentionDays']);
    const resets = (await audit.page()).entries.filter((e) => e.action === 'settings-reset');
    expect(resets).toHaveLength(1);
    expect(resets[0]).toMatchObject({ target: 'messages', actorNick: 'Хозяин' });
    expect((resets[0].detail.keys as string[]).sort()).toEqual([
      'messages.pinLimit',
      'messages.retentionDays',
    ]);
  });

  it('сброс, ничего не изменивший, событием не считается', async () => {
    const boss = await person('Хозяин');
    const settings = await settingsFor();

    expect(await settings.resetGroup('messages', boss.id)).toEqual([]);
    expect((await audit.page()).entries).toEqual([]);
  });
});

describe('баны', () => {
  it('бан и разбан помнят отпечаток, имя и охват', async () => {
    const boss = await person('Хозяин');
    const anya = await person('Аня');
    const roles = new RolesService(db, ticking());

    await roles.ban(anya.id, 'srv', boss.id);
    await roles.unban(anya.id, 'srv', boss.id);

    const { entries } = await audit.page();
    expect(entries.map((e) => e.action)).toEqual(['unban', 'ban']);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        actor: boss.fingerprint,
        actorNick: 'Хозяин',
        target: anya.fingerprint,
        detail: { nick: 'Аня', server: 'srv' },
      });
    }
  });

  it('бан на всю инсталляцию отличим от бана на сервере', async () => {
    const boss = await person('Хозяин');
    const anya = await person('Аня');
    const roles = new RolesService(db);

    await roles.ban(anya.id, null, boss.id);

    // Пустой охват — вся инсталляция, и через год это единственное, что
    // отличает «выгнали с сервера» от «не пускают вовсе».
    expect((await audit.page()).entries[0].detail).toEqual({ nick: 'Аня', server: null });
  });

  it('несостоявшийся бан в журнал не попадает', async () => {
    const boss = await person('Хозяин');
    const roles = new RolesService(db);

    expect(await roles.ban(randomUUID(), null, boss.id)).toEqual({ ok: false, reason: 'unknown' });
    expect(await roles.unban(randomUUID(), null, boss.id)).toBe(false);
    expect((await audit.page()).entries).toEqual([]);
  });
});

describe('владелец', () => {
  it('взятие власти помнит, у кого её забрали', async () => {
    const anya = await person('Аня');
    const boris = await person('Борис');
    const owner = new OwnerService(db, ticking());

    await owner.claim((await owner.issue()).token, anya.id);
    await owner.claim((await owner.issue()).token, boris.id);

    const claims = (await audit.page()).entries.filter((e) => e.action === 'owner-claimed');
    expect(claims).toHaveLength(2);
    // Свежая — переход власти; та, что старше, — первое взятие, и «от кого» у
    // неё нет вовсе: выдумывать прежнего владельца там нечего.
    expect(claims[0]).toMatchObject({
      actor: boris.fingerprint,
      actorNick: 'Борис',
      detail: { previous: { fingerprint: anya.fingerprint, nick: 'Аня' } },
    });
    expect(claims[1]).toMatchObject({ actor: anya.fingerprint, detail: {} });
  });

  it('ссылка из ssh — системная запись, из панели — с автором', async () => {
    const boss = await person('Хозяин');
    const owner = new OwnerService(db, ticking());

    await owner.issue();
    await owner.issue(boss.id);

    const issued = (await audit.page()).entries.filter((e) => e.action === 'owner-link-issued');
    expect(issued[0]).toMatchObject({ actor: boss.fingerprint, actorNick: 'Хозяин' });
    expect(issued[0].system).toBeUndefined();
    expect(issued[1]).toMatchObject({ actorNick: 'system', system: true });
    expect(issued[1].actor).toBeUndefined();
    // Сам ключ в журнале не появляется ни в каком виде: строка нужна, чтобы
    // увидеть чужой перевыпуск, а не чтобы им воспользоваться.
    expect(Object.keys(issued[1].detail)).toEqual(['expiresAt']);
  });
});

describe('автор', () => {
  it('помнит, кто действовал, даже если личность потом исчезла', async () => {
    const boss = await person('Хозяин');
    const settings = await settingsFor();
    await settings.set('messages.retentionDays', 30, boss.id);

    await db.getRepository(IdentityRow).delete({ id: boss.id });

    const [entry] = (await audit.page()).entries;
    expect(entry.actorNick).toBe('Хозяин');
    // Лица нет — рисовать его не по чему; но автор БЫЛ, и системной эту запись
    // звать нельзя.
    expect(entry.actor).toBeUndefined();
    expect(entry.system).toBeUndefined();
  });

  it('систему узнают по пустому автору, а не по тексту ника', async () => {
    const impostor = await person('system');
    const clock = ticking();

    await new AuditService(db, clock).write({ actor: null, action: 'retention-run' });
    await new AuditService(db, clock).write({ actor: impostor.id, action: 'files-swept' });

    const [human, machine] = (await audit.page()).entries;
    // Ники у обеих записей одинаковые — и это ровно та ловушка, ради которой
    // систему узнают по автору: иначе назвавшийся так человек подделал бы её.
    expect(human).toMatchObject({ actorNick: 'system', actor: impostor.fingerprint });
    expect(human.system).toBeUndefined();
    expect(machine).toMatchObject({ actorNick: 'system', system: true });
  });

  it('автор без личности не отменяет записи', async () => {
    // Так выглядит правка, подписанная тем, кого база не знает: запись всё
    // равно нужна — «действие было» важнее, чем «мы знаем, как его звали».
    await audit.write({ actor: randomUUID(), action: 'sessions-revoked' });

    const [entry] = (await audit.page()).entries;
    expect(entry.actorNick).toBe('unknown');
    expect(entry.actor).toBeUndefined();
    expect(entry.system).toBeUndefined();
  });
});

describe('страницы', () => {
  /** Часы под рукой: миллисекунду делят несколько записей, и это надо подстроить. */
  function clocked(at: number): AuditService {
    return new AuditService(db, () => at);
  }

  it('идут от свежих к старым', async () => {
    for (const [i, at] of [1_000_000, 2_000_000, 3_000_000].entries()) {
      await clocked(at).write({ actor: null, action: 'retention-run', target: `run-${i}` });
    }

    const { entries, more } = await audit.page();
    expect(entries.map((e) => e.target)).toEqual(['run-2', 'run-1', 'run-0']);
    expect(entries.map((e) => e.at)).toEqual([3_000_000, 2_000_000, 1_000_000]);
    expect(more).toBe(false);
  });

  it('не теряют записи на границе, даже если они одной миллисекунды', async () => {
    const same = clocked(1_700_000_000_000);
    for (let i = 0; i < 3; i++) {
      await same.write({ actor: null, action: 'retention-run', target: `run-${i}` });
    }

    const first = await audit.page(undefined, 2);
    expect(first.more).toBe(true);
    const edge = first.entries[1];
    const second = await audit.page({ at: edge.at, id: edge.id }, 2);

    expect(second.more).toBe(false);
    const seen = [...first.entries, ...second.entries].map((e) => e.target);
    // Ни одной потерянной и ни одной показанной дважды — ради этого курсор и
    // состоит из времени и id разом.
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });

  it('негодный курсор — пустая страница, а не первая', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    await audit.write({ actor: null, action: 'retention-run' });

    // Первая страница означала бы, что сбившаяся панель по кругу показывает
    // одно и то же начало журнала и никто этого не замечает.
    expect(await audit.page({ at: 1000, id: 'не-uuid' })).toEqual({ entries: [], more: false });
    expect(await audit.page({ at: Number.NaN, id: randomUUID() })).toEqual({
      entries: [],
      more: false,
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('размер страницы не выходит за потолок и не бывает нулевым', async () => {
    for (let i = 0; i < 3; i++) await audit.write({ actor: null, action: 'retention-run' });

    expect((await audit.page(undefined, 0)).entries).toHaveLength(3);
    expect((await audit.page(undefined, 10_000)).entries).toHaveLength(3);
    expect((await audit.page(undefined, 1)).entries).toHaveLength(1);
  });
});

describe('журнал не срывает действие', () => {
  /**
   * Отнять у журнала базу, оставив её всем остальным. Ломается ровно вставка в
   * `audit` — так, как это выглядело бы при кончившемся месте на диске.
   */
  function breakTheJournal(): void {
    const real = db.query.bind(db);
    vi.spyOn(db, 'query').mockImplementation((sql: string, params?: unknown[]) =>
      sql.includes('INSERT INTO audit')
        ? Promise.reject(new Error('журнал прилёг'))
        : real(sql, params),
    );
  }

  it('бан состоялся, хотя записать его не удалось', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const boss = await person('Хозяин');
    const anya = await person('Аня');
    const roles = new RolesService(db);
    breakTheJournal();

    expect(await roles.ban(anya.id, null, boss.id)).toEqual({ ok: true });

    expect(await db.getRepository(RoleRow).countBy({ identityId: anya.id })).toBe(1);
    expect(await db.getRepository(AuditRow).count()).toBe(0);
    // Молча терять записи нельзя: строка в логе — единственный способ узнать,
    // что журнал начал врать неполнотой.
    expect(error.mock.calls.flat().join(' ')).toContain('ban');
  });

  it('настройка сохранилась, хотя записать её не удалось', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const boss = await person('Хозяин');
    const settings = await settingsFor();
    breakTheJournal();

    expect(await settings.set('messages.retentionDays', 30, boss.id)).toEqual({
      ok: true,
      changed: true,
      before: 14,
    });
    expect(settings.get('messages.retentionDays')).toBe(30);
  });
});
