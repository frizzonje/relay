import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { AUTH_COOKIE, authEnabled, issueToken, passwordMatches } from './auth';

// Защита от подбора: на IP — не больше MAX_ATTEMPTS неудач за окно
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;

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

  private isRateLimited(ip: string): boolean {
    const entry = this.attempts.get(ip);
    if (!entry) return false;
    if (Date.now() > entry.resetAt) {
      this.attempts.delete(ip);
      return false;
    }
    return entry.count >= MAX_ATTEMPTS;
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
