import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Владелец инсталляции: приглашение и место, где власть записана.
 *
 * Две правки, и обе — про одну и ту же строку в `roles`, у которой
 * `server_id IS NULL`.
 *
 * Первая — таблица приглашений. Ключ, напечатанный установщиком, обязан
 * пережить перезапуск стека и ночь между установкой и первым заходом человека,
 * а память процесса api не переживает ни того, ни другого.
 *
 * Вторая — уникальность роли на всю инсталляцию. Первая миграция оставила здесь
 * записку самой себе: `UNIQUE (identity_id, server_id)` не работает, когда
 * server_id пуст, потому что для Postgres два NULL'а по умолчанию различны, —
 * и одна личность могла бы получить двух «владельцев инсталляции». Теперь роли
 * начинают писаться, значит записку пора закрыть: `NULLS NOT DISTINCT`
 * (Postgres 15+, у нас 18) делает пустоту обычным значением.
 */
export class OwnerClaim1756000000000 implements MigrationInterface {
  name = 'OwnerClaim1756000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "owner_claims" (
        "id" uuid NOT NULL,
        "token_hash" text NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "used_at" TIMESTAMP WITH TIME ZONE,
        "used_by" uuid,
        CONSTRAINT "UQ_ffe2456d311ed9cf8741e70a84f" UNIQUE ("token_hash"),
        CONSTRAINT "PK_a39fd6d2f692ec39f8b3ea34b21" PRIMARY KEY ("id")
      )
    `);

    // Пересоздание, а не ALTER: у индекса это свойство меняется только так.
    // Имя сохраняем — по нему TypeORM узнаёт индекс своим.
    await q.query(`DROP INDEX "roles_identity_server_key"`);
    await q.query(
      `CREATE UNIQUE INDEX "roles_identity_server_key" ON "roles" ("identity_id", "server_id") NULLS NOT DISTINCT`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX "roles_identity_server_key"`);
    await q.query(
      `CREATE UNIQUE INDEX "roles_identity_server_key" ON "roles" ("identity_id", "server_id")`,
    );
    await q.query(`DROP TABLE "owner_claims"`);
  }
}
