import { Body, Controller, Logger, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { SettingsService } from '../settings/settings.service';
import { AUTH_COOKIE, authEnabled, issueToken, passwordMatches } from './auth';

// Защита от подбора: на IP — не больше `access.unlockAttempts` неудач за окно.
// Число то же самое, что у пароля закрытого сервера (FREE_FAILS в
// gateway/unlock.ts), и настройка у них одна на двоих: «сколько раз можно
// ошибиться паролем» — один вопрос, и два разных ответа на него в одной
// инсталляции означали бы, что одна из двух дверей настройке не подчиняется.
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

interface AttemptEntry {
  count: number;
  resetAt: number;
}

// Страница логина теперь во фронте (apps/web/app/login/page.tsx) и постит сюда.
// Nest отдаёт только POST /api/login (rate-limit + выдача HMAC-куки); редирект
// неавторизованных на /login делает middleware Next (verifyToken из @relay/shared).
@Controller()
export class AuthController {
  private readonly attempts = new Map<string, AttemptEntry>();
  /** Попытки за минуту — отдельная карта: у неё своё окно и свой смысл. */
  private readonly rate = new Map<string, AttemptEntry>();
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly settings: SettingsService) {}

  @Post('api/login')
  login(@Req() req: Request, @Res() res: Response, @Body() body: { password?: unknown }) {
    if (!authEnabled()) {
      res.json({ ok: true });
      return;
    }

    const ip = req.ip ?? 'unknown';
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
    if (!password || !passwordMatches(password)) {
      this.recordFailure(ip);
      res.status(401).json({ error: 'invalid password' });
      return;
    }

    this.attempts.delete(ip);
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
    const now = Date.now();
    const entry = this.rate.get(ip);
    if (!entry || now > entry.resetAt) {
      this.rate.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
      // Карта чистится здесь же: своего таймера у неё нет, а без уборки она
      // росла бы на каждый новый адрес до конца жизни процесса.
      if (this.rate.size > 10000) {
        for (const [key, e] of this.rate) if (now > e.resetAt) this.rate.delete(key);
      }
      return false;
    }
    entry.count += 1;
    return entry.count > perMinute;
  }

  private isRateLimited(ip: string): boolean {
    const entry = this.attempts.get(ip);
    if (!entry) return false;
    if (Date.now() > entry.resetAt) {
      this.attempts.delete(ip);
      return false;
    }
    return entry.count >= this.settings.get<number>('access.unlockAttempts');
  }

  private recordFailure(ip: string) {
    const now = Date.now();
    const entry = this.attempts.get(ip);
    if (!entry || now > entry.resetAt) {
      this.attempts.set(ip, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    } else {
      entry.count++;
    }
    // Старые записи не копим бесконечно
    if (this.attempts.size > 10000) {
      for (const [key, e] of this.attempts) {
        if (now > e.resetAt) this.attempts.delete(key);
      }
    }
  }
}
