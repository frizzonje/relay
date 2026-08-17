import { randomBytes, randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IdentityRow, PrefRow, ReadRow } from '../db/entities';
import { resetDatabase, testDatabase } from '../db/testing';
import { fingerprint as fingerprintOf } from './crypto';
import { PREF_MAX_BYTES, PrefsService } from './prefs.service';
import { ReadsService } from './reads.service';

/**
 * Личное состояние человека: докуда он дочитал каналы и как настроил relay
 * под себя. С настоящей базой — вся суть переезда в том, что запись переживает
 * и перезагрузку страницы, и смену устройства.
 *
 * Два хранилища рядом, потому что различаются они ровно одним, и это главное,
 * что здесь проверяется: у отметок чтения слияние по максимуму (назад отметка
 * не ходит), у настроек — последнее слово за последним записавшим.
 */

let db: DataSource;
let reads: ReadsService;
let prefs: PrefsService;

beforeAll(async () => {
  db = await testDatabase();
});

afterAll(async () => {
  await db?.destroy();
});

beforeEach(async () => {
  await resetDatabase(db);
  reads = new ReadsService(db);
  prefs = new PrefsService(db);
});

async function person(nick: string): Promise<string> {
  const id = randomUUID();
  const key = randomBytes(32).toString('base64url');
  await db.getRepository(IdentityRow).insert({
    id,
    publicKey: key,
    fingerprint: fingerprintOf(key),
    nick,
    createdAt: new Date(),
    lastSeenAt: null,
  });
  return id;
}

describe('отметки чтения', () => {
  it('без единой строки канал просто не прочитан', async () => {
    const anya = await person('Аня');
    expect(await reads.marks(anya)).toEqual(new Map());
  });

  it('прочитанное на одном устройстве прочитано и на другом', async () => {
    const anya = await person('Аня');
    await reads.mark(anya, 'ch-1', 1_000);
    // Второе устройство спрашивает то же самое хранилище — в этом весь переезд.
    expect(await reads.marks(anya)).toEqual(new Map([['ch-1', 1_000]]));
  });

  it('отметка растёт и только растёт', async () => {
    const anya = await person('Аня');
    expect(await reads.mark(anya, 'ch-1', 5_000)).toBe(5_000);
    // Устройство, проснувшееся со старым снимком, не должно объявлять
    // прочитанное непрочитанным заново: спор оно не выигрывает и не проигрывает,
    // оно просто ничего не делает.
    expect(await reads.mark(anya, 'ch-1', 3_000)).toBeNull();
    expect(await reads.marks(anya)).toEqual(new Map([['ch-1', 5_000]]));
    expect(await reads.mark(anya, 'ch-1', 9_000)).toBe(9_000);
  });

  it('будущим временем канал не дочитывается', async () => {
    const anya = await person('Аня');
    const now = 1_000_000;
    const later = new ReadsService(db, () => now);
    const mark = await later.mark(anya, 'ch-1', now + 60_000);
    // Иначе один кривой клиент разом и навсегда гасил бы себе непрочитанное
    // во всех каналах: отметка ушла бы в будущее, куда активность не дорастёт.
    expect(mark).toBe(now);
  });

  it('отметки у людей свои', async () => {
    const anya = await person('Аня');
    const boris = await person('Борис');
    await reads.mark(anya, 'ch-1', 4_000);
    expect(await reads.marks(boris)).toEqual(new Map());
  });

  it('канала не стало — отметок о нём тоже', async () => {
    const anya = await person('Аня');
    await reads.mark(anya, 'ch-1', 4_000);
    await reads.mark(anya, 'ch-2', 4_000);
    await reads.forget('ch-1');
    expect(await reads.marks(anya)).toEqual(new Map([['ch-2', 4_000]]));
    expect(await db.getRepository(ReadRow).countBy({ channelId: 'ch-1' })).toBe(0);
  });
});

describe('настройки', () => {
  it('снимок пуст, пока человек ничего не менял', async () => {
    const anya = await person('Аня');
    expect(await prefs.values(anya)).toEqual({});
  });

  it('настройка едет с личностью, а не с браузером', async () => {
    const anya = await person('Аня');
    expect(await prefs.set(anya, 'sound', ['общий'])).toBe(true);
    expect(await prefs.values(anya)).toEqual({ sound: ['общий'] });
  });

  it('внутри одного ключа выигрывает последний записавший', async () => {
    const anya = await person('Аня');
    await prefs.set(anya, 'sound', ['общий']);
    await prefs.set(anya, 'sound', []);
    // Слить два списка «каналов со звуком» нечем, кроме как выбрать один:
    // притворяться, что можно, значило бы вернуть человеку звук там, где он
    // его выключал.
    expect(await prefs.values(anya)).toEqual({ sound: [] });
  });

  it('разные ключи не затирают друг друга', async () => {
    const anya = await person('Аня');
    await prefs.set(anya, 'sound', ['общий']);
    await prefs.set(anya, 'volume', { Борис: { voice: 2 } });
    // Ради этого настройки и лежат строкой на ключ: два устройства, меняющие
    // разное в одну секунду, не должны спорить.
    expect(await prefs.values(anya)).toEqual({
      sound: ['общий'],
      volume: { Борис: { voice: 2 } },
    });
  });

  it('чужой ключ — отказ, а не свободное хранилище', async () => {
    const anya = await person('Аня');
    expect(await prefs.set(anya, 'мой-архив', 'что угодно')).toBe(false);
    expect(await db.getRepository(PrefRow).count()).toBe(0);
  });

  it('слишком большое значение не принимается', async () => {
    const anya = await person('Аня');
    const huge = Array.from({ length: PREF_MAX_BYTES }, (_, i) => `канал-${i}`);
    expect(await prefs.set(anya, 'sound', huge)).toBe(false);
    expect(await prefs.values(anya)).toEqual({});
  });

  it('настройки у людей свои', async () => {
    const anya = await person('Аня');
    const boris = await person('Борис');
    await prefs.set(anya, 'sound', ['общий']);
    expect(await prefs.values(boris)).toEqual({});
  });
});
