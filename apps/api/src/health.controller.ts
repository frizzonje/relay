import { Controller, Get } from '@nestjs/common';

/**
 * Публичный health: только «жив ли процесс». Ни версии, ни данных об
 * инсталляции — наружу смотрят и docker healthcheck, и внешний мониторинг,
 * и посторонний (план 1.0, слой 4: «без версии — незачем раздавать номер
 * сборки всем подряд»).
 *
 * Зависший цикл событий — ровно то, что `restart: unless-stopped` не лечит:
 * процесс жив, но не отвечает, и обычного 200 достаточно, чтобы такой
 * контейнер был перезапущен по healthcheck (audit S7).
 */
@Controller('api')
export class HealthController {
  @Get('health')
  health(): { ok: true } {
    return { ok: true };
  }
}
