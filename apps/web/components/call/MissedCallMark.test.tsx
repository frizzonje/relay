// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallMark } from '@relay/shared';

/**
 * Отметка о пропущенном в переписке (задача 8 плана B, экран 3 референса).
 *
 * Проверяется ровно то, что обещает бриф и чего не видно из типов: отметка не
 * похожа на сказанное человеком (пунктирная плашка, а не пузырь), несёт время и
 * длительность дозвона, а «перезвонить» звонит ТОМУ ЖЕ человеку — и тем же
 * путём, каким звонит кнопка в шапке беседы, а не вторым emit'ом мимо стора.
 *
 * `lib/call.ts` подделан тем же приёмом, что в `OutgoingCall.test.tsx`: здесь
 * важно, что кнопка доходит до `dialCall` с правильным отпечатком, а не как
 * устроен сам протокол.
 */
vi.mock('@/lib/call', () => ({
  dialCall: vi.fn(async () => ({ ok: true, ringId: 'r1' })),
  hangUp: vi.fn(),
  cancelCall: vi.fn(),
  ownedCall: vi.fn(() => null),
}));
vi.mock('@/lib/channels', () => ({ ask: vi.fn() }));

/** Настройки инсталляции: звонить можно — иначе кнопки не будет вовсе. */
const settings: Record<string, unknown> = { 'calls.enabled': true, 'calls.whoCanCall': 'everyone' };
vi.mock('@/stores/config', () => ({ useSetting: (key: string) => settings[key] }));

/** Открытая беседа: собеседник, которому и перезванивают. */
const ui = { dmPeer: 'fp-boris', textLabel: 'Боря' };
vi.mock('@/stores/ui', () => ({
  useUiStore: Object.assign((pick: (s: typeof ui) => unknown) => pick(ui), {
    getState: () => ui,
  }),
}));

const { dialCall } = await import('@/lib/call');
const { useRingStore } = await import('@/stores/ring');
const { MissedCallMark } = await import('./MissedCallMark');

const NO_ANSWER: CallMark = { state: 'no-answer', ms: 38_000 };
/**
 * 21:04 по местному времени стенда — время рисуется из `ts` реплики. Час
 * прошедший, а не «сейчас»: подставь компонент часы вместо времени строки, и
 * совпасть эти два числа могли бы разве что случайно, одну минуту в сутки.
 */
const AT = new Date(2026, 8, 6, 21, 4).getTime();

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(call: CallMark, byMe = false): string {
  act(() => root.render(<MissedCallMark call={call} ts={AT} byMe={byMe} />));
  return host.innerHTML;
}

function click(label: string) {
  const button = [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.includes(label) || b.getAttribute('aria-label')?.includes(label),
  );
  if (!button) throw new Error(`кнопки «${label}» на отметке нет`);
  act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

describe('отметка о пропущенном', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    settings['calls.enabled'] = true;
    settings['calls.whoCanCall'] = 'everyone';
    ui.dmPeer = 'fp-boris';
    ui.textLabel = 'Боря';
    useRingStore.getState().reset();
    vi.mocked(dialCall).mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('рисуется плашкой, а не пузырём: пунктир вместо фона реплики', () => {
    const markup = render(NO_ANSWER);
    // Пунктир — единственное, чем плашка отличается от всего остального в
    // ленте с одного взгляда, и он тут не украшение: «пропущенный звонок» —
    // это не то, что кто-то сказал.
    expect(markup).toContain('border-dashed');
    // Красным по правилу цвета плана 2.0 (`danger` = отбой, отклонён,
    // пропущен) — и никаким иным.
    expect(markup).toContain('text-danger');
    // И вся плашка — одна строка о звонке и кнопка: ни подписи автора, ни
    // текста реплики в ней нет (без языкового контекста стенд говорит на
    // языке-основе — `DEFAULT_LOCALE`, en).
    // Часы — Intl по языку читающего (у языка-основы это 12-часовой вид), а не
    // записанная в словарь форма.
    expect(host.textContent).toBe('Missed call · no answer09:04 PM · 38 s ringingCall back');
  });

  it('несёт время и длительность дозвона', () => {
    render(NO_ANSWER);
    const text = host.textContent ?? '';
    expect(text).toContain('09:04 PM');
    // 38 секунд — именно столько звонило, а не «когда-то звонили».
    expect(text).toContain('38');
    expect(text).toContain('Missed call');
  });

  it('называет исход своими словами: «не ответили» и «не в сети» — разные вещи', () => {
    expect(render({ state: 'no-answer', ms: 1_000 })).toContain('no answer');
    expect(render({ state: 'failed', ms: 1_000 })).toContain('not online');
  });

  it('своему звонку говорит «вы звонили», а не «пропущенный»', () => {
    render(NO_ANSWER, true);
    const text = host.textContent ?? '';
    expect(text).toContain('You called');
    expect(text).not.toContain('Missed call');
  });

  it('«перезвонить» звонит тому же человеку — тем же путём, что и кнопка в шапке', () => {
    render(NO_ANSWER);
    click('Call back');

    // Через стор дозвона, а не своим emit'ом: `dialCall` — та же дверь, что у
    // `DmThread` и `DmPeerCard` (задача 6).
    expect(vi.mocked(dialCall).mock.calls).toEqual([['fp-boris', false]]);
    // И экран исходящего открылся на нём же — иначе «перезвонить» звонило бы
    // молча, ничего не показав.
    expect(useRingStore.getState().outgoing?.peer).toEqual({
      fingerprint: 'fp-boris',
      nick: 'Боря',
    });
  });

  it('не предлагает перезвонить там, где звонить нельзя', () => {
    settings['calls.whoCanCall'] = 'nobody';
    render(NO_ANSWER);
    // Сама отметка остаётся: она рассказывает о том, что уже случилось, — а
    // кнопки, которая гарантированно получит отказ, здесь нет.
    expect(host.textContent).toContain('Missed call');
    expect(host.querySelector('button')).toBeNull();
  });
});

/**
 * Отметку рисует не сама по себе плашка, а строка ленты, которая обязана
 * УЗНАТЬ её среди реплик. Проверяется здесь, а не в отдельном файле про
 * `Message`, потому что доказывает ровно то же обещание брифа — «отметка
 * отличима от сообщения», — только с другой стороны: с той, где сообщение
 * настоящее.
 */
const { Message } = await import('@/components/chat/Message');

describe('отметка в ленте', () => {
  const noop = () => {};
  const common = {
    mine: false,
    me: 'Аня',
    myFingerprint: 'fp-anya',
    enter: false,
    editing: false,
    moderated: false,
    owner: false,
    onReply: noop,
    onStartEdit: noop,
    onSubmitEdit: noop,
    onCancelEdit: noop,
    onDelete: noop,
    onBan: noop,
    onJumpTo: noop,
    onPin: noop,
    retentionDays: 14,
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('строка со звонком — плашка, а не пузырь с подписью и текстом', () => {
    act(() =>
      root.render(
        <Message
          {...common}
          msg={{
            id: 'm1',
            name: 'Боря',
            fingerprint: 'fp-boris',
            text: 'missed call',
            ts: AT,
            system: true,
            call: NO_ANSWER,
          }}
        />,
      ),
    );

    expect(host.innerHTML).toContain('border-dashed');
    // Ни подписи автора, ни его текста-запаски: строку собирает клиент из
    // `call`, а «missed call» — то, что увидел бы клиент постарше.
    expect(host.textContent).not.toContain('missed call');
    expect(host.textContent).not.toContain('Боря');
  });

  it('обычную системную строку рисует по-прежнему — курсивом, без плашки', () => {
    act(() =>
      root.render(
        <Message
          {...common}
          msg={{ name: 'system', text: 'Боря was banned', ts: AT, system: true }}
        />,
      ),
    );

    expect(host.textContent).toBe('Боря was banned');
    expect(host.innerHTML).not.toContain('border-dashed');
  });

  it('звонок мой — «вы звонили»: решает отпечаток, а не подпись', () => {
    act(() =>
      root.render(
        <Message
          {...common}
          msg={{
            id: 'm2',
            name: 'Аня',
            fingerprint: 'fp-anya',
            text: 'missed call',
            ts: AT,
            call: NO_ANSWER,
            system: true,
          }}
        />,
      ),
    );

    expect(host.textContent).toContain('You called');
  });
});
