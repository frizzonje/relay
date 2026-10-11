// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/config', () => ({ useSetting: () => undefined }));

import { I18nProvider, useLocale } from './index';
import { LOCALE_COOKIE } from './config';

/**
 * Кука языка читается после монтирования, во время рендера провайдера. Битая
 * кодировка в ней (руками, расширением, обрезанным заголовком) не должна ронять
 * всё дерево: такая кука — просто «язык не выбран».
 */
describe('locale cookie', () => {
  afterEach(() => {
    document.cookie = `${LOCALE_COOKIE}=; max-age=0`;
    document.body.innerHTML = '';
  });

  it('a malformed cookie falls back instead of crashing the tree', () => {
    document.cookie = `${LOCALE_COOKIE}=%E0%A4`;
    let seen = '';
    function Probe() {
      seen = useLocale();
      return null;
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <I18nProvider locale="en">
          <Probe />
        </I18nProvider>,
      ),
    );
    expect(seen).toBe('en');
    act(() => root.unmount());
  });
});
