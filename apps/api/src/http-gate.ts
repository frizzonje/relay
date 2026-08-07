import type { NextFunction, Request, Response } from 'express';
import { authEnabled, hasValidGuestBearer, isAuthorized } from './auth/auth';

/**
 * Две миддлвары, стоящие перед всем остальным http api. Живут отдельно от
 * main.ts потому, что main.ts — это точка входа: он поднимает Nest и слушает
 * порт прямо при импорте, а эти две функции обязаны проверяться сами по себе.
 */

// Гейт перед /uploads и API: без пропуска отдаём только POST /api/login
// (иначе войти было бы невозможно). Фронт и его статику раздаёт Next, а
// редирект неавторизованных на /login делает middleware Next — здесь 401 JSON.
export function authGate(req: Request, res: Response, next: NextFunction) {
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
export function flatUploadsOnly(req: Request, res: Response, next: NextFunction) {
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

/**
 * Заголовки статики загрузок. Защита от хранимого XSS: инлайн в браузере
 * отдаём только заведомо безопасные картинки и mp3 (их рисует чат). Всё прочее
 * — .svg/.html/.js и т.п., что могло бы выполнить скрипт в нашем origin, —
 * форсим на скачивание. nosniff не даёт браузеру угадать тип в обход заголовка.
 */
export function uploadStaticHeaders(res: { setHeader(k: string, v: string): void }, path: string) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const inlineOk = /\.(png|jpe?g|gif|webp|mp3)$/i.test(path);
  if (!inlineOk) res.setHeader('Content-Disposition', 'attachment');
}
