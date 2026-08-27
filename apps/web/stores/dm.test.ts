import { beforeEach, describe, expect, it } from 'vitest';
import { unreadIn, useDmStore } from './dm';
import { useUnreadStore } from './unread';

const peer = { fingerprint: 'fp-ты', nick: 'ты' };
const slug = 'dm-0123456789abcdef01234567';

beforeEach(() => {
  useDmStore.getState().reset();
  useUnreadStore.setState({ lastRead: {} });
});

describe('список переписок', () => {
  it('свежая реплика поднимает беседу наверх', () => {
    useDmStore.getState().setConversations([
      { slug: 'dm-aaaaaaaaaaaaaaaaaaaaaaaa', peer: { fingerprint: 'fp-a', nick: 'а' }, lastTs: 200, preview: 'ага', previewMine: false },
      { slug, peer, lastTs: 100, preview: 'привет', previewMine: false },
    ]);

    useDmStore.getState().applyActivity({ slug, ts: 300, preview: 'ты тут?', previewMine: false, peer });

    const list = useDmStore.getState().conversations;
    expect(list.map((c) => c.slug)).toEqual([slug, 'dm-aaaaaaaaaaaaaaaaaaaaaaaa']);
    expect(list[0].preview).toBe('ты тут?');
    expect(useDmStore.getState().activity[slug]).toBe(300);
  });

  it('реплика из беседы, которой нет в списке, заводит её', () => {
    useDmStore.getState().applyActivity({ slug, ts: 42, preview: 'привет', previewMine: false, peer });
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
    useDmStore.getState().setConversations([{ slug, peer, lastTs: 500, preview: 'позже', previewMine: false }]);
    useDmStore.getState().applyActivity({ slug, ts: 100, preview: 'раньше', previewMine: false, peer });
    expect(useDmStore.getState().conversations[0].preview).toBe('позже');
  });
});

describe('remember() открытой переписки', () => {
  it('сохраняет активность беседы, а не только её карточку', () => {
    // Беседу открыли не с пустого места — в ней уже была история (lastTs>0).
    // Если remember не заводит `activity` так же, как setConversations,
    // unreadIn будет молчать про непрочитанное, пока не придёт живая реплика.
    useDmStore.getState().remember({ slug, peer, lastTs: 700, preview: 'было', previewMine: false });
    expect(useDmStore.getState().activity[slug]).toBe(700);
  });

  it('не подвигает список: беседа встаёт по времени, а не поверх всех', () => {
    useDmStore.getState().setConversations([
      { slug: 'dm-aaaaaaaaaaaaaaaaaaaaaaaa', peer: { fingerprint: 'fp-a', nick: 'а' }, lastTs: 900, preview: 'свежее', previewMine: false },
    ]);
    useDmStore.getState().remember({ slug, peer, lastTs: 500, preview: 'старое', previewMine: false });
    const order = useDmStore.getState().conversations.map((c) => c.slug);
    expect(order).toEqual(['dm-aaaaaaaaaaaaaaaaaaaaaaaa', slug]);
  });
});

describe('unreadIn', () => {
  it('активность новее отметки чтения — непрочитано', () => {
    useDmStore.getState().setConversations([{ slug, peer, lastTs: 100, preview: 'привет', previewMine: false }]);
    useUnreadStore.setState({ lastRead: {} });
    expect(unreadIn(slug)).toBe(true);
  });

  it('дочитанная отметка гасит непрочитанное', () => {
    useDmStore.getState().setConversations([{ slug, peer, lastTs: 100, preview: 'привет', previewMine: false }]);
    useUnreadStore.setState({ lastRead: { [slug]: 100 } });
    expect(unreadIn(slug)).toBe(false);
  });

  it('открытая через remember старая переписка остаётся непрочитанной до отметки', () => {
    // Тот же сценарий, что и в describe выше, но с той стороны, ради которой
    // unreadIn вообще существует: без сидирования activity в remember() эта
    // проверка вернула бы false — беседа выглядела бы прочитанной, хотя её
    // никто не открывал на этом устройстве.
    useDmStore.getState().remember({ slug, peer, lastTs: 500, preview: 'было давно', previewMine: false });
    expect(unreadIn(slug)).toBe(true);
  });
});
