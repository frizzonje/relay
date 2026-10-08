import { describe, expect, it, vi } from 'vitest';

const answers = vi.hoisted(() => ({ pending: [] as ((owner: boolean) => void)[] }));
vi.mock('@/lib/owner', () => ({
  amIOwner: vi.fn(() => new Promise<boolean>((resolve) => answers.pending.push(resolve))),
}));

import { useOwnerStore } from './owner';

describe('владелец ли я', () => {
  it('запоздавший ответ на старый вопрос не затирает свежий', async () => {
    // Вход спросил «владелец?» и ждёт; тем временем человек взял власть по
    // ссылке, и второй вопрос ответил «да» раньше первого.
    const onEntry = useOwnerStore.getState().refresh();
    const afterClaim = useOwnerStore.getState().refresh();
    answers.pending[1](true);
    await afterClaim;
    answers.pending[0](false);
    await onEntry;
    expect(useOwnerStore.getState().owner).toBe(true);
  });
});
