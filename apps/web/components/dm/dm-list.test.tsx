// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DmList } from './DmList';
import { useDmStore } from '@/stores/dm';
import { useUnreadStore } from '@/stores/unread';

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

  it('рисует лицо, ник, превью и счётчик непрочитанного', () => {
    useDmStore.getState().setConversations([
      {
        slug,
        peer: { fingerprint: 'fp-ты', nick: 'ты' },
        lastTs: 1000,
        preview: 'привет',
        previewMine: false,
      },
    ]);
    useUnreadStore.setState({ lastRead: {} });

    const out = markup();
    expect(out).toContain('ты');
    expect(out).toContain('привет');
    expect(host.querySelector('[data-testid="dm-unread"]')).toBeTruthy();
  });

  it('пустое состояние говорит, что здесь пока никого', () => {
    useDmStore.getState().reset();
    const out = markup();
    expect(/пока никого|no one here yet/i.test(out)).toBe(true);
  });
});
