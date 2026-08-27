import { beforeEach, describe, expect, it } from 'vitest';
import { useUiStore } from './ui';

beforeEach(() => {
  useUiStore.setState({
    view: 'lobby',
    textRoom: null,
    textLabel: '',
    pendingScene: null,
    stageLive: false,
    dmSection: false,
    dmRoom: null,
    dmPeer: null,
  });
});

describe('раздел ЛС', () => {
  it('открывается без выбранной переписки', () => {
    useUiStore.getState().openDmSection();
    expect(useUiStore.getState().dmSection).toBe(true);
    expect(useUiStore.getState().dmRoom).toBe(null);
    // Сцена пока прежняя: раздел открыт, переписка не выбрана.
    expect(useUiStore.getState().view).toBe('lobby');
  });

  it('переписка становится сценой', () => {
    useUiStore.getState().openDm('dm-0123456789abcdef01234567', 'fp-ты', 'ты');
    const s = useUiStore.getState();
    expect(s.view).toBe('dm');
    expect(s.dmRoom).toBe('dm-0123456789abcdef01234567');
    expect(s.dmPeer).toBe('fp-ты');
    expect(s.textLabel).toBe('ты');
    expect(s.mobilePanel).toBe('stage');
  });

  it('выход из раздела возвращает в лобби и забывает переписку', () => {
    useUiStore.getState().openDm('dm-0123456789abcdef01234567', 'fp-ты', 'ты');
    useUiStore.getState().leaveDm();
    const s = useUiStore.getState();
    expect(s.dmSection).toBe(false);
    expect(s.dmRoom).toBe(null);
    expect(s.view).toBe('lobby');
  });
});
