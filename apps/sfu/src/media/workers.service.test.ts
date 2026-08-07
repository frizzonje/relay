import { Logger } from '@nestjs/common';
import { cpus } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * Пул воркеров. Настоящий mediasoup.createWorker поднимает C++-процесс и
 * занимает порты — здесь подменён: проверяется НАШЕ, а именно сколько воркеров
 * заводится, как они раздаются комнатам и что смерть воркера не переживается
 * молча (потерю всех его комнат изнутри не починить, деградировать тихо хуже,
 * чем упасть и дать себя перезапустить).
 */

const createWorker = vi.hoisted(() => vi.fn());
vi.mock('mediasoup', () => ({ createWorker }));

import { WorkersService } from './workers.service';

interface FakeWorker {
  pid: number;
  closed: boolean;
  die: () => void;
}

function fakeWorker(pid: number): FakeWorker & { on: unknown; close: () => void } {
  let onDied: (() => void) | undefined;
  return {
    pid,
    closed: false,
    on(event: string, fn: () => void) {
      if (event === 'died') onDied = fn;
    },
    close() {
      this.closed = true;
    },
    die() {
      onDied?.();
    },
  };
}

let made: ReturnType<typeof fakeWorker>[];

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  made = [];
  createWorker.mockImplementation(async () => {
    const w = fakeWorker(1000 + made.length);
    made.push(w);
    return w;
  });
  delete process.env.SFU_WORKERS;
});

afterEach(() => {
  delete process.env.SFU_WORKERS;
  vi.restoreAllMocks();
});

it('по умолчанию заводит воркер на ядро — параллелизм даёт только их число', async () => {
  const s = new WorkersService();
  await s.onModuleInit();
  expect(made).toHaveLength(cpus().length);
});

it('SFU_WORKERS перекрывает число ядер', async () => {
  process.env.SFU_WORKERS = '3';
  const s = new WorkersService();
  await s.onModuleInit();
  expect(made).toHaveLength(3);
});

it('мусор и ноль в SFU_WORKERS не оставляют без воркеров', async () => {
  for (const bad of ['abc', '0', '']) {
    made = [];
    process.env.SFU_WORKERS = bad;
    await new WorkersService().onModuleInit();
    expect(made.length, bad).toBeGreaterThanOrEqual(1);
  }
});

it('воркеры получают настроенный диапазон портов', async () => {
  process.env.SFU_WORKERS = '1';
  process.env.SFU_RTC_MIN_PORT = '50000';
  process.env.SFU_RTC_MAX_PORT = '50100';
  await new WorkersService().onModuleInit();
  expect(createWorker.mock.calls[0][0]).toMatchObject({ rtcMinPort: 50000, rtcMaxPort: 50100 });
  delete process.env.SFU_RTC_MIN_PORT;
  delete process.env.SFU_RTC_MAX_PORT;
});

it('комнаты раздаются по кругу — воркер однопоточный, свалить всё в один нельзя', async () => {
  process.env.SFU_WORKERS = '2';
  const s = new WorkersService();
  await s.onModuleInit();
  expect([s.take(), s.take(), s.take()]).toEqual([made[0], made[1], made[0]]);
});

it('смерть воркера роняет процесс — чинить это изнутри нечем', async () => {
  process.env.SFU_WORKERS = '1';
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  const error = vi.spyOn(Logger.prototype, 'error');
  await new WorkersService().onModuleInit();
  made[0].die();
  expect(error.mock.calls.some((c) => String(c[0]).includes('died'))).toBe(true);
  expect(exit).toHaveBeenCalledWith(1);
});

it('остановка модуля закрывает все воркеры', async () => {
  process.env.SFU_WORKERS = '2';
  const s = new WorkersService();
  await s.onModuleInit();
  await s.onModuleDestroy();
  expect(made.every((w) => w.closed)).toBe(true);
});
