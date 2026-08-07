import { BadRequestException, HttpException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller';
import { MetricsController } from './metrics.controller';
import type { Metrics, MetricsService } from './metrics';
import { UploadController } from './upload.controller';
import { UploadByteBudget, UploadRateGuard, uploadBudget } from './upload.guard';
import type { Attachment, UploadsService } from './uploads';

/**
 * Мелкие http-ручки и гард загрузок. Ручки тонкие нарочно, и проверять в них
 * есть ровно то, что нельзя увидеть глазами: что health не рассказывает об
 * инсталляции ничего лишнего, что метрики запрещено кэшировать промежуточным
 * прокси и что бюджет байтов списывается по НАСТОЯЩЕМУ размеру файла, а не по
 * тому, что клиент написал в заголовке.
 */

describe('GET /api/health', () => {
  it('отвечает только «жив» — ни версии, ни данных об инсталляции', () => {
    const body = new HealthController().health();
    expect(body).toEqual({ ok: true });
    expect(Object.keys(body)).toEqual(['ok']);
  });
});

describe('GET /api/metrics', () => {
  it('отдаёт срез машины как есть', async () => {
    const snapshot: Metrics = {
      cpu: { cores: 4, usage: 0.25, load1: 0.5 },
      mem: { total: 100, used: 40 },
      disk: { total: 1000, used: 200 },
      uptimeSec: 3600,
    };
    const service = { read: vi.fn(async () => snapshot) } as unknown as MetricsService;
    expect(await new MetricsController(service).read()).toBe(snapshot);
  });

  it('помечен no-store: живые цифры прокси кэшировать нельзя', () => {
    // Заголовок навешивает декоратор @Header — читаем его метаданные Nest.
    const meta = Reflect.getMetadata(
      '__headers__',
      MetricsController.prototype.read,
    ) as { name: string; value: string }[];
    expect(meta).toContainEqual({ name: 'Cache-Control', value: 'no-store' });
  });
});

describe('POST /api/upload', () => {
  function service() {
    const registered: unknown[] = [];
    const uploads = {
      registered,
      register(file: { filename: string; size: number }) {
        registered.push(file);
        return { id: file.filename, url: `/uploads/${file.filename}` } as Attachment & {
          id: string;
        };
      },
    };
    return uploads as unknown as UploadsService & { registered: unknown[] };
  }

  const file = { filename: 'abc.png', originalname: 'кот.png', size: 1234, mimetype: 'image/png' };

  it('регистрирует файл и возвращает его id', () => {
    const uploads = service();
    const out = new UploadController(uploads).upload({ ip: '10.0.0.1' } as Request, file);
    expect(out.id).toBe('abc.png');
    expect(uploads.registered).toEqual([file]);
  });

  it('запрос без файла — 400, а не пустое вложение в чате', () => {
    expect(() =>
      new UploadController(service()).upload({ ip: '10.0.0.1' } as Request, undefined),
    ).toThrow(BadRequestException);
  });

  it('списывает настоящий размер записанного файла, а не Content-Length', () => {
    const charge = vi.spyOn(uploadBudget, 'charge');
    new UploadController(service()).upload({ ip: '10.0.0.1' } as Request, file);
    expect(charge).toHaveBeenCalledWith('10.0.0.1', 1234);
    charge.mockRestore();
  });
});

describe('гард загрузок', () => {
  function ctx(ip: string | undefined): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => ({ ip }) as Request }),
    } as unknown as ExecutionContext;
  }

  it('пускает, пока бюджет адреса не исчерпан', () => {
    expect(new UploadRateGuard().canActivate(ctx('10.0.0.99'))).toBe(true);
  });

  it('исчерпанный бюджет — 429, и отказ приходит ДО записи файла на диск', () => {
    const budget = new UploadByteBudget();
    // Гард ходит в общий на процесс бюджет — тратим его для этого адреса.
    uploadBudget.charge('10.0.0.100', 400 * 1024 ** 2);
    expect(() => new UploadRateGuard().canActivate(ctx('10.0.0.100'))).toThrow(HttpException);
    // Свежий бюджет того же класса при этом ни при чём — состояние не глобальное.
    expect(budget.allow('10.0.0.100')).toBe(true);
  });

  it('запрос без адреса не роняет гард', () => {
    expect(() => new UploadRateGuard().canActivate(ctx(undefined))).not.toThrow();
  });
});
