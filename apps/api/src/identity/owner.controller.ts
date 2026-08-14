import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { IdentityService } from './identity.service';
import { OwnerService, type ClaimFailure } from './owner.service';
import { requireIdentity } from './session-guard';

/**
 * Владелец инсталляции.
 *
 *   GET  /api/identity/owner          → { owner: boolean }
 *   POST /api/identity/owner/claim    { token } — взять власть по ссылке
 *
 * Оба — за своей сессией: ключ владельца привязывается к личности, а личность
 * берётся из куки, а не из тела запроса. Это и делает ссылку безопасной ровно
 * настолько, насколько безопасен терминал, на котором её напечатали: открывший
 * её становится владельцем сам, назначить владельцем другого ею нельзя.
 */
@Controller('api/identity')
export class OwnerController {
  constructor(
    private readonly identity: IdentityService,
    private readonly owner: OwnerService,
  ) {}

  @Get('owner')
  async mine(@Req() req: Request, @Res() res: Response) {
    const me = await requireIdentity(this.identity, req, res);
    if (!me) return;
    res.json({ owner: await this.owner.isOwner(me.identity.id) });
  }

  @Post('owner/claim')
  async claim(@Req() req: Request, @Res() res: Response, @Body() body: { token?: unknown }) {
    const me = await requireIdentity(this.identity, req, res);
    if (!me) return;
    const done = await this.owner.claim(body?.token, me.identity.id);
    if (!done.ok) {
      res.status(status(done.reason)).json({ error: done.reason });
      return;
    }
    res.json({ ok: true });
  }
}

/**
 * Отказ → код ответа. Три разных: человеку надо сказать не «не вышло», а что
 * именно с его ссылкой — от этого зависит, идти ли ему за новой.
 */
function status(reason: ClaimFailure): number {
  if (reason === 'used') return 409;
  // Gone — ровно про это: ссылка была настоящей и больше не действует.
  if (reason === 'expired') return 410;
  return 400;
}
