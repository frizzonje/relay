import { NextResponse, type NextRequest } from 'next/server';
import { AUTH_COOKIE, verifyToken } from '@relay/shared';

/**
 * Гейт доступа (план §7). Без пропуска relay_pass — редирект на /login.
 *
 * Проверка подписи здесь — полноценная (verifyToken из @relay/shared, Web
 * Crypto, Edge-safe), но с этапа C она перестала быть последним словом, и вот
 * почему. Пароль инсталляции может жить не в `SITE_PASSWORD`, а в таблице
 * настроек — владелец задаёт его из панели, и наружу оттуда уходит только хэш.
 * Ключа от такой подписи у фронта нет и быть не может: базы он не видит.
 *
 * Поэтому дверь тут решает ровно то, что решаемо без ключа:
 *
 *   - подпись сошлась (или пароля нет вовсе) — пускаем, как и раньше;
 *   - подпись не сошлась, но пропуск есть и не просрочен — пускаем и оставляем
 *     решение api: он ответит 401, а клиент покажет экран «ворота» с кнопкой на
 *     /login (см. lib/identity-login.ts, IdentityGate). Иначе инсталляция,
 *     сменившая пароль из панели, встала бы намертво: свежая кука здесь не
 *     проверяется, и человек ходил бы по кругу /login → / → /login;
 *   - пропуска нет или он просрочен — на /login, как и до панели.
 *
 * Источник истины по доступу серверный и остаётся им: api гейтит /api и
 * /uploads сам (401 JSON), сокет проверяет пропуск на handshake. Здесь — только
 * то, куда отправить браузер.
 *
 * Статику (_next, /img, /sound, *.svg/.mp3) НЕ трогаем, иначе не загрузится
 * сама страница логина (её ассеты).
 */
export async function middleware(req: NextRequest) {
  const password = process.env.SITE_PASSWORD ?? '';
  const token = req.cookies.get(AUTH_COOKIE)?.value;
  const ok = await verifyToken(token, password);
  const isLogin = req.nextUrl.pathname === '/login';

  if (isLogin) {
    // Уже авторизован — на странице логина нечего делать, на главную. Здесь
    // только сошедшаяся подпись: ошибись мы в другую сторону, человек с чужой
    // (или подписанной новым паролем) кукой не попал бы на страницу входа.
    return ok ? NextResponse.redirect(new URL('/', req.url)) : NextResponse.next();
  }
  if (ok || unexpired(token)) return NextResponse.next();
  return NextResponse.redirect(new URL('/login', req.url));
}

/**
 * Пропуск на руках и ещё не просрочен. Срок лежит в самом токене открыто
 * (`<exp>.<подпись>`), и прочесть его можно без ключа — а больше здесь ничего
 * и не проверяется: годность подписи — вопрос к api.
 */
function unexpired(token: string | undefined): boolean {
  const dot = token ? token.indexOf('.') : -1;
  if (dot < 0) return false;
  const exp = Number(token!.slice(0, dot));
  return Number.isFinite(exp) && exp > Date.now();
}

export const config = {
  // Пропускаем без проверки: api/*, uploads/* (гейтит Nest), invite/* (гостевой
  // вход — токен проверяет сама страница), внутренние пути Next (_next/*) и
  // любую статику с расширением (точка в пути) — ассеты логина.
  matcher: ['/((?!api/|uploads/|invite/|_next/|.*\\.).*)'],
};
