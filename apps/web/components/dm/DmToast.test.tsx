// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { showDmToast } from './DmToast';

/**
 * Находка ревью задачи 8: `dm-activity` для отметки о пропущенном звонке
 * несёт в `preview` непереведённую серверную запаску (`ChatMessage.call` в
 * протоколе, буквально «missed call»), а облачко рисовало её как есть — то
 * есть по-английски вне зависимости от языка читающего, хотя сама отметка в
 * ленте (`MissedCallMark`) уже переведена. Тест ловит именно расхождение
 * облачка с лентой, а не наличие текста вообще: без починки он видит ровно
 * ту английскую строку, которую сервер записал в базу.
 *
 * `Toaster` рендерится по-настоящему (без портала, sonner кладёт разметку
 * туда же, где смонтирован сам компонент) — тем же приёмом прямого DOM, что и
 * в dm-list.test.tsx. sonner подписывается на очередь тостов в `useEffect` и
 * применяет каждый через `setTimeout(…, 0)` + `flushSync` (см. её исходник) —
 * без ожидания этого макротаска `act()` фиксирует состояние ДО подписки, и
 * DOM остаётся пустым независимо от того, работает подпись или нет.
 */

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

/** Отдать очередь macrotask'ам, в один из которых sonner кладёт свой toast. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Toaster />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('облачко о пропущенном звонке', () => {
  it('переводит подпись, а не показывает серверную запаску', async () => {
    act(() => {
      showDmToast({
        slug: 'dm-0123456789abcdef01234567',
        ts: Date.now(),
        preview: 'missed call',
        previewMine: false,
        peer: { fingerprint: '6668-7aad-f862-bd77', nick: 'Марта' },
        call: { state: 'no-answer', ms: 5000 },
      });
    });
    await flush();

    // Локаль тестов — en по умолчанию (DEFAULT_LOCALE): «Missed call», а не
    // «missed call» из базы — регистр и есть разница между переводом и
    // серверной запаской, раз слова совпадают.
    expect(host.textContent).toContain('Missed call');
    expect(host.textContent).not.toContain('missed call');
  });

  it('своему звонку — «You called», а не «Missed call»', async () => {
    // На практике облачко своей же реплики не показывает (см.
    // `!relay.previewMine` в SocketProvider), но подпись сверяет `previewMine`
    // сама и не должна полагаться на то, что вызывающий код её отфильтрует.
    act(() => {
      showDmToast({
        slug: 'dm-0123456789abcdef01234567',
        ts: Date.now(),
        preview: 'missed call',
        previewMine: true,
        peer: { fingerprint: '6668-7aad-f862-bd77', nick: 'Марта' },
        call: { state: 'failed', ms: 0 },
      });
    });
    await flush();

    expect(host.textContent).toContain('You called');
    expect(host.textContent).not.toContain('Missed call');
  });

  it('обычная реплика по-прежнему рисует превью как есть', async () => {
    act(() => {
      showDmToast({
        slug: 'dm-0123456789abcdef01234567',
        ts: Date.now(),
        preview: 'привет!',
        previewMine: false,
        peer: { fingerprint: '6668-7aad-f862-bd77', nick: 'Марта' },
      });
    });
    await flush();

    expect(host.textContent).toContain('привет!');
  });
});
