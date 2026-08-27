// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { DM_PEOPLE_LIMIT, type DmPerson } from '@relay/shared';
import { PeoplePicker } from './PeoplePicker';
import { shortFingerprint } from '@/lib/format';

/**
 * `ask` — единственная дверь наружу у `PeoplePicker` (dm-people, dm-open).
 * Стор здесь ни при чём, а сокет реальным быть не может — стаб идёт тем же
 * приёмом, что stores/search.test.ts: `vi.mock` очереди ответов вместо
 * сети. Здесь очередь — по конкретным вызовам, а не общая: тесту про гонку
 * важен порядок разрешения, а не только сами ответы.
 */
vi.mock('@/lib/channels', () => ({ ask: vi.fn() }));
import { ask } from '@/lib/channels';

const askMock = ask as unknown as Mock;

/** Отложенный ответ — чтобы решать, в каком порядке разрешать запросы. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Ник и отпечаток не должны быть подстрокой друг друга — иначе проверка
 * на экране пройдёт и без одного из полей (тот же довод, что в
 * dm-list.test.tsx). Отпечаток — в настоящем формате, hex-группами.
 */
function person(over: Partial<DmPerson>): DmPerson {
  return { fingerprint: '6668-7aad-f862-bd77', nick: 'Марта', lastSeenTs: 0, ...over };
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function renderPicker() {
  act(() => {
    root.render(<PeoplePicker open onOpenChange={() => {}} />);
  });
}

/** Меняет значение управляемого инпута так, чтобы React увидел `onChange`. */
function typeQuery(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function flush() {
  // `.then()` внутри компонента — микротаска; пары тиков хватает, чтобы дать
  // React применить setState и вернуть управление тесту.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Продвигает фейковые таймеры внутри `act` — иначе выстрел debounce-таймера
 *  сам по себе (ask → setState) идёт мимо React и он ругается в консоль. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('выбор собеседника', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    askMock.mockReset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it('рисует лицо, ник и короткий отпечаток строки', async () => {
    const p = person({});
    askMock.mockResolvedValueOnce({ ok: true, people: [p] });

    renderPicker();
    await advance(0); // первый запрос уходит без паузы
    await flush();

    expect(host.textContent).toContain(p.nick);
    expect(host.textContent).toContain(shortFingerprint(p.fingerprint));
  });

  it('директория ровно по лимиту показывает подсказку сузить поиск', async () => {
    const people = Array.from({ length: DM_PEOPLE_LIMIT }, (_, i) =>
      person({ fingerprint: `${(1000 + i).toString(16)}-aaaa-bbbb-cccc`, nick: `Гость${i}` }),
    );
    askMock.mockResolvedValueOnce({ ok: true, people });

    renderPicker();
    await advance(0);
    await flush();

    expect(host.querySelector('[role="dialog"]')?.textContent).toMatch(
      /narrow your search|сузьте запрос/i,
    );
  });

  it('директория меньше лимита подсказку не показывает', async () => {
    askMock.mockResolvedValueOnce({ ok: true, people: [person({})] });

    renderPicker();
    await advance(0);
    await flush();

    expect(host.querySelector('[role="dialog"]')?.textContent).not.toMatch(
      /narrow your search|сузьте запрос/i,
    );
  });

  it('поздний ответ на устаревший запрос не подменяет свежий список', async () => {
    const stale = deferred<{ ok: true; people: DmPerson[] }>();
    const fresh = deferred<{ ok: true; people: DmPerson[] }>();
    askMock.mockImplementationOnce(() => stale.promise).mockImplementationOnce(() => fresh.promise);

    const staleP = person({ fingerprint: '1111-2222-3333-4444', nick: 'Игорь' });
    const freshP = person({ fingerprint: '5555-6666-7777-8888', nick: 'Олеся' });

    renderPicker();
    // Первый запрос (пустая строка) уходит без паузы — это первый вызов ask.
    await advance(0);

    const input = host.querySelector('input') as HTMLInputElement;
    typeQuery(input, 'о');
    // Второй запрос — с паузой на наборе; это второй вызов ask.
    await advance(280);

    expect(askMock).toHaveBeenCalledTimes(2);

    // Свежий (второй) запрос отвечает первым — обычный порядок в сети.
    fresh.resolve({ ok: true, people: [freshP] });
    await flush();
    expect(host.textContent).toContain(freshP.nick);

    // Устаревший (первый) запрос отвечает только теперь — без счётчика он
    // переписал бы список тем, что человек уже не ищет.
    stale.resolve({ ok: true, people: [staleP] });
    await flush();

    expect(host.textContent).toContain(freshP.nick);
    expect(host.textContent).not.toContain(staleP.nick);
  });
});
