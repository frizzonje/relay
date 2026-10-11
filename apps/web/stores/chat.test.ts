import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '@relay/shared';
import { useChatStore } from './chat';

const msg = (id: string, ts: number) => ({ id, ts, text: id }) as unknown as ChatMessage;
const chat = () => useChatStore.getState();

/**
 * Страница «ещё» запрашивается без канала: сервер берёт его из комнаты сокета.
 * Пока она летит, человек мог уйти в другой канал или беседу — и страница
 * прежней ленты (или чужая страница по прежнему курсору) легла бы в новую.
 */
describe('chat paging across a feed switch', () => {
  beforeEach(() => {
    chat().reset();
    chat().setHistory([msg('a2', 2), msg('a3', 3)], true);
  });

  it('an older page asked for the previous feed is dropped', () => {
    const feed = chat().feed;
    chat().reset();
    chat().setHistory([msg('b1', 10)], true);
    chat().prependHistory([msg('a1', 1)], false, feed);
    expect(chat().messages.map((m) => m.id)).toEqual(['b1']);
    expect(chat().more).toBe(true);
  });

  it('a newer page asked for the previous window is dropped', () => {
    chat().setWindow([msg('a2', 2)], true, true);
    const feed = chat().feed;
    chat().setWindow([msg('x5', 5)], true, true);
    chat().appendHistory([msg('a3', 3)], false, feed);
    expect(chat().messages.map((m) => m.id)).toEqual(['x5']);
    expect(chat().moreAfter).toBe(true);
  });

  it('a page for the current feed still lands', () => {
    chat().prependHistory([msg('a1', 1)], false, chat().feed);
    expect(chat().messages.map((m) => m.id)).toEqual(['a1', 'a2', 'a3']);
  });
});
