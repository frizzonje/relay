import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Упоминания: кого назвали в реплике.
 *
 * Колонкой на сообщении, а не отдельной таблицей связей, — по тому же правилу,
 * по которому здесь лежит `reply_to`. Упоминание — снимок момента: человек
 * выбрал из списка того, кого имел в виду, и написал его имя так, как оно
 * звалось тогда. Отпечаток ключа в снимке адресует личность (переименование
 * никуда его не уводит), ник рядом с ним — то самое написанное слово, по
 * которому и подсвечивается упоминание в тексте.
 *
 * Отдельная таблица дала бы строгость внешнего ключа, но за неё пришлось бы
 * платить джойном на каждую страницу ленты — а лента читается несравнимо чаще,
 * чем считаются упоминания. Строгость тут и не нужна: исчезнет личность —
 * останется имя, написанное в сказанном, ровно как остаётся имя автора.
 *
 * GIN по `jsonb_path_ops`: единственный вопрос, который задают этой колонке, —
 * «в каких сообщениях упомянут вот этот отпечаток», то есть containment
 * (`@>`). Обычный `jsonb_ops` умеет больше (поиск по ключам, существование), но
 * места занимает заметно больше, и ничего из этого здесь не спрашивают.
 */
export class Mentions1759200000000 implements MigrationInterface {
  name = 'Mentions1759200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "messages" ADD COLUMN "mentions" jsonb NOT NULL DEFAULT '[]'::jsonb`,
    );
    await q.query(
      `CREATE INDEX "messages_mentions_idx" ON "messages" USING GIN ("mentions" jsonb_path_ops)`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX "messages_mentions_idx"`);
    await q.query(`ALTER TABLE "messages" DROP COLUMN "mentions"`);
  }
}
