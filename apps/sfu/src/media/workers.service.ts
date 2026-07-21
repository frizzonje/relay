import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { cpus } from 'node:os';
import * as mediasoup from 'mediasoup';
import type { types } from 'mediasoup';
import { workerSettings } from './media.config';

/**
 * Пул mediasoup-воркеров. Воркер — отдельный C++-процесс, он однопоточный, так
 * что параллелизм даёт только их количество: заводим по числу ядер и раздаём
 * комнатам по кругу (комната целиком живёт в одном воркере — роутер не умеет
 * пересекать процессы).
 */
@Injectable()
export class WorkersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkersService.name);
  private readonly workers: types.Worker[] = [];
  private next = 0;

  async onModuleInit(): Promise<void> {
    const count = Math.max(1, Number(process.env.SFU_WORKERS ?? '') || cpus().length);
    const settings = workerSettings();
    for (let i = 0; i < count; i++) {
      const worker = await mediasoup.createWorker(settings);
      // Смерть воркера — это потеря всех комнат в нём, и починить это изнутри
      // нельзя: молча деградировать хуже, чем упасть и дать рестартнуть себя
      // рантайму compose (restart: unless-stopped).
      worker.on('died', () => {
        this.logger.error(`mediasoup worker ${worker.pid} died — exiting`);
        process.exit(1);
      });
      this.workers.push(worker);
    }
    this.logger.log(
      `mediasoup: ${count} worker(s), RTC ports ${settings.rtcMinPort}-${settings.rtcMaxPort}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    for (const worker of this.workers) worker.close();
  }

  /** Следующий воркер по кругу — для новой комнаты. */
  take(): types.Worker {
    const worker = this.workers[this.next % this.workers.length];
    this.next++;
    return worker;
  }
}
