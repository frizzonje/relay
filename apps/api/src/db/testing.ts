import type { DataSource } from 'typeorm';
import { createDataSource } from './data-source';

/**
 * Настоящая база для тестов — не подделка.
 *
 * С 1.0 хранилище перестало быть деталью: курсор ленты, каскады, ретенция и
 * уникальность слага — это и есть поведение, которое надо проверять. Подмена в
 * памяти проверяла бы подмену, поэтому api-тесты требуют Postgres и без него не
 * запускаются вовсе. Молча пропускаться они не должны: пропущенный тест
 * выглядит зелёным.
 *
 * Как поднять базу для прогона — в CONTRIBUTING.md; в CI она сервисом.
 */

const HOWTO =
  'TEST_DATABASE_URL не задан, а тесты api работают с настоящей базой.\n' +
  '  Поднять и прогнать:\n' +
  '    docker compose -f infra/docker-compose.dev.yml up -d db\n' +
  '    docker run --rm --network relay_default -v "$PWD":/mono -w /mono \\\n' +
  '      -e TEST_DATABASE_URL=postgresql://relay:relay@db:5432/relay_test \\\n' +
  '      node:20-alpine sh -c "corepack enable && pnpm --filter @relay/api test"';

let shared: Promise<DataSource> | undefined;

/**
 * Общее на процесс соединение со схемой, приведённой миграциями. Файлы тестов
 * идут по одному (`fileParallelism: false`), так что делить одну базу им
 * безопасно — а поднимать по базе на файл значило бы платить миграциями за
 * каждый.
 */
export function testDatabase(): Promise<DataSource> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error(HOWTO);
  if (!shared) {
    shared = (async () => {
      const db = createDataSource(url);
      await db.initialize();
      await db.runMigrations();
      return db;
    })();
  }
  return shared;
}

/**
 * Чистый лист между тестами. TRUNCATE, а не DELETE: он не оставляет мёртвых
 * строк, и по нему не надо помнить порядок таблиц (CASCADE сам).
 */
export async function resetDatabase(db: DataSource): Promise<void> {
  await db.query(
    'TRUNCATE servers, channels, attachments, messages, identities, devices, roles, reads, pins CASCADE',
  );
}
