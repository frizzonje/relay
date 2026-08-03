import { describe, expect, it } from 'vitest';
import { cpuUsageBetween, meminfoKb } from './metrics';

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
