import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Настройки человека переезжают из браузера на личность.
 *
 * Таблицы для них в первой миграции не было: пока личности не существовало,
 * настройке некуда было принадлежать, кроме localStorage. Теперь есть — и
 * «выкрутил громкость этому крикуну» перестаёт быть свойством одной вкладки.
 *
 * Строка на ключ, а не документ на человека: два устройства, поменявшие разные
 * настройки одновременно, не затирают друг друга.
 *
 * Внешнего ключа на личность нет — по той же причине, что и у соседних таблиц
 * слоя 3: настройка не должна запирать удаление личности. Осиротевшие строки
 * невидимы (их некому спросить) и уходят вместе с уборкой.
 */
export class Prefs1758000000000 implements MigrationInterface {
  name = 'Prefs1758000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "prefs" (
        "identity_id" uuid NOT NULL,
        "key" text NOT NULL,
        "value" jsonb NOT NULL,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_prefs_identity_key" PRIMARY KEY ("identity_id", "key")
      )
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "prefs"`);
  }
}
