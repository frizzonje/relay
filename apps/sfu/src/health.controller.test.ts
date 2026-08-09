import { describe, expect, it } from 'vitest';
import { HealthController } from './health.controller';

describe('GET /health медиасервера', () => {
  it('отдаёт только «жив»: авторизации у sfu нет, лишнему тут не место', () => {
    const body = new HealthController().health();
    expect(body).toEqual({ ok: true });
    expect(Object.keys(body)).toEqual(['ok']);
  });
});
