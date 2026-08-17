// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginError, type Identity } from '@/lib/identity-login';
import { SignerError } from '@/lib/signer';
import { useIdentityStore } from './identity';
import { useUiStore } from './ui';

/**
 * Восстановление личности. Проверяется не «зовётся ли fetch», а три решения,
 * которые этот стор принимает за человека:
 *
 *   — когда его вообще спрашивать об имени (только если личность родилась
 *     прямо сейчас, и решает это сервер, а не метка в хранилище);
 *   — когда занимать собой весь экран, а когда обойтись строчкой (беда,
 *     которую чинит человек, против беды, которую чинит повтор);
 *   — что показывать в панели, если сервер имя не принял.
 */

// Сокет: стору от него нужно ровно одно — сказать гейтвею, что имя сменилось.
const emit = vi.fn();
vi.mock('@/lib/socket', () => ({ getSocket: () => ({ connected: true, emit }) }));

vi.mock('@/lib/identity-login', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/identity-login')>()),
  whoAmI: vi.fn(),
  proveIdentity: vi.fn(),
  renameIdentity: vi.fn(),
}));

const { proveIdentity, renameIdentity, whoAmI } = await import('@/lib/identity-login');
const said = {
  who: vi.mocked(whoAmI),
  prove: vi.mocked(proveIdentity),
  rename: vi.mocked(renameIdentity),
};

function person(over: Partial<Identity> = {}): Identity {
  return {
    id: 'i-1',
    publicKey: 'A'.repeat(43),
    fingerprint: '6668-7aad-f862-bd77',
    nick: 'Аня',
    device: { id: 'd-1', name: 'Chrome · macOS' },
    created: false,
    ...over,
  };
}

const s = () => useIdentityStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  useIdentityStore.setState({ status: 'checking', me: null, failure: null });
  useUiStore.setState({ callsign: '' });
});

describe('узнавание', () => {
  it('сессия жива — входим молча, ничего не спрашивая', async () => {
    said.who.mockResolvedValue(person());
    await s().restore();

    expect(s().status).toBe('in');
    expect(said.prove).not.toHaveBeenCalled();
    // Ник уезжает в UI-стор: сокет, чат и состав знают человека по нему.
    expect(useUiStore.getState().callsign).toBe('Аня');
  });

  it('сессии нет — доказываем ключом, человека не трогая', async () => {
    // Так выглядит любой заход после рестарта api: сессии живут в его памяти.
    said.who.mockResolvedValue(null);
    said.prove.mockResolvedValue(person({ created: false }));
    await s().restore();

    expect(s().status).toBe('in');
    expect(said.prove).toHaveBeenCalledOnce();
  });

  it('личность родилась прямо сейчас — вот теперь спрашиваем имя', async () => {
    said.who.mockResolvedValue(null);
    said.prove.mockResolvedValue(person({ created: true, nick: '6668' }));
    await s().restore();

    expect(s().status).toBe('naming');
    // Человек уже внутри: имя — подпись к ключу, а не пропуск. До ответа он
    // зовётся куском своего отпечатка, и это честнее выдумки.
    expect(s().me?.nick).toBe('6668');
  });

  it('две попытки сразу — одна: строгий режим зовёт эффект дважды', async () => {
    // Иначе второй заход выпросил бы второй нонс и завёл второе устройство.
    said.who.mockResolvedValue(person());
    await Promise.all([s().restore(), s().restore()]);
    expect(said.who).toHaveBeenCalledOnce();
  });
});

describe('беды', () => {
  it('ключа нет — это экран целиком, и причина в нём та самая', async () => {
    said.who.mockRejectedValue(
      new LoginError({ kind: 'signer', error: new SignerError('no-storage', 'приватный режим') }),
    );
    await s().restore();

    expect(s().status).toBe('failed');
    expect(s().failure).toMatchObject({ kind: 'signer', error: { reason: 'no-storage' } });
  });

  it('обрыв сети — тоже экран, но починка в нём одна: повторить', async () => {
    // fetch при обрыве отвергает промис, а не отдаёт ответ, — сюда попадает и он.
    said.who.mockRejectedValue(new TypeError('Failed to fetch'));
    await s().restore();
    expect(s().failure).toEqual({ kind: 'network' });
  });

  it('повтор после беды начинается с чистого листа', async () => {
    said.who.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await s().restore();
    said.who.mockResolvedValue(person());
    await s().restore();

    expect(s().status).toBe('in');
    expect(s().failure).toBeNull();
  });
});

describe('имя на первом входе', () => {
  beforeEach(() => {
    useIdentityStore.setState({ status: 'naming', me: person({ nick: '6668' }) });
  });

  it('принято — входим под ним, и вычищенное сервером важнее набранного', async () => {
    said.rename.mockResolvedValue('Аня-Б');
    expect(await s().name(' @Аня Б ')).toBe(true);

    expect(s().status).toBe('in');
    expect(s().me?.nick).toBe('Аня-Б');
    expect(useUiStore.getState().callsign).toBe('Аня-Б');
  });

  it('гейтвей узнаёт имя сразу, а не со следующего подключения', async () => {
    // Иначе первые реплики только что назвавшегося человека подписаны его
    // автоником: сокет подключился раньше, чем у личности появилось имя.
    said.rename.mockResolvedValue('Аня');
    await s().name('Аня');
    expect(emit).toHaveBeenCalledWith('rename', { name: 'Аня' });
  });

  it('сервер не ответил — остаёмся на том же экране', async () => {
    // Выкидывать отсюда некуда: человек уже вошёл, а починка — нажать ещё раз.
    said.rename.mockRejectedValue(new LoginError({ kind: 'network', status: 502 }));
    expect(await s().name('Аня')).toBe(false);

    expect(s().status).toBe('naming');
    expect(s().failure).toEqual({ kind: 'network', status: 502 });
    // И гейтвею говорить нечего: имя не сохранилось.
    expect(emit).not.toHaveBeenCalled();
  });

  it('пропуск на инсталляцию протух — это уже экран беды', async () => {
    // Здесь повтором не поможешь: человеку идти на /login.
    said.rename.mockRejectedValue(new LoginError({ kind: 'gate' }));
    await s().name('Аня');
    expect(s().status).toBe('failed');
  });
});

describe('смена имени потом', () => {
  beforeEach(() => {
    useIdentityStore.setState({ status: 'in', me: person() });
    useUiStore.setState({ callsign: 'Аня' });
  });

  it('отказ не выдаётся за успех и не роняет сессию', async () => {
    said.rename.mockRejectedValue(new LoginError({ kind: 'network', status: 500 }));
    expect(await s().rename('Борис')).toBe(false);

    expect(s().status).toBe('in');
    expect(s().me?.nick).toBe('Аня');
  });

  it('личности ещё нет — переименовывать нечего', async () => {
    useIdentityStore.setState({ me: null });
    expect(await s().rename('Борис')).toBe(false);
    expect(said.rename).not.toHaveBeenCalled();
  });
});
