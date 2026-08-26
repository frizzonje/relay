import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Личные сообщения: беседа — это канал без сервера.
 *
 * Отдельной таблицы сообщений у ЛС нет и не будет. Всё, что уже умеет
 * текстовый канал — курсор ленты, вложения, реакции, поиск, ретенция,
 * каскадное удаление, — держится на `messages.channel_id`, и повторять это
 * второй раз ради двух собеседников значило бы завести вторую ленту с теми же
 * граблями и своим набором ошибок.
 *
 * Поэтому `server_id` становится необязательным: у беседы сервера нет. Кто в
 * ней участвует, знает `conversations` — и только она: реестр, который
 * рассылается всем, о беседах не знает вовсе.
 */
export class DirectMessages1760000000000 implements MigrationInterface {
  name = 'DirectMessages1760000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "channels" ALTER COLUMN "server_id" DROP NOT NULL`);
    await q.query(`
      CREATE TABLE "conversations" (
        "id" uuid NOT NULL,
        "channel_id" text NOT NULL,
        "a" uuid NOT NULL,
        "b" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_conversations" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_conversations_channel" UNIQUE ("channel_id"),
        CONSTRAINT "FK_1a99838ee2e2e940ad98ed2e9d8" FOREIGN KEY ("channel_id")
          REFERENCES "channels"("id") ON DELETE CASCADE
      )
    `);
    // Пара уникальна. Порядок внутри пары нормализован (a < b) кодом, а не
    // базой: иначе одна и та же переписка завелась бы дважды — по строке на
    // того, кто написал первым.
    await q.query(`CREATE UNIQUE INDEX "conversations_pair_key" ON "conversations" ("a", "b")`);
    // «Мои переписки» — запрос на каждый вход в раздел, и он идёт по обеим
    // колонкам: своя сторона у человека то первая, то вторая.
    await q.query(`CREATE INDEX "conversations_a_idx" ON "conversations" ("a")`);
    await q.query(`CREATE INDEX "conversations_b_idx" ON "conversations" ("b")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "conversations"`);
    await q.query(`DELETE FROM "channels" WHERE "server_id" IS NULL`);
    await q.query(`ALTER TABLE "channels" ALTER COLUMN "server_id" SET NOT NULL`);
  }
}
