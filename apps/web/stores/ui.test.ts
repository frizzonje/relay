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
    useUiStore.getState().toggleDmSection();
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

  it('открытие канала из раздела ЛС гасит подсветку Direct', () => {
    // Раздел открыт (сайдбар подменён списком переписок), но тут же открыли
    // обычный текстовый канал — сайдбар вернулся к каналам, и тулбару больше
    // нечего подсвечивать: он рисует не сцену, а именно `dmSection`.
    useUiStore.getState().toggleDmSection();
    useUiStore.getState().openText('obshchii', 'общий');
    expect(useUiStore.getState().dmSection).toBe(false);
  });

  it('повторное нажатие сворачивает раздел обратно к каналам', () => {
    // Одна и та же кнопка ведёт в обе стороны. Без этого раздел ЛС был бы
    // ловушкой: список переписок подменяет собой каналы, и не будь обратного
    // хода, вернуться к ним из ЛС было бы нечем.
    useUiStore.getState().toggleDmSection();
    expect(useUiStore.getState().dmSection).toBe(true);
    useUiStore.getState().toggleDmSection();
    expect(useUiStore.getState().dmSection).toBe(false);
  });

  it('выбранная переписка сворачивает список — каналы возвращаются', () => {
    // Беседа уезжает на сцену, а сайдбар отдаётся обратно каналам: иначе
    // человек, открывший переписку, остаётся без единого канала на экране.
    useUiStore.getState().toggleDmSection();
    useUiStore.getState().openDm('dm-0123456789abcdef01234567', 'fp-ты', 'ты');
    const s = useUiStore.getState();
    expect(s.dmSection).toBe(false);
    expect(s.view).toBe('dm');
    expect(s.dmRoom).toBe('dm-0123456789abcdef01234567');
  });
});
