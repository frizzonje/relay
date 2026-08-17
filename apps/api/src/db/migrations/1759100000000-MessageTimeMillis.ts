import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Время реплики хранится с той же точностью, с какой уезжает клиенту.
 *
 * По умолчанию у Postgres микросекунды, а на проводе — миллисекунды: `ts` в
 * протоколе это `Date.getTime()`. Пока лента листалась только вверх, лишние три
 * знака сходили с рук — курсор «строго старше» просто отсекал чуть больше, чем
 * надо. С переходом из поиска лента научилась листаться вниз, и тот же курсор
 * с округлённым временем стал возвращать реплику, от которой он взят: в базе
 * `12:00:00.0014`, в курсоре `12:00:00.001`, и строка «новее самой себя».
 *
 * Лечится это не подпорками в условиях, а тем, что хранимое время и время на
 * проводе становятся одним и тем же значением. Заодно исчезает старая тихая
 * потеря: две реплики одной миллисекунды, различимые только микросекундами,
 * могли не попасть ни в одну страницу.
 *
 * Существующие значения округляются до миллисекунд. Порядок реплик от этого не
 * меняется, а если две оказываются в одном мгновении — их всё так же разводит
 * id, вторая половина курсора.
 */
export class MessageTimeMillis1759100000000 implements MigrationInterface {
  name = 'MessageTimeMillis1759100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "messages" ALTER COLUMN "created_at" TYPE TIMESTAMP(3) WITH TIME ZONE`,
    );
    // Обрезаем, а не округляем: округление сдвигает время вперёд на долю
    // миллисекунды, и реплика оказывается написанной в будущем. Ретенция
    // сравнивает его с `now()`, клиент считает по нему «только что», и оба
    // получают ответ, которого не ждали.
    await q.query(
      `ALTER TABLE "messages" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now())`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "messages" ALTER COLUMN "created_at" SET DEFAULT now()`);
    await q.query(`ALTER TABLE "messages" ALTER COLUMN "created_at" TYPE TIMESTAMP WITH TIME ZONE`);
  }
}
