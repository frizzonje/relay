import { Body, Controller, Logger, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { SettingsService } from '../settings/settings.service';
import { authEnabled, issueToken, passwordMatches } from './auth';
import { requestNetwork } from '../client-address';
import { WindowCounter } from '../window-counter';
import { AUTH_COOKIE } from '@relay/shared';

// Защита от подбора: на IP — не больше `access.unlockAttempts` неудач за окно.
// Число то же самое, что у пароля закрытого сервера (gateway/unlock.ts), и
// настройка у них одна на двоих: «сколько раз можно ошибиться паролем» — один
// вопрос, и два разных ответа на него в одной инсталляции означали бы, что одна
// из двух дверей настройке не подчиняется.
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

/**
 * Окно второго счётчика — того, что считает ПОПЫТКИ, а не неудачи
 * (`access.loginRatePerMinute`). Минута, потому что настройка названа «в
 * минуту»: считай мы за десять, поле обещало бы одно, а делало другое.
 *
 * Счётчиков два, и это не дублирование. Первый спрашивает «сколько раз здесь
 * ошиблись паролем» и молчит, пока пароль верен, — им ловят подбор. Второй
 * спрашивает «сколько раз отсюда вообще стучали» и не смотрит на исход — им
 * ужимают поток запросов к двери. Умолчание второго — ноль, то есть его нет:
 * сегодня попытки в минуту не считает никто, и настройка, включённая сама
 * собой, заперла бы общий выход в интернет, за которым сидит десяток людей.
 */
const RATE_WINDOW_MS = 60 * 1000;

// Страница логина теперь во фронте (apps/web/app/login/page.tsx) и постит сюда.
// Nest отдаёт только POST /api/login (rate-limit + выдача HMAC-куки); редирект
// неавторизованных на /login делает middleware Next (verifyToken из @relay/shared).
@Controller()
export class AuthController {
  private readonly failures = new WindowCounter(ATTEMPT_WINDOW_MS);
  /** Попытки за минуту — отдельный счёт: у него своё окно и свой смысл. */
  private readonly rate = new WindowCounter(RATE_WINDOW_MS);
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly settings: SettingsService) {}

  /**
   * Проверка пароля ждёт ответа: пароль, заданный из панели, лежит хэшем, и
   * сверить его стоит одного scrypt. Дорого это НАМЕРЕННО, и обоюдоострость
   * такой цены снимают оба счётчика выше (неудачи за десять минут и попытки за
   * минуту) вместе с семафором в `gateway/unlock.ts`, через который проходят
   * все проверки паролей инсталляции.
   */
  @Post('api/login')
  async login(@Req() req: Request, @Res() res: Response, @Body() body: { password?: unknown }) {
    if (!authEnabled()) {
      res.json({ ok: true });
      return;
    }

    const ip = requestNetwork(req);
    if (this.isRateLimited(ip)) {
      res.status(429).json({ error: 'too many attempts' });
      return;
    }
    // Поток запросов к двери. Считается ДО проверки пароля и независимо от неё:
    // верный пароль, повторённый триста раз в минуту, — это тоже не человек.
    // Тело отказа своё: снаружи оба ответа 429, но в логе и в тесте их надо
    // различать, иначе «подождите минуту» не отличить от «вы перебрали пароль».
    if (this.tooFast(ip)) {
      this.logger.warn(`вход: с ${ip} стучат чаще, чем разрешено настройкой`);
      res.status(429).json({ error: 'too fast' });
      return;
    }

    const password = typeof body?.password === 'string' ? body.password : '';
    // Попытка записывается неудачей ДО сверки, той же синхронной частью, что и
    // проверка простоя выше, — успех её снимет. Запиши мы неудачу по ответу,
    // пачка запросов, посланных разом, прошла бы проверку простоя вся.
    this.failures.hit(ip);
    if (!password || !(await passwordMatches(password))) {
      res.status(401).json({ error: 'invalid password' });
      return;
    }

    this.failures.clear(ip);
    const token = issueToken();
    res.cookie(AUTH_COOKIE, token.value, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: token.maxAgeMs,
      path: '/',
    });
    res.json({ ok: true });
  }

  // Выход из аккаунта (модалка настроек фронта): чистим HMAC-куку, дальше
  // middleware Next редиректит на /login. Всегда 200 — идемпотентно.
  @Post('api/logout')
  logout(@Res() res: Response) {
    res.clearCookie(AUTH_COOKIE, { path: '/' });
    res.json({ ok: true });
  }

  /**
   * Столько ли попыток в минуту, сколько разрешено. Ноль — без предела, и это
   * умолчание: счётчик попыток появился здесь вместе с настройкой, а пока
   * настройка не тронута, он не считает ничего.
   */
  private tooFast(ip: string): boolean {
    const perMinute = this.settings.get<number>('access.loginRatePerMinute');
    if (perMinute <= 0) return false;
    return this.rate.hit(ip) > perMinute;
  }

  private isRateLimited(ip: string): boolean {
    return this.failures.count(ip) >= this.settings.get<number>('access.unlockAttempts');
  }
}
