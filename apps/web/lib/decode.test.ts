import { describe, expect, it } from 'vitest';
import { decodeOrNull } from './decode';

describe('decodeOrNull', () => {
  it('decodes a well-formed component', () => {
    expect(decodeOrNull('%D0%B0%20b')).toBe('а b');
  });

  it('returns null for a broken escape instead of throwing', () => {
    expect(decodeOrNull('%E0%A4')).toBeNull();
    expect(decodeOrNull('%')).toBeNull();
  });
});
