import { NextResponse, type NextRequest } from 'next/server';
import { AUTH_COOKIE, verifyToken } from '@relay/shared';

/**
 * Гейт доступа (план §7). Без валидной куки relay_pass — редирект на /login.
 * Проверка HMAC — полноценная (verifyToken из @relay/shared, Web Crypto, Edge-safe),
 * а не «по наличию куки»; источник истины по доступу — серверный (тот же пароль).
 * Пустой SITE_PASSWORD = авторизация выключена → пускаем всех.
 *
 * /api и /uploads гейтит сам Nest (отвечает 401 JSON) — сюда не попадают.
 * Статику (_next, /img, /sound, *.svg/.mp3) НЕ трогаем, иначе не загрузится
 * сама страница логина (её ассеты).
 */
export async function middleware(req: NextRequest) {
  const password = process.env.SITE_PASSWORD ?? '';
  const ok = await verifyToken(req.cookies.get(AUTH_COOKIE)?.value, password);
  const isLogin = req.nextUrl.pathname === '/login';

  if (isLogin) {
    // Уже авторизован — на странице логина нечего делать, на главную.
    return ok ? NextResponse.redirect(new URL('/', req.url)) : NextResponse.next();
  }
  if (ok) return NextResponse.next();
  return NextResponse.redirect(new URL('/login', req.url));
}

export const config = {
  // Пропускаем без проверки: api/*, uploads/* (гейтит Nest), invite/* (гостевой
  // вход — токен проверяет сама страница), внутренние пути Next (_next/*) и
  // любую статику с расширением (точка в пути) — ассеты логина.
  matcher: ['/((?!api/|uploads/|invite/|_next/|.*\\.).*)'],
};
