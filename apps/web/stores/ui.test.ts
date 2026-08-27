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

  it('выбранная переписка НЕ сворачивает список', () => {
    // Панель со списком стоит справа и каналов собой не подменяет — сворачивать
    // её на каждый выбор незачем: ходить по перепискам подряд человек будет
    // чаще, чем открывать их по одной. Раньше она закрывалась сама, и следующая
    // беседа стоила ещё двух кликов.
    useUiStore.getState().toggleDmSection();
    useUiStore.getState().openDm('dm-0123456789abcdef01234567', 'fp-ты', 'ты');
    const s = useUiStore.getState();
    expect(s.dmSection).toBe(true);
    expect(s.view).toBe('dm');
    expect(s.dmRoom).toBe('dm-0123456789abcdef01234567');
  });

  it('беседа, открытая при свёрнутом списке, его не разворачивает', () => {
    // Лицо в рейке и облачко зовут тот же `openDm`: там список не спрашивали,
    // и выезжать ему навстречу человеку, который просил одну переписку, нечего.
    useUiStore.getState().openDm('dm-0123456789abcdef01234567', 'fp-ты', 'ты');
    expect(useUiStore.getState().dmSection).toBe(false);
  });

  it('showDmList разворачивает список, сколько раз его ни позови', () => {
    // Шаг назад из беседы и язычок свёрнутой панели зовут именно его: тумблер
    // на их месте закрыл бы список ровно тогда, когда его просили показать.
    useUiStore.getState().showDmList();
    expect(useUiStore.getState().dmSection).toBe(true);
    useUiStore.getState().showDmList();
    expect(useUiStore.getState().dmSection).toBe(true);
    expect(useUiStore.getState().mobilePanel).toBe('nav');
  });

  it('вход в канал уводит панель ЛС с экрана', () => {
    // То, ради чего панель вообще умеет уезжать: канал занимает сцену целиком,
    // и список поверх него — чужая полоса на чужом экране.
    useUiStore.getState().showDmList();
    useUiStore.getState().openText('obshchii', 'общий');
    expect(useUiStore.getState().dmSection).toBe(false);
  });
});

describe('беседа и звонок', () => {
  const slug = 'dm-0123456789abcdef01234567';

  it('звонок не закрывает переписку, а отбой к ней возвращает', () => {
    // С текстовым каналом так было всегда; беседа же обнулялась, и человек,
    // сходивший в голосовой канал из переписки, терял её дважды: сразу — со
    // сцены, и после отбоя — оказываясь в лобби вместо собеседника.
    useUiStore.getState().openDm(slug, '6668-7aad-f862-bd77', 'Марта');
    useUiStore.getState().openVoice('kuhnya', 'кухня');

    let s = useUiStore.getState();
    expect(s.view).toBe('voice');
    expect(s.dmRoom).toBe(slug);

    useUiStore.getState().clearVoice();
    s = useUiStore.getState();
    expect([s.view, s.dmRoom, s.textRoom]).toEqual(['dm', slug, null]);
  });

  it('без открытой ленты отбой по-прежнему ведёт в лобби', () => {
    useUiStore.getState().openVoice('kuhnya', 'кухня');
    useUiStore.getState().clearVoice();
    const s = useUiStore.getState();
    expect([s.view, s.dmRoom, s.textRoom]).toEqual(['lobby', null, null]);
  });
});
