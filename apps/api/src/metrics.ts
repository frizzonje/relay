import { Injectable, type OnModuleInit } from '@nestjs/common';
import { readFile, statfs } from 'node:fs/promises';
import { cpus, freemem, loadavg, platform, totalmem, uptime } from 'node:os';
import { UPLOAD_DIR } from './uploads';

/**
 * Состояние машины, на которой стоит инсталляция: процессор, память, диск.
 * Отдаётся на главный экран (`GET /api/metrics`), за пропуском.
 *
 * Меряем ХОСТ, а не контейнер, и это не оплошность: в docker без lxcfs `/proc`
 * общий с хостом, поэтому `os.cpus()`, `/proc/meminfo` и `os.uptime()` и так
 * показывают машину целиком. Именно это и нужно: человек смотрит на экран,
 * чтобы понять, не пора ли добавить памяти серверу, — cgroup-лимит контейнера
 * ответа на этот вопрос не даёт.
 *
 * Диск меряем по тому с данными relay (`UPLOAD_DIR`): там лежат загрузки,
 * реестр и — в проде — сертификаты Caddy рядом. Кончится он, и ляжет всё.
 */

// Свежести хватает с запасом: клиент опрашивает раз в 5 с, а лишние заходы
// (несколько вкладок, кто-то с зажатым F5) обслуживаются из этого кэша, не
// трогая ни /proc, ни statfs.
const CACHE_MS = 1000;
// Такт фоновой выборки процессора. Занятость — это дельта между двумя
// снимками, мгновенного значения у неё не бывает.
const SAMPLE_MS = 2000;
// Сколько ждать, если первый запрос успел раньше первого такта: короткая
// синхронная выборка вместо прочерка на экране. Один раз за жизнь процесса.
const FIRST_SAMPLE_MS = 150;

export interface Metrics {
  cpu: { cores: number; usage: number | null; load1: number | null };
  mem: { total: number; used: number };
  disk: { total: number; used: number } | null;
  uptimeSec: number;
}

interface CpuSample {
  idle: number;
  total: number;
}

/** Суммарные тики всех ядер: сколько простаивали и сколько всего. */
export function cpuSample(): CpuSample {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/**
 * Занятость между двумя снимками, 0..1. `null`, если время не шло (снимки
 * совпали) или счётчики уехали назад — это бывает при смене состава ядер,
 * и выдать в такой момент «100%» было бы враньём.
 */
export function cpuUsageBetween(prev: CpuSample, next: CpuSample): number | null {
  const dTotal = next.total - prev.total;
  const dIdle = next.idle - prev.idle;
  if (dTotal <= 0 || dIdle < 0) return null;
  return Math.min(1, Math.max(0, 1 - dIdle / dTotal));
}

/** Значение строки `/proc/meminfo` в килобайтах (`MemTotal: 8129412 kB`). */
export function meminfoKb(text: string, field: string): number | null {
  const m = new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, 'm').exec(text);
  if (!m) return null;
  const kb = Number(m[1]);
  return Number.isFinite(kb) ? kb : null;
}

/**
 * Память хоста. `MemAvailable` — не то же, что `MemFree`: ядро считает в него и
 * кэш, который отдаст под нагрузкой. Без этой поправки Linux на любом сервере
 * выглядит забитым под завязку, хотя памяти свободна половина.
 */
async function readMem(): Promise<{ total: number; used: number }> {
  if (platform() === 'linux') {
    try {
      const text = await readFile('/proc/meminfo', 'utf8');
      const total = meminfoKb(text, 'MemTotal');
      const available = meminfoKb(text, 'MemAvailable');
      if (total && available !== null) {
        return { total: total * 1024, used: Math.max(0, (total - available) * 1024) };
      }
    } catch {
      // нет доступа к /proc — уходим на os.*
    }
  }
  const total = totalmem();
  return { total, used: Math.max(0, total - freemem()) };
}

/**
 * Том с данными. `bavail` (доступно непривилегированному), а не `bfree`: на
 * ext4 под root зарезервировано 5%, и мерить по `bfree` значит обещать место,
 * которого сервису не дадут. То же самое считает `df` в столбце Use%.
 */
async function readDisk(path: string): Promise<{ total: number; used: number } | null> {
  try {
    const fs = await statfs(path);
    const block = Number(fs.bsize);
    const total = Number(fs.blocks) * block;
    const available = Number(fs.bavail) * block;
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(available)) return null;
    return { total, used: Math.max(0, total - available) };
  } catch {
    // не смонтировано / нет прав / платформа без statfs — честный прочерк
    return null;
  }
}

@Injectable()
export class MetricsService implements OnModuleInit {
  private last: CpuSample = cpuSample();
  private usage: number | null = null;
  private cache: { at: number; value: Metrics } | null = null;

  onModuleInit() {
    const timer = setInterval(() => this.tick(), SAMPLE_MS);
    timer.unref?.(); // чистильщик не держит процесс живым
  }

  private tick() {
    const next = cpuSample();
    const usage = cpuUsageBetween(this.last, next);
    this.last = next;
    if (usage !== null) this.usage = usage;
  }

  async read(): Promise<Metrics> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < CACHE_MS) return this.cache.value;

    // Запрос успел раньше первого фонового такта — меряем коротко прямо здесь,
    // чтобы главный экран не открывался с прочерком вместо загрузки.
    if (this.usage === null) {
      await new Promise((r) => setTimeout(r, FIRST_SAMPLE_MS));
      this.tick();
    }

    const [mem, disk] = await Promise.all([readMem(), readDisk(UPLOAD_DIR)]);
    // loadavg на не-Linux возвращает нули — это не «нагрузки нет», а «не умею».
    const load = loadavg()[0];
    const value: Metrics = {
      cpu: {
        cores: cpus().length,
        usage: this.usage,
        load1: platform() === 'linux' && Number.isFinite(load) ? load : null,
      },
      mem,
      disk,
      uptimeSec: Math.round(uptime()),
    };
    this.cache = { at: now, value };
    return value;
  }
}
