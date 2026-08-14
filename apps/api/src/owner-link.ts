import { Logger } from '@nestjs/common';
import { NO_DATABASE_URL, connectWithRetry, createDataSource, databaseUrl } from './db/data-source';
import { OwnerService } from './identity/owner.service';

/**
 * Приглашение во владельцы, выпущенное снаружи приложения.
 *
 * Запускается не как сервис, а разово — `docker compose run --rm api node
 * dist/owner-link.js` из `relay owner-link`, а тот, в свою очередь, зовётся ещё
 * и установщиком. Один выпускающий на всё: и первая ссылка при установке, и
 * та, которой хозяин машины возвращает себе власть через год, рождаются одним
 * и тем же кодом.
 *
 * В stdout уходит РОВНО ключ и ничего больше: его читает шелл. Всё остальное —
 * в stderr. Адрес инсталляции здесь не знают и не выдумывают: TLS-режим и имя
 * хоста лежат в `.env`, ссылку из них собирает CLI.
 */
async function main(): Promise<void> {
  // Логгер Nest пишет в stdout, а stdout здесь — канал данных, а не место для
  // рассказа о себе. Одна лишняя строка в нём — и шелл соберёт ссылку из неё.
  Logger.overrideLogger(false);

  const url = databaseUrl();
  if (!url) {
    console.error(NO_DATABASE_URL);
    process.exit(1);
  }

  const db = createDataSource(url);
  try {
    // Повторов меньше, чем у сервиса: человек ждёт у терминала, а не контейнер
    // в рестарт-лупе. Но не одна попытка — `docker compose run` поднимает базу
    // одновременно с нами.
    await connectWithRetry(db, { attempts: 5 });
  } catch (e) {
    console.error(`База не отвечает: ${e instanceof Error ? e.message : String(e)}`);
    console.error('Стек не поднят? Проверьте `relay ps`.');
    process.exit(1);
  }

  try {
    const { token, expiresAt } = await new OwnerService(db).issue();
    console.error(`Ссылка действительна до ${expiresAt.toISOString()}`);
    process.stdout.write(`${token}\n`);
  } catch (e) {
    // Отдельной строкой: чаще всего это «нет таблицы», то есть api ещё ни разу
    // не стартовал и миграции не прошли. Миграции здесь не гоняем намеренно —
    // схему двигает сервис, а не вспомогательная команда.
    console.error(
      `Не удалось выпустить приглашение: ${e instanceof Error ? e.message : String(e)}`,
    );
    console.error('Если стек только что обновлён — дайте api подняться (`relay logs api`).');
    process.exit(1);
  } finally {
    await db.destroy().catch(() => undefined);
  }
}

void main();
