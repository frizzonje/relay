import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Схема relay 1.0 целиком, с нуля.
 *
 * DDL написан на SQL, а не выведен из сущностей на старте: `synchronize` на
 * чужом сервере — это способ однажды молча удалить колонку. Имена ограничений
 * (`PK_…`, `FK_…`) выглядят машинными, потому что они машинные: их придумывает
 * TypeORM, и они обязаны совпасть с его ожиданиями до символа — иначе он будет
 * считать, что ограничения нет, и попытается создать своё. Ровно это и
 * проверяет `schema.test.ts`: после миграции TypeORM'у больше нечего дописать.
 *
 * Четыре таблицы работают со слоя 1 (`servers`, `channels`, `attachments`,
 * `messages`), пять стоят пустыми до слоёв 2-3.
 */
export class InitialSchema1755000000000 implements MigrationInterface {
  name = 'InitialSchema1755000000000';

  public async up(q: QueryRunner): Promise<void> {
    // ── Реестр ──────────────────────────────────────────────────────────────
    await q.query(`
      CREATE TABLE "servers" (
        "id" text NOT NULL,
        "name" text NOT NULL,
        "emoji" text,
        "removable" boolean NOT NULL,
        "password_hash" text,
        "creator_id" text,
        "position" integer NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_c0947efd9f3db2dcc010164d20b" PRIMARY KEY ("id")
      )
    `);
    await q.query(`
      CREATE TABLE "channels" (
        "id" text NOT NULL,
        "server_id" text NOT NULL,
        "type" text NOT NULL,
        "name" text NOT NULL,
        "slug" text NOT NULL,
        "removable" boolean NOT NULL,
        "mode" text,
        "creator_id" text,
        "position" integer NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_bc603823f3f741359c2339389f9" PRIMARY KEY ("id")
      )
    `);
    // Слаг — имя комнаты socket.io. Два канала одного типа с одним слагом
    // делили бы одну комнату и одну ленту; до 1.0 это было возможно.
    await q.query(`CREATE UNIQUE INDEX "channels_type_slug_key" ON "channels" ("type", "slug")`);

    // ── Переписка ───────────────────────────────────────────────────────────
    await q.query(`
      CREATE TABLE "attachments" (
        "id" text NOT NULL,
        "name" text NOT NULL,
        "size" integer NOT NULL,
        "mime" text NOT NULL,
        "kind" text NOT NULL,
        "uploaded_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_5e1f050bcff31e3084a1d662412" PRIMARY KEY ("id")
      )
    `);
    await q.query(`
      CREATE TABLE "messages" (
        "id" uuid NOT NULL,
        "channel_id" text NOT NULL,
        "author_name" text NOT NULL,
        "author_identity_id" uuid,
        "text" text NOT NULL,
        "system" boolean NOT NULL DEFAULT false,
        "spoiler" boolean NOT NULL DEFAULT false,
        "attachment_id" text,
        "reply_to" jsonb,
        "reactions" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "edited_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_18325f38ae6de43878487eff986" PRIMARY KEY ("id")
      )
    `);
    // Ретенция ходит по всей таблице; лента и курсор — по каналу и полному
    // ключу (created_at, id): в одну миллисекунду попадает несколько реплик,
    // и страница по одному времени их бы теряла.
    await q.query(`CREATE INDEX "messages_created_at_idx" ON "messages" ("created_at")`);
    await q.query(
      `CREATE INDEX "messages_channel_ts_idx" ON "messages" ("channel_id", "created_at", "id")`,
    );

    // ── Личность (слой 2) ───────────────────────────────────────────────────
    await q.query(`
      CREATE TABLE "identities" (
        "id" uuid NOT NULL,
        "public_key" text NOT NULL,
        "fingerprint" text NOT NULL,
        "nick" text NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "last_seen_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "UQ_1762ce7edd3cac22778000326da" UNIQUE ("public_key"),
        CONSTRAINT "UQ_dc228c3a44742146cc29f0f1cb1" UNIQUE ("fingerprint"),
        CONSTRAINT "PK_7b2f8cccf4ac6a2d7e6e9e8b1f6" PRIMARY KEY ("id")
      )
    `);
    await q.query(`
      CREATE TABLE "devices" (
        "id" uuid NOT NULL,
        "identity_id" uuid NOT NULL,
        "public_key" text NOT NULL,
        "name" text NOT NULL,
        "certificate" text,
        "parent_device_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "last_seen_at" TIMESTAMP WITH TIME ZONE,
        "revoked_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "UQ_7b1630cb076731f40bc90876fd4" UNIQUE ("public_key"),
        CONSTRAINT "PK_b1514758245c12daf43486dd1f0" PRIMARY KEY ("id")
      )
    `);

    // ── Слой 3 ──────────────────────────────────────────────────────────────
    await q.query(`
      CREATE TABLE "roles" (
        "id" uuid NOT NULL,
        "identity_id" uuid NOT NULL,
        "server_id" text,
        "role" text NOT NULL,
        "granted_by" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_c1433d71a4838793a49dcad46ab" PRIMARY KEY ("id")
      )
    `);
    // ВНИМАНИЕ слою 3: у NULL-серверов (роль на всю инсталляцию) этот индекс
    // не сработает — Postgres считает NULL'ы различными, и вторую строку
    // «владелец инсталляции» для той же личности он пропустит. Когда роли
    // начнут писаться, сюда нужен либо NULLS NOT DISTINCT, либо частичный
    // уникальный индекс по (identity_id) WHERE server_id IS NULL.
    await q.query(
      `CREATE UNIQUE INDEX "roles_identity_server_key" ON "roles" ("identity_id", "server_id")`,
    );
    await q.query(`
      CREATE TABLE "reads" (
        "identity_id" uuid NOT NULL,
        "channel_id" text NOT NULL,
        "read_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_b8747b7fc54dfaef110eda6efec" PRIMARY KEY ("identity_id", "channel_id")
      )
    `);
    await q.query(`
      CREATE TABLE "pins" (
        "message_id" uuid NOT NULL,
        "channel_id" text NOT NULL,
        "pinned_by" uuid,
        "pinned_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_5a65d26b34fb5deab23aa2d5be5" PRIMARY KEY ("message_id")
      )
    `);

    // ── Связи ───────────────────────────────────────────────────────────────
    // Сервер уносит с собой каналы, канал — свои сообщения. Вложение переживает
    // своё сообщение (SET NULL): файл на диске удаляет чистильщик, и делать это
    // он должен по своим правилам, а не под каскадом.
    await q.query(`
      ALTER TABLE "channels" ADD CONSTRAINT "FK_4c165ab5af7e2d4cf44bfb05d66"
        FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await q.query(`
      ALTER TABLE "messages" ADD CONSTRAINT "FK_86b9109b155eb70c0a2ca3b4b6d"
        FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await q.query(`
      ALTER TABLE "messages" ADD CONSTRAINT "FK_d2e0ab24e536e1933067c8f37e6"
        FOREIGN KEY ("attachment_id") REFERENCES "attachments"("id") ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    await q.query(`
      ALTER TABLE "devices" ADD CONSTRAINT "FK_f1403e764881218a671feb60530"
        FOREIGN KEY ("identity_id") REFERENCES "identities"("id") ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await q.query(`
      ALTER TABLE "roles" ADD CONSTRAINT "FK_a4589a81658af2c1d0c9841e5c2"
        FOREIGN KEY ("identity_id") REFERENCES "identities"("id") ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await q.query(`
      ALTER TABLE "pins" ADD CONSTRAINT "FK_5a65d26b34fb5deab23aa2d5be5"
        FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  /**
   * Откат сносит схему целиком — вместе с перепиской. Это осознанно: первая
   * миграция создаёт базу с нуля, и «частично откатить» её не во что. Путь
   * отката на 0.x — восстановление из бэкапа, который `relay update` снимает
   * перед мажором, а не эта функция.
   */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "pins" DROP CONSTRAINT "FK_5a65d26b34fb5deab23aa2d5be5"`);
    await q.query(`ALTER TABLE "roles" DROP CONSTRAINT "FK_a4589a81658af2c1d0c9841e5c2"`);
    await q.query(`ALTER TABLE "devices" DROP CONSTRAINT "FK_f1403e764881218a671feb60530"`);
    await q.query(`ALTER TABLE "messages" DROP CONSTRAINT "FK_d2e0ab24e536e1933067c8f37e6"`);
    await q.query(`ALTER TABLE "messages" DROP CONSTRAINT "FK_86b9109b155eb70c0a2ca3b4b6d"`);
    await q.query(`ALTER TABLE "channels" DROP CONSTRAINT "FK_4c165ab5af7e2d4cf44bfb05d66"`);
    await q.query(`DROP TABLE "pins"`);
    await q.query(`DROP TABLE "reads"`);
    await q.query(`DROP INDEX "public"."roles_identity_server_key"`);
    await q.query(`DROP TABLE "roles"`);
    await q.query(`DROP TABLE "devices"`);
    await q.query(`DROP TABLE "identities"`);
    await q.query(`DROP INDEX "public"."messages_channel_ts_idx"`);
    await q.query(`DROP INDEX "public"."messages_created_at_idx"`);
    await q.query(`DROP TABLE "messages"`);
    await q.query(`DROP TABLE "attachments"`);
    await q.query(`DROP INDEX "public"."channels_type_slug_key"`);
    await q.query(`DROP TABLE "channels"`);
    await q.query(`DROP TABLE "servers"`);
  }
}
