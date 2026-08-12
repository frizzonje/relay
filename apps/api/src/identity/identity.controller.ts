import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { parseCookies } from '../auth/auth';
import { IdentityService, type VerifyResult } from './identity.service';
import { IDENTITY_COOKIE, issueSession, readSession } from './session';

/**
 * Вход личности — два запроса и одна кука.
 *
 *   POST /api/identity/challenge  { publicKey }            → { nonce }
 *   POST /api/identity/verify     { publicKey, nonce, sig } → { identity } + кука
 *   GET  /api/identity/me                                   → { identity } | 401
 *
 * За воротами инсталляции: до них не пускает `authGate` (см. main.ts), и это
 * важно — челлендж бесплатен, а бесплатное без ворот заказывают ботами.
 *
 * Личность и ворота намеренно живут в разных куках. `relay_pass` отвечает на
 * «пустить ли на эту инсталляцию» и переживает рестарт; `relay_id` — на «кто
 * это», и его потеря чинится сама, без человека.
 */
@Controller('api/identity')
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}

  @Post('challenge')
  challenge(@Res() res: Response, @Body() body: { publicKey?: unknown }) {
    const issued = this.identity.challenge(body?.publicKey);
    if (!issued) {
      res.status(400).json({ error: 'bad key' });
      return;
    }
    res.json(issued);
  }

  @Post('verify')
  async verify(@Req() req: Request, @Res() res: Response, @Body() body: Record<string, unknown>) {
    const result = await this.identity.verify({
      publicKey: body?.publicKey,
      nonce: body?.nonce,
      signature: body?.signature,
      nick: body?.nick,
      deviceName: body?.deviceName,
    });

    if (!result.ok) {
      // 401 на всё, кроме отзыва: отозванному устройству надо сказать прямо,
      // иначе человек будет чинить сеть и пароль вместо того, чтобы связать
      // устройство заново.
      const status = result.reason === 'revoked' ? 403 : 401;
      res.status(status).json({ error: result.reason });
      return;
    }

    const session = issueSession({
      identityId: result.identity.id,
      deviceId: result.device.id,
    });
    res.cookie(IDENTITY_COOKIE, session.value, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: session.maxAgeMs,
      path: '/',
    });
    res.json(publicView(result));
  }

  @Get('me')
  async me(@Req() req: Request, @Res() res: Response) {
    const session = readSession(parseCookies(req.headers.cookie)[IDENTITY_COOKIE]);
    if (!session) {
      res.status(401).json({ error: 'no session' });
      return;
    }
    const result = await this.identity.whoIs(session.identityId, session.deviceId);
    if (!result.ok) {
      // Личности за сессией больше нет (или устройство отозвано) — куку долой,
      // иначе клиент будет предъявлять её до самого истечения срока.
      res.clearCookie(IDENTITY_COOKIE, { path: '/' });
      res.status(result.reason === 'revoked' ? 403 : 401).json({ error: result.reason });
      return;
    }
    res.json(publicView(result));
  }

  @Post('nick')
  async nick(@Req() req: Request, @Res() res: Response, @Body() body: { nick?: unknown }) {
    const session = readSession(parseCookies(req.headers.cookie)[IDENTITY_COOKIE]);
    if (!session) {
      res.status(401).json({ error: 'no session' });
      return;
    }
    const nick = await this.identity.rename(session.identityId, body?.nick);
    if (!nick) {
      res.status(400).json({ error: 'bad nick' });
      return;
    }
    res.json({ nick });
  }
}

/**
 * Что об этом человеке знает клиент. Публичный ключ и отпечаток — да: из них
 * рисуется identicon и по ним сверяются глазами. Ничего о других личностях
 * здесь нет и не будет: это ответ про себя.
 */
function publicView(result: VerifyResult & { ok: true }) {
  return {
    id: result.identity.id,
    publicKey: result.identity.publicKey,
    fingerprint: result.identity.fingerprint,
    nick: result.identity.nick,
    device: { id: result.device.id, name: result.device.name },
    created: result.created,
  };
}
