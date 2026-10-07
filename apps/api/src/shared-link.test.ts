import { describe, expect, it } from 'vitest';
import { APP_NAME, PROTOCOL_VERSION } from '@relay/shared';
import { PROTOCOL_VERSION as API_PROTOCOL } from './gateway/protocol';

describe('@relay/shared из api', () => {
  it('пакет резолвится и отдаёт контракт', () => {
    expect(APP_NAME).toBe('relay');
    expect(PROTOCOL_VERSION).toBe(API_PROTOCOL);
  });
});
