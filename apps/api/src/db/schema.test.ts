import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from './data-source';

/**
 * Единственная проверка, которая ловит расхождение сущностей и миграции.
 *
 * Схема описана дважды: классами в `entities.ts` (по ним работает код) и
 * SQL'ем в миграции (по нему живёт база). Разъезжаются они молча и
 * обнаруживаются в худшем месте — на чужом сервере, где колонки нет, а код её
 * просит.
 *
 * Спрашиваем у самого TypeORM: «что бы ты ещё дописал в эту базу?» После
 * миграции правильный ответ — ничего.
 *
 * Тесту нужна настоящая база, поэтому без `TEST_DATABASE_URL` он пропускается
 * (в CI она есть). Базу он вычищает под ноль, поэтому имя базы обязано
 * заканчиваться на `_test` — случайно направить это на живую инсталляцию
 * должно быть невозможно, а не «маловероятно».
 */
const url = process.env.TEST_DATABASE_URL;

function assertDisposable(dsn: string): void {
  const name = new URL(dsn).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(
      `TEST_DATABASE_URL указывает на базу "${name}", а этот тест вычищает схему целиком. ` +
        'Имя базы обязано заканчиваться на _test.',
    );
  }
}

describe.skipIf(!url)('схема базы', () => {
  let ds: DataSource;

  beforeAll(async () => {
    assertDisposable(url!);
    ds = createDataSource(url!);
    await ds.initialize();
    // С нуля: прошлый прогон мог оставить половину схемы или чужие таблицы.
    await ds.query('DROP SCHEMA public CASCADE');
    await ds.query('CREATE SCHEMA public');
    await ds.runMigrations();
  }, 60_000);

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('после миграции TypeORM нечего дописывать', async () => {
    const pending = await ds.driver.createSchemaBuilder().log();
    expect(pending.upQueries.map((q) => q.query)).toEqual([]);
  });

  it('откат сносит всё, что создал', async () => {
    await ds.undoLastMigration();
    const tables: { table_name: string }[] = await ds.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name <> 'migrations'`,
    );
    expect(tables.map((t) => t.table_name)).toEqual([]);
    // Возвращаем схему на место: следующему тесту нужна готовая база.
    await ds.runMigrations();
  }, 60_000);
});
