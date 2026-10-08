import { describe, expect, it } from 'vitest';
import { callRoomOf, isCallRoom, isDmSlug } from './dm';

const ADDRESS = 'dm-0123456789abcdef01234567';

describe('адрес беседы и комната её звонка', () => {
  it('беседа узнаётся по форме целиком, а не по приставке', () => {
    expect(isDmSlug(ADDRESS)).toBe(true);
    expect(isDmSlug('dm-обсуждение')).toBe(false);
    expect(isDmSlug(`${ADDRESS}0`)).toBe(false);
  });

  it('комната звонка — приставка плюс адрес беседы, и только он', () => {
    expect(isCallRoom(callRoomOf(ADDRESS))).toBe(true);
    expect(isCallRoom('voice:болталка')).toBe(false);
    expect(isCallRoom('voice:dm-обсуждение')).toBe(false);
    expect(isCallRoom(ADDRESS)).toBe(false);
  });
});
