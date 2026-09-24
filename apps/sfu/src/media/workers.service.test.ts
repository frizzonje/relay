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

/** Порты, которые держит «чужой процесс», и ошибка, которой ответит сервер. */
let busy: Set<number>;
let serverError: Error | null;

function fakeWorker(pid: number) {
  let onDied: (() => void) | undefined;
  const servers: { listenInfos: { port: number }[] }[] = [];
  return {
    pid,
    closed: false,
    servers,
    on(event: string, fn: () => void) {
      if (event === 'died') onDied = fn;
    },
    async createWebRtcServer(opts: { listenInfos: { port: number }[] }) {
      const port = opts.listenInfos[0].port;
      if (serverError) throw serverError;
      if (busy.has(port)) {
        // Текст — как у настоящего mediasoup 3.22 (проверено на живом воркере).
        throw new Error(
          `uv_udp_bind() failed [protocol:udp, ip:'0.0.0.0', port:${port}]: address already in use`,
        );
      }
      servers.push(opts);
      return { id: `srv-${pid}`, opts };
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
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  made = [];
  busy = new Set();
  serverError = null;
  createWorker.mockImplementation(async () => {
    const w = fakeWorker(1000 + made.length);
    made.push(w);
    return w;
  });
  delete process.env.SFU_WORKERS;
  delete process.env.SFU_RTC_MIN_PORT;
  delete process.env.SFU_RTC_MAX_PORT;
});

afterEach(() => {
  delete process.env.SFU_WORKERS;
  delete process.env.SFU_RTC_MIN_PORT;
  delete process.env.SFU_RTC_MAX_PORT;
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

it('воркеры садятся на порты по порядку от min', async () => {
  process.env.SFU_WORKERS = '3';
  process.env.SFU_RTC_MIN_PORT = '50000';
  process.env.SFU_RTC_MAX_PORT = '50100';
  await new WorkersService().onModuleInit();
  expect(made.map((w) => w.servers[0].listenInfos[0].port)).toEqual([50000, 50001, 50002]);
});

it('занятый чужим процессом порт пропускается, а не роняет SFU', async () => {
  process.env.SFU_WORKERS = '2';
  process.env.SFU_RTC_MIN_PORT = '50000';
  process.env.SFU_RTC_MAX_PORT = '50100';
  busy = new Set([50000, 50002]);
  const warn = vi.spyOn(Logger.prototype, 'warn');
  await new WorkersService().onModuleInit();
  expect(made.map((w) => w.servers[0].listenInfos[0].port)).toEqual([50001, 50003]);
  expect(warn.mock.calls.filter((c) => String(c[0]).includes('taken'))).toHaveLength(2);
});

it('свободных портов не хватило числу по ядрам — меньше воркеров, лишний закрыт', async () => {
  if (cpus().length < 2) return; // на одноядерной машине урезать нечего
  process.env.SFU_RTC_MIN_PORT = '40000';
  process.env.SFU_RTC_MAX_PORT = '40001';
  busy = new Set([40001]);
  const s = new WorkersService();
  await s.onModuleInit();
  expect(made).toHaveLength(2);
  expect(made[1].closed).toBe(true);
  expect([s.take(), s.take()].map((t) => t.worker)).toEqual([made[0], made[0]]);
});

it('свободных портов не хватило явному SFU_WORKERS — отказ на старте', async () => {
  process.env.SFU_WORKERS = '2';
  process.env.SFU_RTC_MIN_PORT = '40000';
  process.env.SFU_RTC_MAX_PORT = '40001';
  busy = new Set([40001]);
  await expect(new WorkersService().onModuleInit()).rejects.toThrow(
    /no free RTC port.*40000-40001/,
  );
  expect(made[1].closed).toBe(true);
});

it('весь диапазон занят — отказ на старте, даже без SFU_WORKERS', async () => {
  process.env.SFU_RTC_MIN_PORT = '40000';
  process.env.SFU_RTC_MAX_PORT = '40000';
  busy = new Set([40000]);
  await expect(new WorkersService().onModuleInit()).rejects.toThrow(/no free RTC port/);
});

it('ошибка WebRtcServer не про занятость не маскируется перебором портов', async () => {
  process.env.SFU_WORKERS = '1';
  serverError = new Error('permission denied');
  await expect(new WorkersService().onModuleInit()).rejects.toThrow('permission denied');
});

it('комнаты раздаются по кругу — воркер однопоточный, свалить всё в один нельзя', async () => {
  process.env.SFU_WORKERS = '2';
  const s = new WorkersService();
  await s.onModuleInit();
  const taken = [s.take(), s.take(), s.take()];
  expect(taken.map((t) => t.worker)).toEqual([made[0], made[1], made[0]]);
  expect(taken[0].webRtcServer).toEqual({ id: 'srv-1000', opts: made[0].servers[0] });
});

it('ядер больше, чем портов, — воркеров столько, сколько портов, и предупреждение', async () => {
  process.env.SFU_RTC_MIN_PORT = '40000';
  process.env.SFU_RTC_MAX_PORT = '40000';
  const warn = vi.spyOn(Logger.prototype, 'warn');
  await new WorkersService().onModuleInit();
  expect(made).toHaveLength(1);
  if (cpus().length > 1) expect(warn).toHaveBeenCalled();
});

it('явный SFU_WORKERS, который не влезает в диапазон, — громкий отказ на старте', async () => {
  process.env.SFU_WORKERS = '5';
  process.env.SFU_RTC_MIN_PORT = '40000';
  process.env.SFU_RTC_MAX_PORT = '40002';
  await expect(new WorkersService().onModuleInit()).rejects.toThrow(/SFU_WORKERS=5.*3/);
  expect(made).toHaveLength(0);
});

it('перевёрнутый диапазон — отказ на старте, даже без SFU_WORKERS', async () => {
  process.env.SFU_RTC_MIN_PORT = '40100';
  process.env.SFU_RTC_MAX_PORT = '40000';
  await expect(new WorkersService().onModuleInit()).rejects.toThrow(/SFU_RTC_MAX_PORT/);
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
