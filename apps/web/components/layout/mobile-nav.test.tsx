// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileNav } from './MobileNav';
import { shortFingerprint } from '@/lib/format';
import { useUiStore } from '@/stores/ui';
import { usePresenceStore } from '@/stores/presence';

/**
 * Мобильная шапка в беседе. До этой задачи вида `dm` она не знала вовсе: ветки
 * заголовка кончались на `else`, и над личной перепиской стояла подпись
 * «состояние сервера» — из лобби.
 *
 * Проверяем то, что ловится в jsdom и ломается молча: заголовок называет
 * собеседника, статус под ним берётся из того же глобального стора
 * присутствия, что и десктопная шапка `DmThread`/карточка `DmPeerCard` (эта
 * шапка их заменяет на узком экране — см. комментарий у `MobileNav`, и до
 * ревью плана B они успели разъехаться: десктоп уже показывал живое
 * присутствие, а здесь всё ещё стояла заглушка «неизвестно»), кнопка звонка
 * остаётся достижимой (её НЕЛЬЗЯ выключать HTML-атрибутом `disabled` — см.
 * Toolbar и DmPeerCard: он уносит кнопку из обхода табом вместе с
 * единственным объяснением, почему она мертва), и шаг назад ведёт в список
 * переписок, а не к каналам.
 */

// Шапка тянет дирижёра звонка ради кнопок мини-бара. В беседе мини-бара нет
// вовсе, а импорт в jsdom потащил бы за собой весь медиастек.
vi.mock('@/lib/voice', () => ({
  toggleMic: () => {},
  leaveVoice: () => {},
  showVoiceStage: () => {},
}));

const fingerprint = '6668-7aad-f862-bd77';
const nick = 'Марта';
const slug = 'dm-0123456789abcdef01234567';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(): void {
  act(() => root.render(<MobileNav />));
}

function buttons(): HTMLButtonElement[] {
  return [...host.querySelectorAll('button')];
}

describe('мобильная шапка беседы', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useUiStore.setState({
      view: 'dm',
      textRoom: null,
      textLabel: nick,
      dmRoom: slug,
      dmPeer: fingerprint,
      dmSection: false,
      mobilePanel: 'stage',
      pendingScene: null,
      voiceRoom: null,
    });
    usePresenceStore.getState().reset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('называет собеседника, а не сервер', () => {
    render();
    expect(host.textContent).toContain(nick);
    // Отпечаток рядом с ником: карточки собеседника на телефоне нет, и это
    // единственное место, где два тёзки различимы.
    expect(host.textContent).toContain(shortFingerprint(fingerprint));
    // Без записи в сторе присутствия собеседник честно «не в сети» — как в
    // DmPeerCard/DmThread, не заглушка «неизвестно».
    expect(/не в сети|offline/i.test(host.textContent || '')).toBe(true);
    // Ровно тот заголовок, который стоял здесь до правки, — из лобби.
    expect(/состояние сервера|server status/i.test(host.textContent || '')).toBe(false);
  });

  it('живая запись в сторе присутствия меняет статус в шапке', () => {
    usePresenceStore.getState().applySnapshot([{ fingerprint, state: 'online', since: 1000 }]);
    render();
    expect(/в сети|online/i.test(host.textContent || '')).toBe(true);
    expect(/не в сети/i.test(host.textContent || '')).toBe(false);
  });

  it('кнопка звонка выключена, но достижима и объясняет себя', () => {
    render();
    const call = buttons().find((b) => b.getAttribute('aria-disabled') === 'true');
    expect(call).toBeTruthy();
    // То, чего делать нельзя: с HTML `disabled` кнопка выпадает из обхода
    // табом, и «скоро» до человека с клавиатурой не доходит вовсе.
    expect(call!.disabled).toBe(false);
    expect(call!.tabIndex).toBe(0);
    expect(call!.title).toMatch(/скоро|soon/i);
    expect(call!.getAttribute('aria-label')).toMatch(/скоро|soon/i);
  });

  it('шаг назад возвращает в список переписок, а не к каналам', () => {
    render();
    const back = buttons()[0];
    act(() => back.click());
    const state = useUiStore.getState();
    expect(state.dmSection).toBe(true);
    expect(state.mobilePanel).toBe('nav');
  });

  it('на экране каналов шапки нет вовсе', () => {
    useUiStore.setState({ mobilePanel: 'nav' });
    render();
    expect(host.innerHTML).toBe('');
  });
});
