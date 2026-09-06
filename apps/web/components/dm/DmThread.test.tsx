// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaults } from '@relay/shared';
import { dialCall } from '@/lib/call';
import { DmThread } from './DmThread';
import { shortFingerprint } from '@/lib/format';
import { useChatStore } from '@/stores/chat';
import { useUiStore } from '@/stores/ui';
import { usePresenceStore } from '@/stores/presence';
import { useConfigStore } from '@/stores/config';

/** Тот же приём, что у `DmPeerCard.test.tsx`: подделан `lib/call.ts`, не `stores/ring.ts`. */
vi.mock('@/lib/call', () => ({
  dialCall: vi.fn(async () => ({ ok: true, ringId: 'r1' })),
  hangUp: vi.fn(),
}));

/**
 * `ChatPanel` (внутри `DmThread`) спрашивает срок хранения через `/api/config`
 * — в jsdom это настоящий сетевой запрос без сервера на том конце, который
 * рано или поздно отвечает отказом и обновляет стейт уже после того, как тест
 * снял свой `act()`. Стор ЛС тут ни при чём — это существующее поведение
 * ChatPanel, у которого до этой задачи не было ни одного теста; заменяем хук
 * синхронной заглушкой, чтобы не гонять настоящую сеть и не шуметь предупреждениями.
 */
vi.mock('@/lib/use-sfu', () => ({ useRetention: () => ({ days: 0, mode: 'forever' as const }) }));

/**
 * `DmThread` не заводит вторую ленту: `ChatPanel` внутри читает те же стор и
 * события, что и у текстового канала (см. его комментарий про «канал или
 * беседа»). Здесь проверяем только то, что добавляет обёртка, — шапку
 * собеседника и честную строку про приватность снизу.
 *
 * Ник и отпечаток — из stores/dm-list.test.tsx: настоящая форма отпечатка, не
 * подстрока ника ни в одну сторону, иначе проверка второго поля прошла бы и
 * без него на экране.
 */
const fingerprint = '6668-7aad-f862-bd77';
const nick = 'Марта';
const slug = 'dm-0123456789abcdef01234567';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function markup(): string {
  act(() => root.render(<DmThread />));
  return host.innerHTML;
}

describe('шапка беседы', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // jsdom не реализует scrollTo — ChatPanel зовёт его в эффекте, который
    // ставит свежую беседу на дно ленты (нет своего теста на ChatPanel, где
    // это уже было бы решено, см. отчёт к задаче).
    Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {});
    useUiStore.setState({
      view: 'dm',
      textRoom: null,
      textLabel: nick,
      dmRoom: slug,
      dmPeer: fingerprint,
      dmSection: true,
    });
    useChatStore.getState().reset();
    usePresenceStore.getState().reset();
    useConfigStore.setState({ settings: defaults() });
    vi.mocked(dialCall).mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('шапка беседы показывает лицо, ник и короткий отпечаток', () => {
    const out = markup();
    // Лицо — Identicon рисует svg; без него проверка ника и отпечатка ничего
    // не говорит о том, нарисовано ли лицо вообще.
    expect(host.querySelector('svg')).toBeTruthy();
    expect(out).toContain(nick);
    expect(out).toContain(shortFingerprint(fingerprint));
  });

  it('внизу сказано, что переписку видит владелец сервера', () => {
    const out = markup();
    expect(/владел|owner/i.test(out)).toBe(true);
  });

  it('статус в шапке — из глобального стора присутствия, а не заглушка', () => {
    usePresenceStore.getState().applySnapshot([{ fingerprint, state: 'in-voice', since: 1000 }]);
    const out = markup();
    expect(/in a call|в голосе/i.test(out)).toBe(true);
  });

  it('своя кнопка звонка в шапке — подстраховка на случай, когда карточка собеседника скрыта', () => {
    // Задача 6: карточка справа (`DmPeerCard`) гаснет на узком десктопе, пока
    // раскрыт док ЛС, а эта шапка — нет (см. её собственный комментарий).
    markup();
    const button = host.querySelector('button') as HTMLButtonElement;
    expect(button).toBeTruthy();
    expect(button.getAttribute('aria-disabled')).toBeNull();
    act(() => button.click());
    expect(dialCall).toHaveBeenCalledWith(fingerprint, false);
  });

  it('`calls.enabled: false` гасит кнопку звонка честной причиной, не HTML `disabled`', () => {
    useConfigStore.setState({ settings: { ...defaults(), 'calls.enabled': false } });
    const out = markup();
    const button = host.querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.disabled).toBe(false);
    expect(out).toMatch(/выключен|turned off/i);
    act(() => button.click());
    expect(dialCall).not.toHaveBeenCalled();
  });
});
