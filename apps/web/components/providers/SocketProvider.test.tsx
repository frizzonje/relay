// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DmActivityRelay, DmPeer } from '@relay/shared';

/**
 * `SocketProvider` до этой задачи не имел ни одного теста: он держит один
 * `useEffect` на всё приложение и опирается на десяток соседних модулей
 * (голос, хоткеи, десктоп-мост, звук уведомлений). Здесь проверяется только
 * стык задачи 11 — то, что `openSlug()`/`watching()` и подписка на ui-стор
 * научились понимать беседу, — а не всё остальное поведение файла: остальное
 * как было непроверенным, так и остаётся (см. отчёт к задаче).
 *
 * Тяжёлые побочные модули замоканы, чтобы монтирование не трогало реальные
 * WebRTC/хоткеи/десктоп-мост и не шумело сетевыми звонками, которых здесь нет.
 */
vi.mock('@/lib/voice', () => ({ initVoice: vi.fn(), relabelSelf: vi.fn() }));
vi.mock('@/lib/hotkeys', () => ({ initHotkeys: vi.fn() }));
vi.mock('@/lib/desktop', () => ({ initDesktopBridge: vi.fn(async () => {}) }));
vi.mock('@/lib/notify', () => ({
  notifyDirect: vi.fn(),
  notifyMention: vi.fn(),
  notifyMessage: vi.fn(),
}));

/**
 * Socket.io-клиент — фейковая шина событий: `on` копит обработчики, `_fire`
 * зовёт их напрямую (тест играет за сервер), `emit` — шпион на то, что ушло
 * на сервер. Тот же приём, что в lib/prefs.test.ts, только с событиями.
 */
const socket = vi.hoisted(() => {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    connected: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
    emit: vi.fn(),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      const arr = handlers.get(event) ?? [];
      arr.push(cb);
      handlers.set(event, arr);
    }),
    off: vi.fn(),
    _fire: (event: string, ...args: unknown[]) => {
      for (const cb of handlers.get(event) ?? []) cb(...args);
    },
    _handlers: handlers,
  };
});
vi.mock('@/lib/socket', () => ({ getSocket: () => socket }));

import { SocketProvider } from './SocketProvider';
import { notifyDirect } from '@/lib/notify';
import { useAdminStore } from '@/stores/admin';
import { useChatStore } from '@/stores/chat';
import { useDmStore } from '@/stores/dm';
import { usePinsStore } from '@/stores/pins';
import { useUiStore } from '@/stores/ui';
import { useUnreadStore } from '@/stores/unread';

const slugA = 'dm-aaaaaaaaaaaaaaaaaaaaaaaa';
const slugB = 'dm-bbbbbbbbbbbbbbbbbbbbbbbb';
const peerA: DmPeer = { fingerprint: '1111-aaaa-2222-bbbb', nick: 'Аня' };
const peerB: DmPeer = { fingerprint: '3333-cccc-4444-dddd', nick: 'Боря' };

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  socket._handlers.clear();
  socket.connected = false;

  // watching() смотрит и на фокус вкладки — без этого тесты зависели бы от
  // того, есть ли у jsdom-окна фокус на конкретной машине CI.
  document.hasFocus = () => true;
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });

  useUiStore.setState({
    view: 'lobby',
    textRoom: null,
    textLabel: '',
    dmRoom: null,
    dmPeer: null,
    dmSection: false,
    pendingScene: null,
    stageLive: false,
    voiceRoom: null,
    voiceLabel: '',
  });
  useDmStore.getState().reset();
  useUnreadStore.setState({
    activity: {},
    lastRead: {},
    divider: {},
    mentions: {},
    atBottom: true,
  });
  usePinsStore.getState().reset();
  useChatStore.getState().reset();

  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root.render(
      <SocketProvider>
        <div />
      </SocketProvider>,
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('openSlug()/watching() понимают беседу', () => {
  it('вход в беседу шлёт dm-join и честно отмечает прежнюю активность прочитанной', () => {
    // Активность уже известна dm-стору (пришла со списком переписок) — прежде
    // чем беседу открыли ни разу за этот сеанс.
    useDmStore
      .getState()
      .setConversations([
        { slug: slugA, peer: peerA, lastTs: 500, preview: 'привет', previewMine: false },
      ]);

    act(() => {
      useUiStore.getState().openDm(slugA, peerA.fingerprint, peerA.nick);
    });

    expect(socket.emit).toHaveBeenCalledWith('dm-join', { slug: slugA }, expect.any(Function));
    // «Дочитал» ставится по честному времени последней реплики, а не по нулю —
    // без моста unread-стор не знает времени этой беседы вовсе (см. комментарий
    // в SocketProvider у `noteActivity`).
    expect(useUnreadStore.getState().lastRead[slugA]).toBe(500);
    // Линия «новые» — на прежней отметке (до входа лента не была прочитана
    // вовсе), а не там же, где lastRead — иначе линия не встала бы никогда.
    expect(useUnreadStore.getState().divider[slugA]).toBe(0);
  });

  it('вход в другую беседу не путает её со списком последней активности прежней', () => {
    useDmStore.getState().setConversations([
      { slug: slugA, peer: peerA, lastTs: 500, preview: 'привет', previewMine: false },
      { slug: slugB, peer: peerB, lastTs: 10, preview: 'йо', previewMine: false },
    ]);

    act(() => useUiStore.getState().openDm(slugA, peerA.fingerprint, peerA.nick));
    act(() => useUiStore.getState().openDm(slugB, peerB.fingerprint, peerB.nick));

    expect(useUnreadStore.getState().lastRead[slugB]).toBe(10);
    // Беседа A прочитана своим снимком, а не значением B.
    expect(useUnreadStore.getState().lastRead[slugA]).toBe(500);
  });
});

describe('переход между беседами не путает ленты (регрессия)', () => {
  it('открытие соседней беседы сбрасывает чат сразу, а не по приезду chat-history', () => {
    act(() => useUiStore.getState().openDm(slugA, peerA.fingerprint, peerA.nick));
    useChatStore
      .getState()
      .setHistory([{ id: 'm1', name: peerA.nick, text: 'привет', ts: 1 }], false);
    expect(useChatStore.getState().messages).toHaveLength(1);

    // До фикса: `openDm` держит `textRoom: null` до и после (меняется только
    // `dmRoom`), поэтому ветка по `textRoom` в SocketProvider не видит смены
    // вовсе и `chat().reset()` не срабатывает — сообщения Ани оставались бы
    // нарисованы под шапкой Бори до ответа сервера.
    act(() => useUiStore.getState().openDm(slugB, peerB.fingerprint, peerB.nick));

    expect(useChatStore.getState().messages).toHaveLength(0);
  });

  it('закреплённое не остаётся висеть над новой беседой', () => {
    usePinsStore.setState({ open: true, count: 3, list: [] });
    act(() => useUiStore.getState().openDm(slugA, peerA.fingerprint, peerA.nick));

    expect(usePinsStore.getState().open).toBe(false);
    expect(usePinsStore.getState().count).toBe(0);
  });
});

describe('уведомление о реплике в беседе', () => {
  it('не звенит и не мигает по беседе, на которую смотрят прямо сейчас', () => {
    act(() => useUiStore.getState().openDm(slugA, peerA.fingerprint, peerA.nick));

    const relay: DmActivityRelay = {
      slug: slugA,
      ts: 999,
      preview: 'ты тут?',
      previewMine: false,
      peer: peerA,
    };
    act(() => socket._fire('dm-activity', relay));

    expect(notifyDirect).not.toHaveBeenCalled();
    // Смотрят прямо сейчас — значит и прочитано прямо сейчас, тем же временем.
    expect(useUnreadStore.getState().lastRead[slugA]).toBe(999);
  });

  it('звенит по беседе, которую сейчас не открыли', () => {
    const relay: DmActivityRelay = {
      slug: slugA,
      ts: 999,
      preview: 'ты тут?',
      previewMine: false,
      peer: peerA,
    };
    act(() => socket._fire('dm-activity', relay));

    expect(notifyDirect).toHaveBeenCalledWith(slugA);
  });

  it('своя же реплика с другого устройства не звенит, даже если беседа закрыта', () => {
    const relay: DmActivityRelay = {
      slug: slugA,
      ts: 999,
      preview: 'сам себе',
      previewMine: true,
      peer: peerA,
    };
    act(() => socket._fire('dm-activity', relay));

    expect(notifyDirect).not.toHaveBeenCalled();
  });
});

describe('телефон: шаг назад из беседы', () => {
  /** Узкий экран целиком в руках теста: jsdom своего `matchMedia` не имеет. */
  function narrowScreen() {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (media: string) => ({
        matches: true,
        media,
        addEventListener() {},
        removeEventListener() {},
      }),
    });
  }

  afterEach(() => {
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it('реплика в свёрнутую беседу звенит, а не считается прочитанной', () => {
    narrowScreen();
    act(() => useUiStore.getState().openDm(slugA, peerA.fingerprint, peerA.nick));
    // Ровно то, что делает шеврон «назад» в MobileNav: панель — список, вид
    // остаётся `dm`, беседа остаётся открытой на сокете.
    act(() => useUiStore.getState().toggleDmSection());
    expect(useUiStore.getState().mobilePanel).toBe('nav');

    const relay: DmActivityRelay = {
      slug: slugA,
      ts: 999,
      preview: 'ты тут?',
      previewMine: false,
      peer: peerA,
    };
    act(() => socket._fire('dm-activity', relay));

    expect(notifyDirect).toHaveBeenCalledWith(slugA);
    expect(useUnreadStore.getState().lastRead[slugA]).not.toBe(999);
  });

  it('на широком экране панель ни при чём — открытая беседа читается сразу', () => {
    act(() => useUiStore.getState().openDm(slugA, peerA.fingerprint, peerA.nick));
    act(() => useUiStore.getState().setMobilePanel('nav'));

    act(() =>
      socket._fire('dm-activity', {
        slug: slugA,
        ts: 999,
        preview: 'ты тут?',
        previewMine: false,
        peer: peerA,
      } as DmActivityRelay),
    );

    expect(notifyDirect).not.toHaveBeenCalled();
    expect(useUnreadStore.getState().lastRead[slugA]).toBe(999);
  });
});

describe('реконнект', () => {
  it('переспрашивает dm-join для открытой сейчас беседы', () => {
    act(() => useUiStore.getState().openDm(slugA, peerA.fingerprint, peerA.nick));
    socket.emit.mockClear();

    act(() => socket._fire('connect'));

    expect(socket.emit).toHaveBeenCalledWith('dm-join', { slug: slugA }, expect.any(Function));
  });
});

describe('правка настройки из другой сессии владельца', () => {
  it('доезжает до стора панели', () => {
    // Панель, открытая на втором устройстве, обязана обновиться — иначе она
    // сохранит поверх свежей правки то, что показывала минуту назад. Своей
    // правки вторым эхом не приходит: сервер её себе не шлёт (§9.6).
    useAdminStore.getState().reset();

    act(() =>
      socket._fire('admin-changed', {
        keys: ['direct.enabled'],
        values: { 'direct.enabled': false },
      }),
    );

    expect(useAdminStore.getState().values['direct.enabled']).toBe(false);
  });
});
