import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetricsService, cpuSample, cpuUsageBetween, meminfoKb } from './metrics';

/**
 * Считающая часть метрик — без /proc и без statfs. Проверяем именно те два
 * места, где легко соврать пользователю: занятость процессора между снимками
 * и разбор `/proc/meminfo`.
 */

describe('cpuUsageBetween', () => {
  it('считает долю занятого времени между снимками', () => {
    const prev = { idle: 1000, total: 2000 };
    const next = { idle: 1250, total: 3000 }; // за 1000 тиков простояли 250
    expect(cpuUsageBetween(prev, next)).toBeCloseTo(0.75, 5);
  });

  it('полный простой — ноль, а не «нет данных»', () => {
    expect(cpuUsageBetween({ idle: 0, total: 0 }, { idle: 500, total: 500 })).toBe(0);
  });

  it('время не шло — null, а не деление на ноль', () => {
    expect(cpuUsageBetween({ idle: 10, total: 20 }, { idle: 10, total: 20 })).toBeNull();
  });

  it('счётчики уехали назад (смена состава ядер) — null, а не 100%', () => {
    expect(cpuUsageBetween({ idle: 900, total: 1000 }, { idle: 100, total: 1200 })).toBeNull();
  });

  it('держится в границах 0..1', () => {
    const v = cpuUsageBetween({ idle: 0, total: 0 }, { idle: 0, total: 1000 });
    expect(v).toBe(1);
  });
});

describe('meminfoKb', () => {
  const sample = [
    'MemTotal:        8129412 kB',
    'MemFree:          204164 kB',
    'MemAvailable:    5233128 kB',
    'Buffers:           88132 kB',
  ].join('\n');

  it('берёт запрошенное поле', () => {
    expect(meminfoKb(sample, 'MemTotal')).toBe(8129412);
    expect(meminfoKb(sample, 'MemAvailable')).toBe(5233128);
  });

  it('не путает MemFree с MemTotal по префиксу', () => {
    expect(meminfoKb(sample, 'Mem')).toBeNull();
  });

  it('поля нет (старое ядро без MemAvailable) — null', () => {
    expect(meminfoKb('MemTotal:        8129412 kB', 'MemAvailable')).toBeNull();
  });
});

describe('cpuSample', () => {
  it('складывает тики всех ядер, и простой не больше общего времени', () => {
    const s = cpuSample();
    expect(s.total).toBeGreaterThan(0);
    expect(s.idle).toBeGreaterThanOrEqual(0);
    expect(s.idle).toBeLessThanOrEqual(s.total);
  });
});

describe('MetricsService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('первый запрос успевает раньше фонового такта — меряет коротко сам', async () => {
    const m = await new MetricsService().read();
    // Прочерка вместо загрузки на главном экране быть не должно.
    expect(m.cpu.usage).not.toBeNull();
    expect(m.cpu.cores).toBeGreaterThan(0);
    expect(m.mem.total).toBeGreaterThan(0);
    expect(m.mem.used).toBeGreaterThanOrEqual(0);
    expect(m.uptimeSec).toBeGreaterThan(0);
  });

  it('второй запрос в пределах секунды приходит из кэша — /proc не трогаем', async () => {
    const service = new MetricsService();
    const first = await service.read();
    const second = await service.read();
    expect(second).toBe(first);
  });

  it('фоновый такт заводится и не держит процесс живым', () => {
    const service = new MetricsService();
    const unref = vi.fn();
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue({ unref } as unknown as NodeJS.Timeout);
    service.onModuleInit();
    expect(setIntervalSpy).toHaveBeenCalled();
    expect(unref).toHaveBeenCalled();
  });

  it('диск отдаётся прочерком, а не нулями, когда его не измерить', async () => {
    const m = await new MetricsService().read();
    // Тома может не быть (или не быть прав) — но тогда именно null, не {0,0}.
    if (m.disk !== null) {
      expect(m.disk.total).toBeGreaterThan(0);
      expect(m.disk.used).toBeGreaterThanOrEqual(0);
    }
  });
});
