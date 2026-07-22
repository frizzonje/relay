import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifySfuToken } from './token';

// Копия выдающей стороны (apps/api/src/sfu/sfu-token.ts) — тест на то, что
// формат близнецов сходится. Разъедутся — здесь и заметим.
function issue(
  claims: Record<string, unknown>,
  { secret = 'test-secret', ttlMs = 60_000 } = {},
): string {
  const body = Buffer.from(JSON.stringify({ ...claims, exp: Date.now() + ttlMs })).toString(
    'base64url',
  );
  const prefix = `s1.${body}`;
  const sig = createHmac('sha256', 'relay-sfu-v1:' + secret)
    .update(prefix)
    .digest('base64url');
  return `${prefix}.${sig}`;
}

const CLAIMS = { room: 'voice-general', peerId: 'abc123', name: 'Аня' };

describe('verifySfuToken', () => {
  beforeEach(() => {
    process.env.SFU_SECRET = 'test-secret';
  });
  afterEach(() => {
    delete process.env.SFU_SECRET;
  });

  it('принимает свежий токен и отдаёт клеймы', () => {
    expect(verifySfuToken(issue(CLAIMS))).toMatchObject(CLAIMS);
  });

  it('не принимает подпись чужим ключом', () => {
    expect(verifySfuToken(issue(CLAIMS, { secret: 'other' }))).toBeNull();
  });

  it('не принимает протухший токен', () => {
    expect(verifySfuToken(issue(CLAIMS, { ttlMs: -1 }))).toBeNull();
  });

  it('не принимает подделку тела при чужой подписи', () => {
    const token = issue(CLAIMS);
    const [version, , sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...CLAIMS, room: 'secret', exp: Date.now() + 1000 }),
    ).toString('base64url');
    expect(verifySfuToken(`${version}.${forged}.${sig}`)).toBeNull();
  });

  it('не принимает мусор', () => {
    for (const bad of ['', 'abc', 's1.abc', 's2.a.b', null, undefined, 42, {}]) {
      expect(verifySfuToken(bad)).toBeNull();
    }
  });

  it('без SFU_SECRET не пускает никого — сервис не настроен', () => {
    const token = issue(CLAIMS, { secret: '' });
    delete process.env.SFU_SECRET;
    expect(verifySfuToken(token)).toBeNull();
  });
});
