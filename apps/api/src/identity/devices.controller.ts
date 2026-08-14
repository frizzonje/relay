import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { SignalingGateway } from '../gateway/signaling.gateway';
import { IdentityService } from './identity.service';
import { PairingService, type PairFailure } from './pairing.service';
import { requireIdentity } from './session-guard';

/**
 * Устройства личности и связка новых.
 *
 *   GET  /api/identity/devices          → все свои устройства
 *   POST /api/identity/devices/revoke   { deviceId }
 *   POST /api/identity/pair/ask                        → { code } (просит новичок)
 *   GET  /api/identity/pair/:code       → { publicKey, fingerprint, … } (смотрит донор)
 *   POST /api/identity/pair/confirm     { code, signature }        (впускает донор)
 *
 * Всё — только за своей сессией: чужих устройств тут не видно и трогать их
 * нечем. Отдельный контроллер от входа не по объёму, а по смыслу: там человек
 * доказывает, кто он, здесь — распоряжается тем, что уже доказано.
 */
@Controller('api/identity')
export class DevicesController {
  constructor(
    private readonly identity: IdentityService,
    private readonly pairing: PairingService,
    private readonly gateway: SignalingGateway,
  ) {}

  @Get('devices')
  async list(@Req() req: Request, @Res() res: Response) {
    const me = await this.me(req, res);
    if (!me) return;
    res.json({ devices: await this.identity.devices(me.identity.id, me.device.id) });
  }

  @Post('devices/revoke')
  async revoke(@Req() req: Request, @Res() res: Response, @Body() body: { deviceId?: unknown }) {
    const me = await this.me(req, res);
    if (!me) return;

    const result = await this.identity.revoke(me.identity.id, body?.deviceId, me.device.id);
    if (result !== 'ok') {
      // «Своё текущее» и «такого нет» — разные отказы: первый человеку надо
      // объяснить, второй означает, что список у него устарел.
      res.status(result === 'current' ? 409 : 404).json({ error: result });
      return;
    }

    // Отзыв обязан действовать сразу, а не со следующего входа: живой сокет
    // отозванного устройства продолжал бы говорить в каналы часами.
    this.gateway.dropDevice(String(body?.deviceId));
    res.json({ ok: true });
  }

  @Post('pair/ask')
  async ask(@Req() req: Request, @Res() res: Response) {
    const me = await this.me(req, res);
    if (!me) return;
    const asked = await this.pairing.ask(me.device);
    if (!asked.ok) {
      res.status(status(asked.reason)).json({ error: asked.reason });
      return;
    }
    res.json({ code: asked.code, expiresIn: asked.expiresIn });
  }

  @Get('pair/:code')
  async look(@Req() req: Request, @Res() res: Response, @Param('code') code: string) {
    const me = await this.me(req, res);
    if (!me) return;
    const found = this.pairing.look(code, me.identity.id);
    if (!found.ok) {
      res.status(status(found.reason)).json({ error: found.reason });
      return;
    }
    res.json(found.view);
  }

  @Post('pair/confirm')
  async confirm(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: { code?: unknown; signature?: unknown },
  ) {
    const me = await this.me(req, res);
    if (!me) return;
    const done = await this.pairing.confirm(body?.code, me.device, body?.signature);
    if (!done.ok) {
      res.status(status(done.reason)).json({ error: done.reason });
      return;
    }
    res.json({ ok: true, deviceId: done.deviceId });
  }

  /** Кто спрашивает. `null` — ответ уже отправлен, см. `requireIdentity`. */
  private me(req: Request, res: Response) {
    return requireIdentity(this.identity, req, res);
  }
}

/**
 * Отказ → код ответа. Перебор отдаётся 429, а не 400: это не «вы ошиблись», а
 * «подождите», и клиент обязан различать их без чтения тела.
 */
function status(reason: PairFailure): number {
  return reason === 'too-many' ? 429 : 400;
}
