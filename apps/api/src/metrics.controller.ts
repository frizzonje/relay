import { Controller, Get, Header } from '@nestjs/common';
import type { MetricsResponse } from '@relay/shared';
import { MetricsService } from './metrics';

/**
 * Состояние машины для главного экрана. За общим гейтом пропуска (`authGate` в
 * main.ts пускает без куки только на `POST /api/login`) — сколько на сервере
 * памяти и насколько забит диск постороннему знать неоткуда.
 */
@Controller('api')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  // Кэш здесь врал бы по определению: цифры живые, и промежуточный прокси не
  // должен подсовывать вчерашние.
  @Header('Cache-Control', 'no-store')
  read(): Promise<MetricsResponse> {
    return this.metrics.read();
  }
}
