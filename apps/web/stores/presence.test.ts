import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PresenceEntry } from '@relay/shared';
import { presenceOf, RECENT_MS, usePresenceStore } from './presence';

/**
 * Глобальное присутствие личности («в сети / в голосе / недавно», на всю
 * инсталляцию — не путать с `voice-presence` из stores/voice.ts, тот
 * пер-канальный). Четыре вещи здесь ломаются молча:
 *
 *  • снимок (`presence`) не заполнил карту — весь экран показывает «никого»,
 *    хотя в инсталляции полно людей;
 *  • дельта (`presence-update`) погасила ЧУЖУЮ точку заодно со своей —
 *    коалесцирующая пачка сервера на то и пачка, что в ней несколько записей,
 *    и обработка обязана трогать только упомянутых;
 *  • «недавно» не гаснет по времени на клиенте — вкладка, проспавшая своё
 *    окно в фоне, показывает «недавно» человеку, который на самом деле давно
 *    закрыл вкладку;
 *  • неизвестный отпечаток читается как дыра (`undefined`), а не как честный
 *    `offline` — сервер никогда не шлёт офлайн-записи в снимке (см. комментарий
 *    в apps/api/src/gateway/presence.ts), так что «никогда не слышали» и
 *    «явно не в сети» обязаны выглядеть одинаково.
 */

const ONLINE: PresenceEntry = { fingerprint: 'fp-аня', state: 'online', since: 1_000 };
const IN_VOICE: PresenceEntry = { fingerprint: 'fp-боря', state: 'in-voice', since: 1_000 };

beforeEach(() => {
  usePresenceStore.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('снимок и дельта', () => {
  it('снимок заполняет карту целиком', () => {
    usePresenceStore.getState().applySnapshot([ONLINE, IN_VOICE]);
    expect(usePresenceStore.getState().people).toEqual({
      'fp-аня': ONLINE,
      'fp-боря': IN_VOICE,
    });
  });

  it('дельта правит одного человека, не трогая остальных', () => {
    usePresenceStore.getState().applySnapshot([ONLINE, IN_VOICE]);
    const changed: PresenceEntry = { fingerprint: 'fp-аня', state: 'recent', since: 5_000 };
    usePresenceStore.getState().applyDelta([changed]);

    const people = usePresenceStore.getState().people;
    expect(people['fp-аня']).toEqual(changed);
    // Собеседник, о котором дельта не говорила ни слова, обязан остаться
    // ровно тем же объектом — не просто равным по значению, а тем же самым:
    // иначе подписчик на его запись перерисовался бы впустую.
    expect(people['fp-боря']).toBe(IN_VOICE);
  });

  it('дельта с пустым списком ничего не меняет', () => {
    usePresenceStore.getState().applySnapshot([ONLINE]);
    const before = usePresenceStore.getState().people;
    usePresenceStore.getState().applyDelta([]);
    expect(usePresenceStore.getState().people).toBe(before);
  });
});

describe('presenceOf', () => {
  it('неизвестный отпечаток — offline, а не дыра', () => {
    usePresenceStore.getState().applySnapshot([ONLINE]);
    expect(presenceOf(usePresenceStore.getState().people, 'fp-призрак')).toEqual({
      fingerprint: 'fp-призрак',
      state: 'offline',
      since: 0,
    });
  });

  it('«недавно» превращается в «офлайн» по времени, даже без новой дельты', () => {
    const recent: PresenceEntry = { fingerprint: 'fp-аня', state: 'recent', since: 10_000 };
    const people = { 'fp-аня': recent };

    // За миг до истечения окна — ещё «недавно».
    expect(presenceOf(people, 'fp-аня', 10_000 + RECENT_MS - 1).state).toBe('recent');
    // Окно истекло — офлайн, без единого события от сервера.
    expect(presenceOf(people, 'fp-аня', 10_000 + RECENT_MS).state).toBe('offline');
  });

  it('online и in-voice не угасают сами по себе', () => {
    const people = { 'fp-аня': ONLINE };
    expect(presenceOf(people, 'fp-аня', ONLINE.since + RECENT_MS * 10).state).toBe('online');
  });
});
