import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { cpus } from 'node:os';
import * as mediasoup from 'mediasoup';
import type { types } from 'mediasoup';
import { rtcPortCount, rtcPortRange, webRtcServerOptions, workerSettings } from './media.config';

/** Воркер и его WebRtcServer — на нём живут все транспорты комнат воркера. */
export interface WorkerSlot {
  worker: types.Worker;
  webRtcServer: types.WebRtcServer;
}

/**
 * Пул mediasoup-воркеров. Воркер — отдельный C++-процесс, он однопоточный, так
 * что параллелизм даёт только их количество: заводим по числу ядер и раздаём
 * комнатам по кругу (комната целиком живёт в одном воркере — роутер не умеет
 * пересекать процессы).
 *
 * У каждого воркера свой WebRtcServer на одном порту, UDP и TCP: первый
 * свободный по порядку от `SFU_RTC_MIN_PORT`. Поэтому воркеров не больше, чем
 * портов в диапазоне.
 */
@Injectable()
export class WorkersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkersService.name);
  private readonly slots: WorkerSlot[] = [];
  private next = 0;

  async onModuleInit(): Promise<void> {
    const { count, asked } = this.workerCount();
    const { min, max } = rtcPortRange();
    const ports: number[] = [];
    let from = min;
    for (let i = 0; i < count; i++) {
      const worker = await mediasoup.createWorker(workerSettings());
      // Смерть воркера — это потеря всех комнат в нём, и починить это изнутри
      // нельзя: молча деградировать хуже, чем упасть и дать рестартнуть себя
      // рантайму compose (restart: unless-stopped).
      worker.on('died', () => {
        this.logger.error(`mediasoup worker ${worker.pid} died — exiting`);
        process.exit(1);
      });
      const bound = await this.listen(worker, from, max);
      if (!bound) {
        worker.close();
        const why = `no free RTC port left in ${min}-${max} for worker ${i + 1} of ${count}`;
        // Явная просьба или ни одного воркера — отказ; число по ядрам — урезаем.
        if (asked || !this.slots.length) {
          throw new Error(`${why}. Free the ports or widen the range.`);
        }
        this.logger.warn(`${why}: starting ${this.slots.length} worker(s).`);
        break;
      }
      this.slots.push({ worker, webRtcServer: bound.webRtcServer });
      ports.push(bound.port);
      from = bound.port + 1;
    }
    this.logger.log(
      `mediasoup: ${this.slots.length} worker(s), RTC port(s) ${ports.join(', ')} (UDP+TCP, one per worker)`,
    );
  }

  /**
   * WebRtcServer на первом свободном порту от `from` до `max`; null — свободных
   * нет. Порт из диапазона может держать чужой процесс: диапазон пересекается с
   * эфемерными портами Linux (32768–60999), и их берут исходящие соединения.
   * Раньше mediasoup сам обходил занятые порты; с фиксированным номером на
   * воркер одна случайная занятость роняла бы SFU целиком. Любая другая ошибка
   * — не про занятость, её не обходим.
   */
  private async listen(
    worker: types.Worker,
    from: number,
    max: number,
  ): Promise<{ webRtcServer: types.WebRtcServer; port: number } | null> {
    for (let port = from; port <= max; port++) {
      try {
        return { webRtcServer: await worker.createWebRtcServer(webRtcServerOptions(port)), port };
      } catch (err) {
        if (!/address already in use/i.test(err instanceof Error ? err.message : String(err))) {
          throw err;
        }
        this.logger.warn(`RTC port ${port} is taken by another process — skipping it`);
      }
    }
    return null;
  }

  async onModuleDestroy(): Promise<void> {
    for (const { worker } of this.slots) worker.close();
  }

  /** Следующий воркер по кругу — для новой комнаты. */
  take(): WorkerSlot {
    const slot = this.slots[this.next % this.slots.length];
    this.next++;
    return slot;
  }

  /**
   * Сколько воркеров заводить. Явный `SFU_WORKERS` — просьба человека: не
   * влезает в диапазон портов — отказ на старте, молча дать меньше хуже
   * рестарта. Число по ядрам — наше умолчание: на машине, где ядер больше, чем
   * портов, оно урезается до портов с предупреждением, а не роняет SFU, который
   * вчера работал.
   */
  private workerCount(): { count: number; asked: boolean } {
    const ports = rtcPortCount();
    const { min, max } = rtcPortRange();
    if (ports < 1) {
      throw new Error(
        `SFU_RTC_MAX_PORT (${max}) is below SFU_RTC_MIN_PORT (${min}): no port for any worker`,
      );
    }
    const asked = Math.floor(Number(process.env.SFU_WORKERS ?? ''));
    if (Number.isFinite(asked) && asked >= 1) {
      if (asked > ports) {
        throw new Error(
          `SFU_WORKERS=${asked}, but SFU_RTC_MIN_PORT-SFU_RTC_MAX_PORT (${min}-${max}) holds only ${ports} port(s), one per worker. Widen the range or lower SFU_WORKERS.`,
        );
      }
      return { count: asked, asked: true };
    }
    const cores = Math.max(1, cpus().length);
    if (cores > ports) {
      this.logger.warn(
        `${cores} cores but only ${ports} RTC port(s) in ${min}-${max}: starting ${ports} worker(s). Widen SFU_RTC_MIN_PORT-SFU_RTC_MAX_PORT to use every core.`,
      );
      return { count: ports, asked: false };
    }
    return { count: cores, asked: false };
  }
}
