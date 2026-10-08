import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const emit = vi.hoisted(() => vi.fn());
vi.mock('@/lib/socket', async () => {
  const { timeoutOf } = await import('@/lib/testing/socket');
  return { getSocket: () => ({ emit, timeout: timeoutOf(emit) }) };
});

import { unreadIn, useDmStore } from './dm';
import { useUnreadStore } from './unread';

const peer = { fingerprint: 'fp-ты', nick: 'ты' };
const slug = 'dm-0123456789abcdef01234567';

beforeEach(() => {
  emit.mockClear();
  useDmStore.getState().reset();
  useUnreadStore.setState({ lastRead: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Ответить за сервер: подтверждение — последний аргумент вызова. */
function answerLast(res: unknown): void {
  const cb = emit.mock.calls.at(-1)?.at(-1);
  if (typeof cb !== 'function') throw new Error('в этом вызове нечем ответить');
  (cb as (r: unknown) => void)(res);
}

describe('список переписок', () => {
  it('свежая реплика поднимает беседу наверх', () => {
    useDmStore.getState().setConversations([
      {
        slug: 'dm-aaaaaaaaaaaaaaaaaaaaaaaa',
        peer: { fingerprint: 'fp-a', nick: 'а' },
        lastTs: 200,
        preview: 'ага',
        previewMine: false,
      },
      { slug, peer, lastTs: 100, preview: 'привет', previewMine: false },
    ]);

    useDmStore
      .getState()
      .applyActivity({ slug, ts: 300, preview: 'ты тут?', previewMine: false, peer });

    const list = useDmStore.getState().conversations;
    expect(list.map((c) => c.slug)).toEqual([slug, 'dm-aaaaaaaaaaaaaaaaaaaaaaaa']);
    expect(list[0].preview).toBe('ты тут?');
    expect(useDmStore.getState().activity[slug]).toBe(300);
  });

  it('реплика из беседы, которой нет в списке, заводит её', () => {
    useDmStore
      .getState()
      .applyActivity({ slug, ts: 42, preview: 'привет', previewMine: false, peer });
    expect(useDmStore.getState().conversations).toHaveLength(1);
    expect(useDmStore.getState().conversations[0].peer.nick).toBe('ты');
  });

  it('открытая переписка не дублируется', () => {
    const conversation = { slug, peer, lastTs: 0, preview: '', previewMine: false };
    useDmStore.getState().remember(conversation);
    useDmStore.getState().remember(conversation);
    expect(useDmStore.getState().conversations).toHaveLength(1);
  });

  it('старая реплика не двигает список', () => {
    useDmStore
      .getState()
      .setConversations([{ slug, peer, lastTs: 500, preview: 'позже', previewMine: false }]);
    useDmStore
      .getState()
      .applyActivity({ slug, ts: 100, preview: 'раньше', previewMine: false, peer });
    expect(useDmStore.getState().conversations[0].preview).toBe('позже');
  });
});

describe('снимок списка и живые реплики', () => {
  it('реплика, пришедшая пока список ехал, не откатывается старым снимком', async () => {
    useDmStore.getState().reload();
    // Снимок сервер снял раньше, а реплика обогнала его ответ.
    useDmStore
      .getState()
      .applyActivity({ slug, ts: 300, preview: 'ты тут?', previewMine: false, peer });
    answerLast({
      ok: true,
      conversations: [{ slug, peer, lastTs: 100, preview: 'привет', previewMine: false }],
    });
    await vi.waitFor(() => expect(useDmStore.getState().loading).toBe(false));
    const [c] = useDmStore.getState().conversations;
    expect(c.preview).toBe('ты тут?');
    expect(useDmStore.getState().activity[slug]).toBe(300);
  });

  it('беседа, заведённая репликой на лету, не пропадает из списка', async () => {
    const other = 'dm-bbbbbbbbbbbbbbbbbbbbbbbb';
    useDmStore.getState().reload();
    useDmStore.getState().applyActivity({
      slug: other,
      ts: 500,
      preview: 'привет, это я',
      previewMine: false,
      peer: { fingerprint: 'fp-b', nick: 'б' },
    });
    answerLast({
      ok: true,
      conversations: [{ slug, peer, lastTs: 100, preview: 'привет', previewMine: false }],
    });
    await vi.waitFor(() => expect(useDmStore.getState().loading).toBe(false));
    expect(useDmStore.getState().conversations.map((c) => c.slug)).toEqual([other, slug]);
  });

  it('снимок новее того, что знали, — побеждает снимок', () => {
    useDmStore
      .getState()
      .applyActivity({ slug, ts: 100, preview: 'привет', previewMine: false, peer });
    useDmStore
      .getState()
      .setConversations([{ slug, peer, lastTs: 400, preview: 'уже другое', previewMine: true }]);
    expect(useDmStore.getState().conversations[0].preview).toBe('уже другое');
    expect(useDmStore.getState().activity[slug]).toBe(400);
  });
});

describe('remember() открытой переписки', () => {
  it('сохраняет активность беседы, а не только её карточку', () => {
    // Беседу открыли не с пустого места — в ней уже была история (lastTs>0).
    // Если remember не заводит `activity` так же, как setConversations,
    // unreadIn будет молчать про непрочитанное, пока не придёт живая реплика.
    useDmStore
      .getState()
      .remember({ slug, peer, lastTs: 700, preview: 'было', previewMine: false });
    expect(useDmStore.getState().activity[slug]).toBe(700);
  });

  it('не подвигает список: беседа встаёт по времени, а не поверх всех', () => {
    useDmStore.getState().setConversations([
      {
        slug: 'dm-aaaaaaaaaaaaaaaaaaaaaaaa',
        peer: { fingerprint: 'fp-a', nick: 'а' },
        lastTs: 900,
        preview: 'свежее',
        previewMine: false,
      },
    ]);
    useDmStore
      .getState()
      .remember({ slug, peer, lastTs: 500, preview: 'старое', previewMine: false });
    const order = useDmStore.getState().conversations.map((c) => c.slug);
    expect(order).toEqual(['dm-aaaaaaaaaaaaaaaaaaaaaaaa', slug]);
  });
});

describe('unreadIn', () => {
  it('активность новее отметки чтения — непрочитано', () => {
    useDmStore
      .getState()
      .setConversations([{ slug, peer, lastTs: 100, preview: 'привет', previewMine: false }]);
    useUnreadStore.setState({ lastRead: {} });
    expect(unreadIn(slug)).toBe(true);
  });

  it('дочитанная отметка гасит непрочитанное', () => {
    useDmStore
      .getState()
      .setConversations([{ slug, peer, lastTs: 100, preview: 'привет', previewMine: false }]);
    useUnreadStore.setState({ lastRead: { [slug]: 100 } });
    expect(unreadIn(slug)).toBe(false);
  });

  it('открытая через remember старая переписка остаётся непрочитанной до отметки', () => {
    // Тот же сценарий, что и в describe выше, но с той стороны, ради которой
    // unreadIn вообще существует: без сидирования activity в remember() эта
    // проверка вернула бы false — беседа выглядела бы прочитанной, хотя её
    // никто не открывал на этом устройстве.
    useDmStore
      .getState()
      .remember({ slug, peer, lastTs: 500, preview: 'было давно', previewMine: false });
    expect(unreadIn(slug)).toBe(true);
  });
});

/**
 * Обрыв на полуслове — не отзыв прав.
 *
 * Живой разбор (Atlas-70, 8 сентября): сокет пересоздавался трижды за
 * тринадцать минут, `dm-list` остался без ответа, и раздел встал на «Не
 * удалось получить список переписок» до самого конца этой чехарды. Список
 * держит не только сам раздел, но и лица в рейке тулбара, так что «ЛС не
 * работает совсем» — это ровно оно.
 *
 * Разницы между «сервер отказал» и «ответ не доехал» у события с
 * подтверждением нет вовсе: у socket.io ack потерянного сокета не приходит
 * никогда, а `perimeter.allow` — токен-бакет, и его отказ приезжает тем же
 * `forbidden`, что и настоящий запрет. Поэтому единственный честный ответ на
 * первую неудачу — спросить ещё раз, а не рисовать приговор.
 */
describe('reload(): неудача — повод переспросить, а не сдаться', () => {
  it('оставшись без ответа, спрашивает список заново', async () => {
    vi.useFakeTimers();
    useDmStore.getState().reload();
    expect(emit).toHaveBeenCalledTimes(1);

    // Сокет умер на полуслове: подтверждения не будет никогда.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(emit.mock.calls.length).toBeGreaterThan(1);
  });

  it('отказ лимитера тоже переспрашивается: он временный', async () => {
    vi.useFakeTimers();
    useDmStore.getState().reload();
    answerLast({ ok: false, error: 'forbidden' });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(emit.mock.calls.length).toBeGreaterThan(1);
  });

  it('пока повторы не исчерпаны, про отказ не врёт', () => {
    vi.useFakeTimers();
    useDmStore.getState().reload();
    answerLast({ ok: false, error: 'forbidden' });

    expect(useDmStore.getState().failed).toBe(false);
  });

  it('исчерпав повторы, признаёт неудачу — кнопке «Ещё раз» есть что чинить', async () => {
    vi.useFakeTimers();
    useDmStore.getState().reload();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(useDmStore.getState().failed).toBe(true);
    expect(useDmStore.getState().loading).toBe(false);
  });

  it('дождавшись списка, повторов не заводит', async () => {
    vi.useFakeTimers();
    useDmStore.getState().reload();
    answerLast({ ok: true, conversations: [] });

    await vi.advanceTimersByTimeAsync(300_000);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(useDmStore.getState().failed).toBe(false);
  });
});
