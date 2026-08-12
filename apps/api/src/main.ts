import 'reflect-metadata';
import { readFileSync, existsSync } from 'fs';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { DataSource } from 'typeorm';
import { AppModule } from './app.module';
import { authEnabled } from './auth/auth';
import {
  NO_DATABASE_URL,
  connectWithRetry,
  createDataSource,
  databaseUrl,
  explainDbFailure,
} from './db/data-source';
import { authGate, flatUploadsOnly, uploadStaticHeaders } from './http-gate';
import { UPLOAD_DIR } from './uploads';

/**
 * Отказ, из которого понятно, что делать руками. Рамка не украшение: в логе
 * контейнера, который перезапускается каждые полминуты, единственная полезная
 * строка обязана быть видна с расстояния.
 */
function die(reason: string): never {
  console.error('\n' + '─'.repeat(72));
  console.error('relay api не может стартовать.\n');
  console.error('  ' + reason);
  console.error('─'.repeat(72) + '\n');
  process.exit(1);
}

/**
 * База — до всего остального. Повторы здесь не от недоверия к compose, а
 * потому что порядок запуска гарантирован не всегда: `docker compose up api`
 * руками, откат, обновление. Десяток секунд ожидания дешевле рестарт-лупа.
 */
async function openDatabase(): Promise<DataSource> {
  const url = databaseUrl();
  if (!url) die(NO_DATABASE_URL);

  const db = createDataSource(url);
  try {
    await connectWithRetry(db, {
      onRetry: (attempt, delay, reason) =>
        console.warn(`База ещё не отвечает (попытка ${attempt}): ${reason}. Повтор через ${delay} мс`),
    });
  } catch (e) {
    die(explainDbFailure(e));
  }

  try {
    const applied = await db.runMigrations();
    if (applied.length) {
      console.log(`Схема обновлена: ${applied.map((m) => m.name).join(', ')}`);
    }
  } catch (e) {
    die(
      'Миграция схемы не прошла — база осталась в прежнем виде.\n' +
        '  Это не лечится перезапуском: посмотрите ошибку и, если инсталляция\n' +
        '  обновлялась, восстановитесь из бэкапа (`relay restore`).\n' +
        `  Исходная ошибка: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return db;
}

async function bootstrap() {
  const db = await openDatabase();
  const certPath = process.env.TLS_CERT;
  const keyPath = process.env.TLS_KEY;
  const httpsOptions =
    certPath && keyPath && existsSync(certPath) && existsSync(keyPath)
      ? { cert: readFileSync(certPath), key: readFileSync(keyPath) }
      : undefined;

  const app = await NestFactory.create<NestExpressApplication>(AppModule.withDatabase(db), {
    httpsOptions,
  });
  // За реверс-прокси доверяем РОВНО одному хопу (Caddy). `true` (доверять всей
  // цепочке) опасен: клиент мог бы подставить произвольный X-Forwarded-For, и
  // тогда req.ip — спуфится, а rate-limit логина (ключ по IP) обходится в лоб.
  // С `1` Express берёт адрес, добавленный нашим прокси, а не клиентский.
  app.set('trust proxy', 1);
  // CORS нужен только в dev, когда web (Next, :3001) и api (Nest, :3000) на разных
  // origin. В проде всё за Caddy единым origin — CORS_ORIGIN не задаём, заголовки
  // не добавляются. Список origin'ов — через запятую; с куками (credentials).
  const corsOrigin = process.env.CORS_ORIGIN;
  if (corsOrigin) {
    app.enableCors({
      origin: corsOrigin.split(',').map((o) => o.trim()),
      credentials: true,
    });
  }
  if (!authEnabled()) {
    console.warn(
      '⚠️  SITE_PASSWORD не задан — сайт открыт без авторизации. ' +
        'Задайте SITE_PASSWORD в .env для закрытого доступа.',
    );
  }
  app.use(authGate);
  app.use('/uploads', flatUploadsOnly);
  // Загруженные в чат файлы отдаёт Nest за гейтом; остальную статику (фронт)
  // теперь раздаёт Next за обратным прокси Caddy — здесь её больше нет.
  app.useStaticAssets(UPLOAD_DIR, {
    prefix: '/uploads',
    setHeaders: uploadStaticHeaders,
  });
  // Контейнер останавливают сигналом: соединения к базе закрываем сами, иначе
  // на медленной машине Postgres переживает наш уход с полудюжиной висящих
  // сессий и ждёт таймаута, чтобы их прибрать.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void app
        .close()
        .catch(() => undefined)
        .then(() => db.destroy())
        .catch(() => undefined)
        .then(() => process.exit(0));
    });
  }

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  const proto = httpsOptions ? 'https' : 'http';
  console.log(`Listening on ${proto}://localhost:${port}`);
}

bootstrap();
