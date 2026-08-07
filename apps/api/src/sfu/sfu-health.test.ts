import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Живость медиасервера. Тут два обязательства: короткий общий кэш (клиентские
 * ретраи идут раз в 5 секунд, и пинговать на каждый незачем) и лог ТОЛЬКО на
 * переходах — иначе он забивается строкой на каждый запрос и перестаёт быть
 * тем местом, где видно «звонки перестали собираться».
 *
 * Кэш живёт на уровне модуля, поэтому каждый тест берёт свежую его копию.
 */

async function freshModule() {
  vi.resetModules();
  return import('./sfu-health');
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  process.env.SFU_URL = 'https://relay.example/sfu';
  process.env.SFU_SECRET = 'секрет';
  delete process.env.SFU_INTERNAL_URL;
  fetchMock = vi.fn(async () => ({ ok: true }) as Response);
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.SFU_URL;
  delete process.env.SFU_SECRET;
  delete process.env.SFU_INTERNAL_URL;
});

it('ненастроенный медиасервер даже не пингуют', async () => {
  delete process.env.SFU_SECRET;
  const { sfuHealthy } = await freshModule();
  expect(await sfuHealthy()).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('пинг идёт на внутренний адрес, а не на публичный SFU_URL', async () => {
  const { sfuHealthy } = await freshModule();
  await sfuHealthy();
  expect(fetchMock.mock.calls[0][0]).toBe('http://sfu:3100/health');
});

it('SFU_INTERNAL_URL перекрывает дефолт, лишние слэши срезаются', async () => {
  process.env.SFU_INTERNAL_URL = 'http://медиа:9000///';
  const { sfuHealthy } = await freshModule();
  await sfuHealthy();
  expect(fetchMock.mock.calls[0][0]).toBe('http://медиа:9000/health');
});

it('повторные запросы обслуживаются из кэша — один пинг на всех', async () => {
  const { sfuHealthy } = await freshModule();
  await sfuHealthy();
  await sfuHealthy();
  await sfuHealthy();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('через пять секунд кэш протухает и сервер спрашивают заново', async () => {
  const { sfuHealthy } = await freshModule();
  await sfuHealthy();
  vi.advanceTimersByTime(5001);
  await sfuHealthy();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('не-200 и сетевая ошибка одинаково значат «лежит»', async () => {
  const { sfuHealthy } = await freshModule();
  fetchMock.mockResolvedValueOnce({ ok: false } as Response);
  expect(await sfuHealthy()).toBe(false);

  vi.advanceTimersByTime(5001);
  fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
  expect(await sfuHealthy()).toBe(false);
});

it('в лог идут только переходы, а не каждый пинг', async () => {
  const warn = vi.spyOn(Logger.prototype, 'warn');
  const log = vi.spyOn(Logger.prototype, 'log');
  const { sfuHealthy } = await freshModule();

  // Первый ответ — сразу «жив»: это тоже переход (состояния ещё не было).
  await sfuHealthy();
  expect(log).toHaveBeenCalledTimes(1);

  vi.advanceTimersByTime(5001);
  await sfuHealthy();
  expect(log).toHaveBeenCalledTimes(1); // то же состояние — молчим

  vi.advanceTimersByTime(5001);
  fetchMock.mockResolvedValueOnce({ ok: false } as Response);
  await sfuHealthy();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0][0])).toContain('fall back to p2p');
});
