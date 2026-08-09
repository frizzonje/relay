import 'reflect-metadata';
import { readFileSync, existsSync } from 'fs';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { authEnabled } from './auth/auth';
import { authGate, flatUploadsOnly, uploadStaticHeaders } from './http-gate';
import { UPLOAD_DIR } from './uploads';

async function bootstrap() {
  const certPath = process.env.TLS_CERT;
  const keyPath = process.env.TLS_KEY;
  const httpsOptions =
    certPath && keyPath && existsSync(certPath) && existsSync(keyPath)
      ? { cert: readFileSync(certPath), key: readFileSync(keyPath) }
      : undefined;

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
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
  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  const proto = httpsOptions ? 'https' : 'http';
  console.log(`Listening on ${proto}://localhost:${port}`);
}

bootstrap();
