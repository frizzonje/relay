import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Настройки инсталляции и журнал того, кто их менял.
 *
 * До этого настройка инсталляции была строкой в `.env`, то есть правом того, у
 * кого есть ssh. Это честная модель ровно до первой инсталляции, которую
 * поставили одному человеку, а распоряжается ей другой. Таблица переносит
 * решение туда же, где живёт власть, — к владельцу, опознанному ключом.
 *
 * Значение — jsonb, а не text: у параметра есть тип (число, флаг, список), и
 * хранить его строкой значило бы разбирать её на каждом чтении и спорить о том,
 * что такое «true».
 *
 * Журнал — таблица, а не лог. Файловый лог уезжает в ротацию, его нет в
 * интерфейсе и по нему нельзя ответить на вопрос «кто снял бан позавчера», а
 * это вопрос к продукту, а не к `docker logs`.
 */
export class Settings1761000000000 implements MigrationInterface {
  name = 'Settings1761000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "settings" (
        "key" text NOT NULL,
        "value" jsonb NOT NULL,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_by" uuid,
        CONSTRAINT "PK_settings" PRIMARY KEY ("key")
      )
    `);
    await q.query(`
      CREATE TABLE "audit" (
        "id" uuid NOT NULL,
        "at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "actor" uuid,
        "actor_nick" text NOT NULL,
        "action" text NOT NULL,
        "target" text,
        "detail" jsonb NOT NULL DEFAULT '{}',
        CONSTRAINT "PK_audit" PRIMARY KEY ("id")
      )
    `);
    // Журнал читается страницами от свежих к старым — это и есть его индекс.
    await q.query(`CREATE INDEX "audit_at_idx" ON "audit" ("at" DESC, "id" DESC)`);
    await q.query(`CREATE INDEX "audit_actor_idx" ON "audit" ("actor")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "audit"`);
    await q.query(`DROP TABLE "settings"`);
  }
}
