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
vi.mock('@/lib/call', () => ({
  initCall: vi.fn(),
  dialCall: vi.fn(),
  hangUp: vi.fn(),
  cancelCall: vi.fn(),
  answerCall: vi.fn(),
  declineCall: vi.fn(),
  ownedCall: vi.fn(() => null),
}));
vi.mock('@/lib/hotkeys', () => ({ initHotkeys: vi.fn() }));
vi.mock('@/lib/desktop', () => ({ initDesktopBridge: vi.fn(async () => {}) }));
vi.mock('@/lib/notify', () => ({
  notifyDirect: vi.fn(),
  notifyMention: vi.fn(),
  notifyMessage: vi.fn(),
  notifyCall: vi.fn(),
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
    /**
     * `off` здесь настоящий, а не пустышка, и это ключевое: socket.io без
     * второго аргумента снимает ВСЕ обработчики события — вместе с чужими,
     * повешенными `initCall`/`initVoice` один раз на приложение. Подделка,
     * которая не снимает ничего, показывала бы такую уборку исправной (см.
     * тест «перемонтирование…» ниже).
     */
    off: vi.fn((event: string, cb?: (...args: unknown[]) => void) => {
      if (!cb) {
        handlers.delete(event);
        return;
      }
      handlers.set(
        event,
        (handlers.get(event) ?? []).filter((h) => h !== cb),
      );
    }),
    _fire: (event: string, ...args: unknown[]) => {
      for (const cb of handlers.get(event) ?? []) cb(...args);
    },
    _handlers: handlers,
  };
});
vi.mock('@/lib/socket', () => ({ getSocket: () => socket }));

import { SocketProvider } from './SocketProvider';
import { notifyCall, notifyDirect } from '@/lib/notify';
import { useAdminStore } from '@/stores/admin';
import { useChatStore } from '@/stores/chat';
import { useDmStore } from '@/stores/dm';
import { usePinsStore } from '@/stores/pins';
import { useUiStore } from '@/stores/ui';
import { useUnreadStore } from '@/stores/unread';
import { useRingStore } from '@/stores/ring';

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
  useRingStore.getState().reset();

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

describe('дозвон: call-state/call-ended доезжают до стора вызова', () => {
  // `initCall` (комната беседы) замокан выше — здесь проверяется только
  // соседний слушатель, заведённый этой же задачей (6 плана B) для ЭКРАНА
  // дозвона (`stores/ring.ts`), а не для комнаты. Оба независимы, и подделка
  // одного не должна прятать отсутствие другого.
  it('call-state{ringing} открывает экран, call-ended переключает подпись', () => {
    act(() =>
      socket._fire('call-state', {
        ringId: 'r1',
        state: 'ringing',
        peer: peerA,
        at: Date.now(),
        video: false,
      }),
    );
    expect(useRingStore.getState().outgoing?.ring.state).toBe('ringing');

    act(() =>
      socket._fire('call-ended', {
        ringId: 'r1',
        state: 'declined',
        peer: peerA,
        at: Date.now(),
        missed: false,
      }),
    );
    expect(useRingStore.getState().outgoing?.ring.state).toBe('declined');
  });

  it('call-incoming открывает тост в сторе, а системное окошко не заказывает (задача 7, ревью)', () => {
    act(() =>
      socket._fire('call-incoming', {
        ringId: 'r1',
        from: peerA,
        at: Date.now(),
        video: true,
      }),
    );

    expect(useRingStore.getState().incoming).toEqual({
      ringId: 'r1',
      from: peerA,
      video: true,
      at: expect.any(Number),
    });
    // Провайдер НЕ зовёт `notifyCall` сам — единственный владелец системного
    // окошка это `IncomingToast.tsx` (см. его эффект и комментарий у
    // `onCallIncoming` здесь). Ревью нашло, что раньше оба места звали
    // `notifyCall` на один и тот же вызов, и хэндл провайдера при этом
    // выбрасывался, из-за чего `cancelled` в `lib/notify.ts` никогда не
    // взводился и первый же звонок при уже выданном разрешении мог показать
    // окошко, которое некому закрыть. Этот assert красный при возврате
    // второго вызова и был бы красным ДО фикса (`notifyCall` звался дважды).
    expect(notifyCall).not.toHaveBeenCalled();
  });

  it('обрыв сокета гасит экран дозвона: эха о конце вызова не будет', () => {
    act(() =>
      socket._fire('call-state', {
        ringId: 'r1',
        state: 'ringing',
        peer: peerA,
        at: Date.now(),
        video: false,
      }),
    );
    expect(useRingStore.getState().outgoing).not.toBeNull();

    act(() => socket._fire('disconnect'));

    // Сервер кончает вызов звонящего в тот же миг, как ушло его последнее
    // устройство, без грейса (§4.2), и `call-ended{cancelled}` уезжает в уже
    // мёртвый сокет. На переподключении вызовы заново не рассылаются, своего
    // таймаута дозвона клиент не считает — не сними экран здесь, и он будет
    // пульсировать «дозваниваемся» на вызове, которого нет.
    expect(useRingStore.getState().outgoing).toBeNull();
  });

  it('перемонтирование провайдера не уносит чужих обработчиков тех же событий', () => {
    // `initCall`/`initVoice` вешают своих слушателей ОДИН раз на приложение
    // (у обоих замок `initialized`) — здесь они подделаны, поэтому их роль
    // играют эти три функции: важно не кто их повесил, а что провайдер их не
    // трогает.
    const foreignState = vi.fn();
    const foreignEnded = vi.fn();
    const foreignIncoming = vi.fn();
    const foreignDisconnect = vi.fn();
    const foreignConnect = vi.fn();
    socket.on('call-state', foreignState);
    socket.on('call-ended', foreignEnded);
    socket.on('call-incoming', foreignIncoming);
    socket.on('disconnect', foreignDisconnect);
    socket.on('connect', foreignConnect);

    // В строгом режиме React (`next.config.mjs`: reactStrictMode) каждое
    // открытие страницы в разработке — это монтирование, уборка и монтирование
    // заново. Безымянный `socket.off('call-state')` в уборке снимал бы заодно
    // и слушатель `lib/call.ts`, а тот назад не вернётся: принятый вызов
    // после первого же кадра не сажал бы в комнату никого.
    act(() => root.unmount());
    host.remove();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root.render(
        <SocketProvider>
          <div />
        </SocketProvider>,
      ),
    );

    act(() =>
      socket._fire('call-state', {
        ringId: 'r1',
        state: 'ringing',
        peer: peerA,
        at: Date.now(),
        video: false,
      }),
    );
    act(() =>
      socket._fire('call-incoming', { ringId: 'r2', from: peerA, at: Date.now(), video: false }),
    );
    act(() => socket._fire('connect'));
    act(() => socket._fire('disconnect'));

    expect(foreignState).toHaveBeenCalledTimes(1);
    expect(foreignIncoming).toHaveBeenCalledTimes(1);
    expect(foreignConnect).toHaveBeenCalledTimes(1);
    expect(foreignDisconnect).toHaveBeenCalledTimes(1);
    // И свой слушатель жив ровно один: уборка снимает своё, а не копит его.
    expect(socket._handlers.get('call-state')).toHaveLength(2);
    expect(socket._handlers.get('call-ended')).toHaveLength(2);
    expect(socket._handlers.get('call-incoming')).toHaveLength(2);
    expect(socket._handlers.get('disconnect')).toHaveLength(2);
    expect(socket._handlers.get('connect')).toHaveLength(2);

    act(() =>
      socket._fire('call-ended', {
        ringId: 'r1',
        state: 'declined',
        peer: peerA,
        at: Date.now(),
        missed: false,
      }),
    );
    expect(foreignEnded).toHaveBeenCalledTimes(1);
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
