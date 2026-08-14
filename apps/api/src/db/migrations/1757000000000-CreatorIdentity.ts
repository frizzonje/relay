import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Создатель сервера и канала становится личностью.
 *
 * До 1.0 «мой сервер» означало «созданный с этого устройства»: в `creator_id`
 * лежал clientId из localStorage. Он подделывается и теряется — чистка браузера
 * оставляла человека без прав на собственный сервер.
 *
 * Новая колонка не заменяет старую, а встаёт рядом, и это главное решение этой
 * миграции. Переписать `creator_id` в личности нечем: clientId никогда не был
 * связан с ключом, и угадывать, кто за ним стоял, значило бы раздать чужие
 * серверы. Поэтому унаследованные записи продолжают жить по старому правилу,
 * пока живы, а всё созданное начиная с 1.0 знает своего хозяина по-настоящему.
 * Поверх обоих — владелец инсталляции, который может и то и другое.
 *
 * Внешнего ключа нет намеренно: сервер инсталляции не должен исчезать или
 * запирать своё удаление из-за того, что личность его создателя перестала
 * существовать. Ровно как у автора реплики в `messages`.
 */
export class CreatorIdentity1757000000000 implements MigrationInterface {
  name = 'CreatorIdentity1757000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "servers" ADD "creator_identity_id" uuid`);
    await q.query(`ALTER TABLE "channels" ADD "creator_identity_id" uuid`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "channels" DROP COLUMN "creator_identity_id"`);
    await q.query(`ALTER TABLE "servers" DROP COLUMN "creator_identity_id"`);
  }
}
