import 'reflect-metadata';
import { readFileSync, existsSync } from 'fs';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Request, Response, NextFunction } from 'express';
import { AppModule } from './app.module';
import { authEnabled, hasValidGuestBearer, isAuthorized } from './auth/auth';
import { UPLOAD_DIR } from './uploads';

// Гейт перед /uploads и API: без пропуска отдаём только POST /api/login
// (иначе войти было бы невозможно). Фронт и его статику раздаёт Next, а
// редирект неавторизованных на /login делает middleware Next — здесь 401 JSON.
function authGate(req: Request, res: Response, next: NextFunction) {
  if (!authEnabled()) return next();
  // /api/health публичен: по нему стоят docker healthcheck и внешний мониторинг,
  // и оба обязаны работать без куки. Содержимое — только «жив ли процесс»,
  // ничего об инсталляции (см. health.controller.ts).
  if (req.path === '/api/login' || req.path === '/api/health') return next();
  if (isAuthorized(req)) return next();
  // Гость по инвайту: без ICE-конфига (TURN) его звонок не соберётся за строгим
  // NAT. Только этот путь — остальное API гостю не положено.
  if (req.path === '/api/config' && hasValidGuestBearer(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

/**
 * Загрузки — плоская витрина: одно имя файла, сгенерированное multer'ом, и
 * ничего глубже. Проверка не про удобство, а про то, что на ЭТОМ ЖЕ томе живёт
 * состояние сервиса: DATA_DIR по умолчанию (и в обоих compose) — подпапка
 * uploads, а в ней registry.json с хэшами паролей закрытых серверов и полным
 * списком их каналов. Статика отдала бы его по прямой ссылке любому участнику
 * с пропуском — сокет при этом честно скрывает те же каналы, и дыра выглядит
 * как «пароль есть, а секрета нет». Режем путь ДО express.static: вложенных
 * путей у загрузок не бывает ни одного.
 */
function flatUploadsOnly(req: Request, res: Response, next: NextFunction) {
  let name: string;
  try {
    // Декодируем сами: express.static раскроет %2f уже после нас, и «плоское»
    // имя вида `state%2fregistry.json` иначе прошло бы проверку насквозь.
    name = decodeURIComponent(req.path).replace(/^\/+/, '');
  } catch {
    res.status(400).json({ error: 'bad path' });
    return;
  }
  if (!name || name.startsWith('.') || /[\\/]/.test(name)) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  next();
}

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
    // Защита от хранимого XSS: инлайн в браузере отдаём только заведомо
    // безопасные картинки и mp3 (их рисует чат). Всё прочее — .svg/.html/.js и
    // т.п., что могло бы выполнить скрипт в нашем origin, — форсим на скачивание.
    // nosniff не даёт браузеру угадать тип в обход заголовка.
    setHeaders: (res, filePath) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const inlineOk = /\.(png|jpe?g|gif|webp|mp3)$/i.test(filePath);
      if (!inlineOk) res.setHeader('Content-Disposition', 'attachment');
    },
  });
  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  const proto = httpsOptions ? 'https' : 'http';
  console.log(`Listening on ${proto}://localhost:${port}`);
}

bootstrap();
