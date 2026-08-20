import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Реакция перестаёт подписываться именем.
 *
 * До 1.0 в `reactions` лежало `{ эмодзи: [имя, имя] }`, и «своя» реакция
 * узнавалась по совпадению ника. Ники здесь свободные и не уникальные, то есть
 * переименовавшийся в чужое имя снимал чужую реакцию и ставил свою от чужого
 * имени (audit S1). Теперь в списке лежит `{ fingerprint, nick }` — тот же
 * снимок, что и у упоминаний: отпечаток адресует личность, ник рядом с ним
 * говорит, как её звали в ту минуту.
 *
 * Записанное прежними версиями переезжает без отпечатка — взять его неоткуда,
 * связи имени с ключом до 1.0 не существовало вовсе. Такая реакция остаётся
 * видимой и считается, но своей её больше не признаёт никто с ключом: иначе
 * достаточно было бы назваться тем же именем, ради чего всё и менялось.
 */
export class ReactionIdentity1759300000000 implements MigrationInterface {
  name = 'ReactionIdentity1759300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE "messages" SET "reactions" = (
        SELECT COALESCE(jsonb_object_agg(emoji, people), '{}'::jsonb)
        FROM (
          SELECT r.key AS emoji, (
            SELECT jsonb_agg(jsonb_build_object('nick', n))
            FROM jsonb_array_elements_text(r.value) AS n
          ) AS people
          FROM jsonb_each("messages"."reactions") AS r
        ) AS converted
      )
      WHERE "reactions" <> '{}'::jsonb
        AND jsonb_typeof(("reactions" -> (SELECT k FROM jsonb_object_keys("reactions") AS k LIMIT 1)) -> 0) = 'string'
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE "messages" SET "reactions" = (
        SELECT COALESCE(jsonb_object_agg(emoji, people), '{}'::jsonb)
        FROM (
          SELECT r.key AS emoji, (
            SELECT jsonb_agg(p ->> 'nick')
            FROM jsonb_array_elements(r.value) AS p
          ) AS people
          FROM jsonb_each("messages"."reactions") AS r
        ) AS converted
      )
      WHERE "reactions" <> '{}'::jsonb
        AND jsonb_typeof(("reactions" -> (SELECT k FROM jsonb_object_keys("reactions") AS k LIMIT 1)) -> 0) = 'object'
    `);
  }
}
