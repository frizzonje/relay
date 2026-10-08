// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaults } from '@relay/shared';
import { MaintenanceGate } from './MaintenanceGate';
import { MessageAttachment } from '@/components/chat/MessageAttachment';
import { useConfigStore } from '@/stores/config';
import { useContractStore } from '@/stores/contract';

/**
 * Два параметра каталога, которые действуют только на экране, — и оба до сих
 * пор не действовали нигде. Проверяется здесь не разметка, а то, ради чего они
 * заведены: закрытая на обслуживание инсталляция ОБЪЯСНЯЕТ себя, а выключенные
 * превью перестают раскрывать картинку в ленте.
 */

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function show(node: React.ReactElement) {
  act(() => root.render(node));
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useContractStore.setState({ maintenance: null });
  useConfigStore.setState({ settings: defaults() });
});

/** Диалог рисуется порталом — искать надо по всему документу, а не в host. */
const said = () => document.querySelector('[data-testid="maintenance-message"]');

describe('обслуживание объясняет себя', () => {
  it('показывает то, что написал владелец', () => {
    // Текст приезжает вместе с отказом двери: снимок настроек ходит по сокету,
    // а у того, кого не пустили, сокета нет и не будет.
    act(() => useContractStore.getState().setMaintenance('Вернёмся к семи вечера'));
    show(<MaintenanceGate />);
    expect(said()?.textContent).toBe('Вернёмся к семи вечера');
  });

  it('без текста говорит своими словами, а не пустотой', () => {
    act(() => useContractStore.getState().setMaintenance(''));
    show(<MaintenanceGate />);
    expect((said()?.textContent ?? '').length).toBeGreaterThan(10);
  });

  it('пока обслуживания нет, экрана нет', () => {
    show(<MaintenanceGate />);
    expect(said()).toBeNull();
  });
});

describe('превью картинок', () => {
  const img = {
    url: '/uploads/a.png',
    name: 'кот.png',
    size: 1024,
    mime: 'image/png',
    kind: 'image' as const,
  };

  it('по умолчанию картинка раскрыта в ленте — как было всегда', () => {
    show(<MessageAttachment att={img} />);
    expect(host.querySelector('img')).not.toBeNull();
  });

  it('выключенные превью отдают картинку карточкой, а не запрещают её', () => {
    // Файл на месте и скачивается; изменилось одно — лента больше не
    // раскрывает его, не спросив.
    act(() => useConfigStore.getState().apply({ 'files.imagePreviews': false }));
    show(<MessageAttachment att={img} />);
    expect(host.querySelector('img')).toBeNull();
    const link = host.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/uploads/a.png');
    expect(host.textContent).toContain('кот.png');
  });
});
