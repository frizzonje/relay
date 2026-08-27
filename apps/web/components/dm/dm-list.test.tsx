// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DmList } from './DmList';
import { shortFingerprint } from '@/lib/format';
import { useDmStore } from '@/stores/dm';
import { useUnreadStore } from '@/stores/unread';
import { useUiStore } from '@/stores/ui';

/**
 * Список переписок рисуется из `useDmStore`, а непрочитанное — из сверки его
 * `activity` с отметками чтения `useUnreadStore` (см. `unreadIn` в
 * stores/dm.ts). Тест смотрит именно на этот стык: без него список выглядел
 * бы правильным и на глаз ничем не отличался бы от рабочего, пока непрочитанное
 * не разъехалось бы с текстовыми каналами по формату отметки.
 *
 * Рендерим по-настоящему, в DOM (как в components/layout/members-face.test.tsx),
 * а не строкой с сервера: серверный рендер отдаёт zustand НАЧАЛЬНОЕ состояние
 * (иначе гидрация ловила бы расхождение), и разложенный тестом стор до
 * разметки бы не доехал. `screen`/`render` из testing-library в проекте не
 * заведены — запросы к разметке идут напрямую по DOM, тем же приёмом, что и в
 * соседних тестах компонентов.
 */

const slug = 'dm-0123456789abcdef01234567';

/**
 * Настоящая форма отпечатка (шестнадцатеричные группы, как в
 * stores/identity.test.ts) — не `'fp-ты'` из прежней версии теста. У той
 * строки `shortFingerprint` не находит ни одной hex-группы и возвращает вход
 * без изменений, так что `'fp-ты'` сама СОДЕРЖИТ `'ты'`: проверка проходила бы
 * и без отпечатка на экране, и без ника — алиас между полями делал тест
 * бесполезным. Ник и короткий отпечаток ниже подобраны так, чтобы не быть
 * подстрокой друг друга ни в одну сторону.
 */
const fingerprint = '6668-7aad-f862-bd77';
const nick = 'Марта';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function markup(): string {
  act(() => root.render(<DmList />));
  return host.innerHTML;
}

describe('список переписок', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useDmStore.getState().reset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('рисует лицо, ник, отпечаток, превью и счётчик непрочитанного', () => {
    useDmStore.getState().setConversations([
      {
        slug,
        peer: { fingerprint, nick },
        lastTs: 1000,
        preview: 'привет',
        previewMine: false,
      },
    ]);
    useUnreadStore.setState({ lastRead: {} });

    const out = markup();
    expect(out).toContain(nick);
    // Именно рендер короткого отпечатка, а не подстрока, которую мог бы дать
    // и один только ник, — см. комментарий у фикстур выше.
    expect(out).toContain(shortFingerprint(fingerprint));
    expect(out).toContain('привет');
    expect(host.querySelector('[data-testid="dm-unread"]')).toBeTruthy();
  });

  it('пустое состояние говорит, что здесь пока никого', () => {
    useDmStore.getState().reset();
    const out = markup();
    expect(/пока никого|no one here yet/i.test(out)).toBe(true);
  });
});

describe('пока список не доехал', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useDmStore.getState().reset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('пока идёт запрос, «переписок нет» не утверждаем', () => {
    useDmStore.setState({ conversations: [], loading: true, failed: false });
    const html = markup();
    // Пустое состояние — утверждение о данных человека; на холодной загрузке
    // оно вспыхивало до первого ответа сервера и было просто неправдой.
    expect(html).not.toMatch(/пока никого|No conversations/i);
    expect(html).toMatch(/Получаем|Loading/i);
  });

  it('ответа не пришло — предлагаем повторить, а не врём про пустоту', () => {
    useDmStore.setState({ conversations: [], loading: false, failed: true });
    const html = markup();
    expect(html).not.toMatch(/пока никого|No conversations/i);
    expect(html).toMatch(/Ещё раз|Try again/i);
  });

  it('список приехал пустым — вот теперь переписок правда нет', () => {
    useDmStore.setState({ conversations: [], loading: false, failed: false });
    expect(markup()).toMatch(/пока никого|No conversations/i);
  });
});

describe('выход из раздела на телефоне', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useDmStore.getState().reset();
    useUiStore.setState({ dmSection: true, view: 'lobby', dmRoom: null, pendingScene: null });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('шеврон в шапке возвращает к каналам', () => {
    // Полоса тулбара уехала внутрь сайдбара (кадр 2a референса), и на этом
    // экране её нет — кроме шеврона выйти отсюда нечем.
    markup();
    const back = [...host.querySelectorAll('button')].find((b) =>
      /назад|back/i.test(b.getAttribute('aria-label') ?? ''),
    );
    expect(back).toBeTruthy();
    act(() => back!.click());
    expect(useUiStore.getState().dmSection).toBe(false);
  });
});
