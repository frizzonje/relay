import { Controller, Get } from '@nestjs/common';

/**
 * Живость сервиса — для healthcheck в compose и для api, который так может
 * узнать, стоит ли вообще предлагать SFU-режим. Ничего приватного не отдаём:
 * медиасервер стоит за тем же Caddy, но авторизации у него нет.
 */
@Controller()
export class HealthController {
  @Get('health')
  health(): { ok: true } {
    return { ok: true };
  }
}
