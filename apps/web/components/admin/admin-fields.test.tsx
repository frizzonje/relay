// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SETTINGS,
  SETTING_GROUPS,
  defaults,
  type AdminOverview,
  type SettingSpec,
  type SettingValue,
} from '@relay/shared';
import en from '@/lib/i18n/messages/en.json';
import ru from '@/lib/i18n/messages/ru.json';

/**
 * Панель инсталляции: каркас и поля.
 *
 * Проверяется здесь одно главное обещание — ПАНЕЛЬ РИСУЕТ ПО КАТАЛОГУ, А НЕ ПО
 * ИМЕНАМ. Поэтому ни один случай ниже не называет параметр поимённо: нужный
 * берётся из каталога по виду (`kind`), по разметке (`danger`, `readOnly`) или
 * по тому, когда он подействует. Тест, написанный на конкретных ключах, прошёл
 * бы и на панели, где сотня полей расписана руками, — то есть проверял бы не то.
 *
 * Отдельно стережётся то, что ломается молча: подпись «когда подействует» (без
 * неё «сохранено» врёт), причина отказа под полем (без неё поле просто
 * возвращается на прежнее значение), пометка «сохраняется» и забывание снимка
 * при закрытии панели и при потере власти.
 */

const emit = vi.hoisted(() => vi.fn());
vi.mock('@/lib/socket', () => ({ getSocket: () => ({ emit }) }));

import { AdminDialog } from './AdminDialog';
import { useAdminStore } from '@/stores/admin';
import { useOwnerStore } from '@/stores/owner';
import { useUiStore } from '@/stores/ui';

const overview: AdminOverview = {
  people: 3,
  online: 1,
  bans: 0,
  messages: 42,
  servers: 1,
  channels: 4,
  storageBytes: 0,
  storageQuotaBytes: 0,
  retention: { mode: 'days', days: 14 },
  directRetention: null,
  version: '2.0.0',
};

/** Каталог целиком — тот же, что пришлёт сервер этой версии. */
const catalog = (): SettingSpec[] => [...SETTINGS];

/**
 * Значения под каталог. У секрета сервер шлёт признак «задано», а не строку, —
 * подделывать снимок иначе значило бы проверять панель на том, чего не бывает.
 */
function snapshot(specs: SettingSpec[]): Record<string, SettingValue> {
  const values: Record<string, SettingValue> = { ...defaults() };
  for (const spec of specs) if (spec.secret) values[spec.key] = false;
  return values;
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

/** Открыть панель и ответить за сервер состоянием. */
async function open(specs: SettingSpec[] = catalog(), values = snapshot(specs)) {
  useOwnerStore.setState({ owner: true });
  useUiStore.setState({ adminOpen: true });
  await act(async () => {
    root.render(<AdminDialog />);
  });
  const cb = emit.mock.calls.at(-1)?.at(-1);
  if (typeof cb !== 'function') throw new Error('панель не спросила состояние');
  await act(async () => {
    (cb as (r: unknown) => void)({ ok: true, catalog: specs, values, overview });
    await Promise.resolve();
  });
}

/** Правка стора снаружи — внутри `act`, чтобы подписка перерисовала окно. */
async function apply(change: () => void) {
  await act(async () => {
    change();
    await Promise.resolve();
  });
}

const testid = (id: string) => document.querySelector(`[data-testid="${id}"]`);
const field = (key: string) => testid(`admin-field-${key}`) as HTMLElement | null;

/**
 * Открыть вкладку, на которой живёт параметр, и дождаться, пока смена доедет
 * до экрана.
 *
 * Ждать приходится НАСТОЯЩЕЕ время: у `AnimatePresence mode="wait"` следующая
 * вкладка монтируется только после того, как догасла прежняя, а гаснет она
 * кадрами — фейковые часы кадров не двигают.
 */
async function showGroupOf(spec: SettingSpec) {
  const tab = testid(`admin-tab-${spec.group}`) as HTMLButtonElement | null;
  if (!tab) throw new Error(`нет вкладки ${spec.group}`);
  act(() => tab.click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
}

/** Показать поле параметра — вместе с его вкладкой. */
async function showField(spec: SettingSpec): Promise<HTMLElement> {
  await showGroupOf(spec);
  const el = field(spec.key);
  if (!el) throw new Error(`нет поля ${spec.key}`);
  return el;
}

/** Первый параметр каталога, подходящий под условие. */
function pick(match: (spec: SettingSpec) => boolean): SettingSpec {
  const spec = SETTINGS.find(match);
  if (!spec) throw new Error('в каталоге нет такого параметра — условие устарело');
  return spec;
}

const lastCall = () => emit.mock.calls.at(-1);
/** Последний диалог на странице — подтверждение поверх панели. */
const topDialog = () => [...document.querySelectorAll('[role="dialog"]')].at(-1) ?? null;

function clickText(scope: Element, text: string) {
  const button = [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!button) throw new Error(`нет кнопки «${text}»`);
  act(() => button.click());
}

describe('панель инсталляции', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    emit.mockReset();
    useAdminStore.getState().reset();
    useOwnerStore.setState({ owner: false });
    useUiStore.setState({ adminOpen: false });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('каждая группа каталога получила вкладку', async () => {
    await open();
    for (const group of SETTING_GROUPS) {
      expect([group, !!testid(`admin-tab-${group}`)]).toEqual([group, true]);
    }
  });

  it('флаг рисуется переключателем, число — полем с границами', async () => {
    const flag = pick((s) => s.kind === 'boolean' && !s.danger && !s.readOnly);
    const number = pick((s) => s.kind === 'number' && s.min !== undefined && s.max !== undefined);
    await open();

    expect((await showField(flag)).querySelector('[role="switch"]')).toBeTruthy();

    const box = await showField(number);
    const input = box.querySelector('input[type="number"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    // Границы каталога видны рядом с полем: иначе про потолок узнают отказом.
    expect(box.textContent).toContain(String(number.min));
    expect(box.textContent).toContain(String(number.max));
  });

  it('размер показан человеку, а не числом байт', async () => {
    const bytes = pick((s) => s.kind === 'bytes' && Number(s.fallback) > 0);
    await open();
    const box = await showField(bytes);
    expect(box.textContent).not.toContain(String(bytes.fallback));
    // «25 MB», а не 26214400: единица — рядом с полем, а число в ней.
    expect(box.textContent).toMatch(/\d+\s*(MB|КБ|МБ|GB|ГБ|KB)/);
    expect(box.querySelector('select')).toBeTruthy();
  });

  it('секрет не показывает значение', async () => {
    const secret = pick((s) => s.kind === 'secret' && !s.readOnly);
    await open();
    const box = await showField(secret);
    // Ни поля со значением, ни самого значения: наружу уезжает только признак.
    expect(box.querySelector('input')).toBeNull();
    expect(testid(`admin-secret-${secret.key}`)?.textContent).toMatch(/not set|не задано/i);

    clickText(box, en['admin.secret.change']);
    const input = field(secret.key)?.querySelector('input') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.value).toBe('');
  });

  it('параметр из окружения выключен и объясняет почему', async () => {
    const env = pick((s) => s.readOnly === true);
    await open();
    const box = await showField(env);
    expect(box.querySelector('input')).toBeNull();
    expect(box.querySelector('select')).toBeNull();
    expect(box.querySelector('[role="switch"]')).toBeNull();
    // Названа переменная, а не «правится где-то в настройках сервера»: искать
    // её человек пойдёт в .env конкретной машины.
    expect(testid(`admin-applies-${env.key}`)?.textContent).toContain(String(env.env));
  });

  it('под полем видно, когда изменение подействует', async () => {
    const now = pick((s) => s.applies === 'now' && !s.readOnly);
    const later = pick((s) => s.applies === 'new' && !s.readOnly);
    await open();

    await showGroupOf(now);
    const nowNote = testid(`admin-applies-${now.key}`)?.textContent ?? '';
    await showGroupOf(later);
    const laterNote = testid(`admin-applies-${later.key}`)?.textContent ?? '';

    expect(nowNote).toBeTruthy();
    // Разные — иначе подпись есть, а сказать ей нечего: «сохранено» у поля,
    // которое подействует только к новым подключениям, читается как обман.
    expect(laterNote).not.toBe(nowNote);
    expect(laterNote.toLowerCase()).toContain('new connections');
  });

  it('опасный параметр просит подтверждения, и оно уезжает на сервер', async () => {
    const danger = pick((s) => s.kind === 'boolean' && s.danger === true);
    await open();
    const before = emit.mock.calls.length;

    const box = await showField(danger);
    act(() => (box.querySelector('[role="switch"]') as HTMLElement).click());
    // Ничего не уехало: сперва вопрос.
    expect(emit.mock.calls.length).toBe(before);
    const dialog = topDialog();
    expect(dialog?.textContent).toContain(
      en[`settings.key.${danger.key}.label` as keyof typeof en],
    );

    clickText(dialog!, en['admin.confirm.apply']);
    // Подтверждение — поле в запросе, а не доверие к тому, что диалог показали.
    expect(lastCall()?.[0]).toBe('admin-set');
    expect(lastCall()?.[1]).toEqual({ key: danger.key, value: !danger.fallback, confirm: true });
  });

  it('безопасный параметр уезжает сразу, без вопроса', async () => {
    const flag = pick((s) => s.kind === 'boolean' && !s.danger && !s.readOnly);
    await open();
    const box = await showField(flag);
    act(() => (box.querySelector('[role="switch"]') as HTMLElement).click());
    expect(lastCall()?.[0]).toBe('admin-set');
    expect(lastCall()?.[1]).toEqual({ key: flag.key, value: !flag.fallback });
  });

  it('отказ виден под полем причиной, а не тишиной', async () => {
    const flag = pick((s) => s.kind === 'boolean' && !s.danger && !s.readOnly);
    await open();
    await showGroupOf(flag);
    await apply(() => useAdminStore.setState({ errors: { [flag.key]: 'out-of-range' } }));
    expect(testid(`admin-error-${flag.key}`)?.textContent).toBe(en['refused.admin.out-of-range']);
  });

  it('пометка «сохраняется» берётся из стора', async () => {
    const flag = pick((s) => s.kind === 'boolean' && !s.danger && !s.readOnly);
    await open();
    await showGroupOf(flag);
    expect(testid(`admin-saving-${flag.key}`)).toBeNull();
    await apply(() => useAdminStore.setState({ saving: [flag.key] }));
    expect(testid(`admin-saving-${flag.key}`)).toBeTruthy();
  });

  it('закрытая панель забывает снимок', async () => {
    await open();
    expect(useAdminStore.getState().loaded).toBe(true);
    await apply(() => useUiStore.setState({ adminOpen: false }));
    // Иначе панель, открытая заново, показала бы вчерашние значения раньше,
    // чем доедет свежий ответ, — и правку в них приняли бы за правку в новых.
    expect(useAdminStore.getState().loaded).toBe(false);
    expect(useAdminStore.getState().catalog).toEqual([]);
  });

  it('потеря власти закрывает панель и забывает снимок', async () => {
    await open();
    await apply(() => useOwnerStore.setState({ owner: false }));
    expect(useUiStore.getState().adminOpen).toBe(false);
    expect(useAdminStore.getState().loaded).toBe(false);
    expect(testid('admin-tab-access')).toBeNull();
  });

  it('не владельцу панель не рисуется вовсе', async () => {
    useOwnerStore.setState({ owner: false });
    useUiStore.setState({ adminOpen: true });
    await act(async () => {
      root.render(<AdminDialog />);
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // И сервер об этом не спрашивают: ответ известен заранее.
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('поле рисуется по виду параметра, а не по имени', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    emit.mockReset();
    useAdminStore.getState().reset();
    useOwnerStore.setState({ owner: false });
    useUiStore.setState({ adminOpen: false });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  /**
   * Параметры, которых этот клиент в глаза не видел: имён их нет ни в его
   * каталоге, ни в словаре. Сервер вправе прислать такие в любом выпуске —
   * версия контракта поднимается только с мажором, — и панель обязана нарисовать
   * им контрол по виду. Это и есть доказательство, что имён она не знает.
   */
  const invented: SettingSpec[] = [
    { key: 'zzz.flag', group: 'access', kind: 'boolean', fallback: true, applies: 'now' },
    {
      key: 'zzz.count',
      group: 'access',
      kind: 'number',
      fallback: 7,
      applies: 'restart',
      min: 1,
      max: 9,
    },
    {
      key: 'zzz.choice',
      group: 'access',
      kind: 'select',
      fallback: 'left',
      applies: 'now',
      options: ['left', 'right'],
    },
    { key: 'zzz.words', group: 'access', kind: 'list', fallback: ['раз'], applies: 'now', max: 5 },
    { key: 'zzz.line', group: 'access', kind: 'text', fallback: 'привет', applies: 'now', max: 20 },
    { key: 'zzz.essay', group: 'access', kind: 'multiline', fallback: '', applies: 'now', max: 99 },
  ];

  it('незнакомый параметр получает контрол по своему виду', async () => {
    await open(invented, Object.fromEntries(invented.map((s) => [s.key, s.fallback])));
    // Панель открывается на «Обзоре»: до полей надо дойти, как и везде в файле.
    await showGroupOf(invented[0]);

    expect(field('zzz.flag')?.querySelector('[role="switch"]')).toBeTruthy();
    expect(field('zzz.count')?.querySelector('input[type="number"]')).toBeTruthy();
    expect(field('zzz.choice')?.querySelectorAll('option').length).toBe(2);
    expect(field('zzz.words')?.textContent).toContain('раз');
    expect((field('zzz.line')?.querySelector('input') as HTMLInputElement).value).toBe('привет');
    expect(field('zzz.essay')?.querySelector('textarea')).toBeTruthy();
  });

  it('незнакомый параметр называется своим ключом, а не пустотой', async () => {
    await open(invented, Object.fromEntries(invented.map((s) => [s.key, s.fallback])));
    await showGroupOf(invented[0]);
    // Машинное имя хуже подписи, но лучше пустого места, за которое не взяться.
    expect(field('zzz.flag')?.textContent).toContain('zzz.flag');
    // И «когда подействует» у него тоже есть — это свойство каталога.
    expect(testid('admin-applies-zzz.count')?.textContent?.toLowerCase()).toContain('restart');
  });

  it('незнакомая группа не прячет свои поля', async () => {
    const alien = [
      {
        ...invented[0],
        key: 'zzz.alien',
        group: 'sorcery' as SettingSpec['group'],
      },
    ];
    await open(alien, { 'zzz.alien': true });
    expect(testid('admin-tab-sorcery')).toBeTruthy();
  });
});

describe('текст панели', () => {
  /**
   * Подпись и пояснение есть у КАЖДОГО параметра каталога и в обеих локалях.
   *
   * Ключ, которого нет в словаре, панель покажет машинным именем и не упадёт —
   * то есть пропажа была бы тихой ровно там, где текст и есть половина работы.
   * `messages.test.ts` стережёт равенство словарей между собой, а этот случай —
   * их полноту относительно каталога.
   */
  const dictionaries: [string, Record<string, unknown>][] = [
    ['en', en],
    ['ru', ru],
  ];

  it.each(dictionaries)('%s описывает каждый параметр и каждую группу', (_locale, dict) => {
    const missing: string[] = [];
    for (const spec of SETTINGS) {
      for (const part of ['label', 'hint']) {
        const key = `settings.key.${spec.key}.${part}`;
        if (typeof dict[key] !== 'string' || !String(dict[key]).trim()) missing.push(key);
      }
      for (const option of spec.options ?? []) {
        const key = `settings.option.${spec.key}.${option}`;
        if (typeof dict[key] !== 'string' || !String(dict[key]).trim()) missing.push(key);
      }
    }
    for (const group of SETTING_GROUPS) {
      const key = `settings.group.${group}`;
      if (typeof dict[key] !== 'string' || !String(dict[key]).trim()) missing.push(key);
    }
    expect(missing).toEqual([]);
  });

  it.each(dictionaries)('%s не пересказывает имя параметра подсказкой', (_locale, dict) => {
    // Подсказка обязана говорить, ЧТО ИЗМЕНИТСЯ, а не повторять название
    // другими словами: «Максимальная длина сообщения — максимальная длина
    // сообщения» занимает место и не сообщает ничего.
    const lazy = SETTINGS.filter((spec) => {
      const label = String(dict[`settings.key.${spec.key}.label`] ?? '');
      const hint = String(dict[`settings.key.${spec.key}.hint`] ?? '');
      return hint.length <= label.length;
    }).map((spec) => spec.key);
    expect(lazy).toEqual([]);
  });
});
