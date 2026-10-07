import type { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Periodic } from './periodic';
import type { SettingsService } from './settings/settings.service';

/**
 * Расписание уборщиков. Сторожим три обещания из шапки `Periodic`: проходы не
 * идут внахлёст, ошибка прохода не роняет процесс, расписание снимается.
 */

const logger = () =>
  ({ error: vi.fn(), log: vi.fn() }) as unknown as Logger & { error: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Periodic', () => {
  it('первый проход сразу, дальше — по периоду', async () => {
    const task = vi.fn(async () => {});
    const p = new Periodic(logger(), task);
    p.every(1000);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(task).toHaveBeenCalledTimes(4);
    p.stop();
  });

  it('проход дольше периода не запускает второй поверх себя', async () => {
    let finish!: () => void;
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const p = new Periodic(logger(), task);
    p.every(1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(task).toHaveBeenCalledTimes(1);

    finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it('упавший проход уходит в лог, а следующий всё равно идёт', async () => {
    const log = logger();
    const task = vi
      .fn()
      .mockRejectedValueOnce(new Error('база легла'))
      .mockResolvedValue(undefined);
    const p = new Periodic(log, task);
    p.every(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('база легла'));

    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it('stop снимает и таймер, и подписку на настройки', async () => {
    const unsubscribe = vi.fn();
    const settings = { onChange: vi.fn(() => unsubscribe) } as unknown as SettingsService;
    const task = vi.fn(async () => {});
    const p = new Periodic(logger(), task);
    p.follow(settings, ['k'], () => 1000);
    p.stop();
    task.mockClear();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('follow пересобирает расписание на смене своей настройки и только её', async () => {
    let listener!: (key: string) => void;
    const settings = {
      onChange: vi.fn((l: (key: string) => void) => {
        listener = l;
        return () => {};
      }),
    } as unknown as SettingsService;
    let period: number | null = null;
    const task = vi.fn(async () => {});
    const p = new Periodic(logger(), task);
    p.follow(settings, ['k'], () => period);
    expect(task).not.toHaveBeenCalled();

    period = 1000;
    listener('чужая');
    expect(task).not.toHaveBeenCalled();
    listener('k');
    expect(task).toHaveBeenCalledTimes(1);
    p.stop();
  });
});
