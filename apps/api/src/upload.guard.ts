import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * Лимит на `POST /api/upload` — единственный публичный POST, который пишет на
 * диск. 25 МБ на файл его не ограничивают никак: файлов можно послать сколько
 * угодно и как угодно быстро.
 *
 * Считаем БАЙТЫ, а не запросы, и списываем их ПОСЛЕ записи файла, по его
 * настоящему размеру. Content-Length для этого не годится — его пишет клиент, и
 * бюджет, который верит клиенту, обходится одной строкой заголовка. Плата за
 * такой порядок: первый запрос всегда проходит (не больше 25 МБ, потолок на
 * файл), а отказ приходит следующему. Для защиты диска этого достаточно.
 */

// Всплеск: примерно дюжина файлов предельного размера или сотни скриншотов
// подряд — столько бывает у живого человека, разгружающего папку в чат.
const BURST_BYTES = 300 * 1024 ** 2;
// Долгий темп. 100 МиБ/мин упираются в подметание и квоту каталога задолго до
// того, как успеют что-то вытеснить.
const REFILL_BYTES_PER_SEC = (100 * 1024 ** 2) / 60;
// Чтобы карта не росла на каждый заглянувший адрес.
const MAX_TRACKED = 5000;

interface Budget {
  tokens: number;
  ts: number;
}

export class UploadByteBudget {
  private readonly budgets = new Map<string, Budget>();

  constructor(
    private readonly capacity = BURST_BYTES,
    private readonly refillPerSec = REFILL_BYTES_PER_SEC,
  ) {}

  private refill(key: string, now: number): Budget {
    const b = this.budgets.get(key) ?? { tokens: this.capacity, ts: now };
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.ts) / 1000) * this.refillPerSec);
    b.ts = now;
    this.budgets.set(key, b);
    return b;
  }

  /** Есть ли ещё бюджет. Сам по себе ничего не списывает. */
  allow(key: string, now = Date.now()): boolean {
    if (this.budgets.size > MAX_TRACKED) this.forgetFull(now);
    return this.refill(key, now).tokens > 0;
  }

  /** Списать настоящий размер записанного файла. */
  charge(key: string, bytes: number, now = Date.now()): void {
    const b = this.refill(key, now);
    // В минус уходить разрешаем — но не глубже, чем на один всплеск: иначе один
    // предельный файл при крошечном потолке запирал бы адрес на часы.
    b.tokens = Math.max(-this.capacity, b.tokens - bytes);
  }

  // Полный бюджет — это «как будто и не приходил»: такие записи можно забыть.
  private forgetFull(now: number): void {
    for (const [key, b] of this.budgets) {
      if (b.tokens + ((now - b.ts) / 1000) * this.refillPerSec >= this.capacity) {
        this.budgets.delete(key);
      }
    }
  }
}

// Один на процесс: гард Nest создаёт сам, и состояние не должно зависеть от
// того, сколько раз он это сделает.
export const uploadBudget = new UploadByteBudget();

@Injectable()
export class UploadRateGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    // `trust proxy: 1` (main.ts) — req.ip это адрес, который подставил наш
    // Caddy, а не то, что клиент написал в X-Forwarded-For.
    if (uploadBudget.allow(req.ip ?? 'unknown')) return true;
    throw new HttpException('too many uploads', HttpStatus.TOO_MANY_REQUESTS);
  }
}
