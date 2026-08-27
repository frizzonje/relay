import { beforeEach, describe, expect, it } from 'vitest';
import { useDmStore } from './dm';

const peer = { fingerprint: 'fp-ты', nick: 'ты' };
const slug = 'dm-0123456789abcdef01234567';

beforeEach(() => useDmStore.getState().reset());

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
