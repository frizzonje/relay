import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Отметка о пропущенном звонке: колонка `call` у реплики.
 *
 * Отдельной таблицы у отметки нет по той же причине, по которой её нет у
 * личных сообщений (см. миграцию DirectMessages): всё, что отметке нужно —
 * место в ленте, курсор пагинации, ретенция, каскадное удаление вместе с
 * беседой, — уже держится на `messages`, и вторая таблица повторила бы это
 * ради двух полей.
 *
 * Колонка необязательная и без дефолта: у всего, что уже лежит в таблице,
 * отметки нет и быть не может, а `NULL` говорит это прямо — в отличие от
 * пустого объекта, который читался бы как «звонок был, но неизвестно какой».
 * Поэтому же обновление существующей инсталляции ничего не переписывает: одна
 * `ALTER TABLE ... ADD COLUMN` без дефолта в Postgres не трогает ни строки.
 */
export class CallMark1762000000000 implements MigrationInterface {
  name = 'CallMark1762000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "messages" ADD COLUMN "call" jsonb`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "messages" DROP COLUMN "call"`);
  }
}
