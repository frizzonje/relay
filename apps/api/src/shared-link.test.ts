import { describe, expect, it } from 'vitest';
import { APP_NAME, PROTOCOL_VERSION } from '@relay/shared';

describe('@relay/shared из api', () => {
  it('пакет резолвится и отдаёт контракт', () => {
    expect(APP_NAME).toBe('relay');
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
  });
});
