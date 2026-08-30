// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ownerLink,
  type AdminOverview,
  type AuditEntry,
  type MetricsResponse,
} from '@relay/shared';
import en from '@/lib/i18n/messages/en.json';
import { translate } from '@/lib/i18n/translate';

/**
 * Вкладки «Обзор», «Журнал» и «Обслуживание».
 *
 * Стережётся здесь то, что ломается молча или дорого.
 *
 * Молча: плитка, посчитанная в браузере вместо сервера (на трёх людях
 * неотличима от честной, на тысяче — врёт, потому что список привезён не весь);
 * страница журнала, взятая по одному времени (записи одной миллисекунды на
 * границе страниц пропадают навсегда, и заметить это можно только тем, что
 * чего-то не хватает); действие, промолчавшее в ответ (нажал — и непонятно,
 * случилось ли).
 *
 * Дорого: ссылка владельца. Она существует в читаемом виде ровно один раз, и
 * панель, показавшая её без предупреждения или без способа скопировать, стоит
 * человеку доступа к собственной инсталляции — за новой придётся идти в ssh.
 */

const emit = vi.hoisted(() => vi.fn());
vi.mock('@/lib/socket', () => ({ getSocket: () => ({ emit }) }));

import { AdminDialog } from './AdminDialog';
import { OverviewTab } from './OverviewTab';
import { AuditTab } from './AuditTab';
import { UpkeepTab } from './UpkeepTab';
import { useAdminStore } from '@/stores/admin';
import { useOwnerStore } from '@/stores/owner';
import { useUiStore } from '@/stores/ui';

const HOUR = 60 * 60 * 1000;
const GIB = 1024 * 1024 * 1024;

const overview: AdminOverview = {
  people: 137,
  online: 4,
  bans: 2,
  messages: 90210,
  servers: 3,
  channels: 11,
  storageBytes: 2 * GIB,
  storageQuotaBytes: 8 * GIB,
  retention: { mode: 'days', days: 14 },
  directRetention: { mode: 'forever' },
  version: '2.0.0',
};

const metrics: MetricsResponse = {
  cpu: { cores: 4, usage: 0.42, load1: 1.25 },
  mem: { total: 8 * GIB, used: 3 * GIB },
  disk: { total: 100 * GIB, used: 40 * GIB },
  uptimeSec: 3 * 86400 + 4 * 3600 + 31 * 60 + 7,
};

/** Строка журнала. Id — настоящий uuid: курсор ездит с ним, а не с «id-1». */
function entry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    at: Date.now() - HOUR,
    actor: '6668-7aad-f862-bd77',
    actorNick: 'Марта',
    action: 'setting-changed',
    target: 'messages.maxLength',
    detail: { from: 2000, to: 500 },
    ...over,
  };
}

const t = (key: string, vars?: Record<string, string | number>) => translate('en', key, vars);

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const writeText = vi.fn<(text: string) => Promise<void>>();

const testid = (id: string) => document.querySelector(`[data-testid="${id}"]`);
const calls = (event: string) => emit.mock.calls.filter((call) => call[0] === event);

/** Ответить за сервер на последний вызов события. */
async function answer(event: string, res: unknown) {
  const call = calls(event).at(-1);
  if (!call) throw new Error(`вкладка не спросила ${event}`);
  const cb = call.at(-1);
  if (typeof cb !== 'function') throw new Error(`в вызове ${event} нечем ответить`);
  await act(async () => {
    (cb as (r: unknown) => void)(res);
    // Ответ проходит через несколько промисов подряд (срок ожидания, метод
    // стора, `.then` вкладки): нулевой таймер даёт им всем закончиться.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function click(el: Element | null) {
  if (!el) throw new Error('нечего нажимать');
  act(() => (el as HTMLElement).click());
}

/** Нажать кнопку подтверждения в диалоге поверх панели — он рисуется порталом. */
function confirmWith(label: string) {
  const dialog = [...document.querySelectorAll('[role="dialog"]')].at(-1);
  const apply = [...(dialog?.querySelectorAll('button') ?? [])].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!apply) throw new Error(`в диалоге нет кнопки «${label}»`);
  act(() => apply.click());
}

const topDialog = () => [...document.querySelectorAll('[role="dialog"]')].at(-1) ?? null;

async function render(node: ReactNode) {
  await act(async () => {
    root.render(node);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function mount() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  emit.mockReset();
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => metrics })),
  );
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  useAdminStore.getState().reset();
  useOwnerStore.setState({ owner: true });
  useUiStore.setState({ adminOpen: false });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
}

function unmount() {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
}

describe('вкладка «Обзор»', () => {
  beforeEach(mount);
  afterEach(unmount);

  it('плитки берут числа из ответа сервера, а не считают их сами', async () => {
    useAdminStore.setState({ loaded: true, overview });
    await render(<OverviewTab />);

    // Людей 137, а список людей вкладка не спрашивала вовсе: посчитать их в
    // браузере можно было бы только по привезённой странице, то есть неверно.
    expect(testid('admin-tile-people')?.textContent).toContain('137');
    expect(calls('admin-people')).toHaveLength(0);
    expect(testid('admin-tile-messages')?.textContent).toContain(
      new Intl.NumberFormat('en').format(overview.messages),
    );
    expect(testid('admin-tile-version')?.textContent).toContain('2.0.0');
    expect(testid('admin-tile-bans')?.textContent).toContain('2');
  });

  it('образ без номера версии так и говорит, а не показывает пустоту', async () => {
    useAdminStore.setState({ loaded: true, overview: { ...overview, version: '' } });
    await render(<OverviewTab />);
    expect(testid('admin-tile-version')?.textContent).toContain(en['admin.overview.version.dev']);
  });

  it('состояние машины приезжает своим запросом', async () => {
    useAdminStore.setState({ loaded: true, overview });
    await render(<OverviewTab />);

    // Сводка панели про инсталляцию, а не про железо: cpu, память, диск и
    // аптайм считает машина, и спрашивают их там же, где их показывает главный
    // экран, — иначе панель называла бы цифрами то, чего не мерила.
    expect(fetch).toHaveBeenCalled();
    expect(testid('admin-tile-cpu')?.textContent).toContain('42');
    expect(testid('admin-tile-uptime')?.textContent).toContain('3');
  });

  it('неизмеренное рисуется прочерком, а не нулём', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ ...metrics, disk: null, cpu: { cores: 4, usage: null, load1: null } }),
    });
    useAdminStore.setState({ loaded: true, overview });
    await render(<OverviewTab />);

    // «0%» и «не померили» — разные утверждения, и второе нулём не пишут.
    expect(testid('admin-tile-disk')?.textContent).toContain(en['stats.disk.unknown']);
    expect(testid('admin-tile-disk')?.textContent).not.toContain('0%');
  });

  it('молчащие метрики не гасят плитки инсталляции', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('нет сети'));
    useAdminStore.setState({ loaded: true, overview });
    await render(<OverviewTab />);

    expect(testid('admin-tile-people')?.textContent).toContain('137');
    expect(testid('admin-tile-cpu')?.textContent).toContain(en['stats.error']);
  });
});

describe('вкладка «Журнал»', () => {
  beforeEach(mount);
  afterEach(unmount);

  it('строка говорит, кто, что и когда', async () => {
    await render(<AuditTab />);
    await answer('admin-audit', { ok: true, entries: [entry()], more: false });

    const row = testid('admin-audit-11111111-1111-4111-8111-111111111111')!;
    expect(row.textContent).toContain('Марта');
    expect(row.textContent).toContain(en['admin.audit.action.setting-changed']);
    expect(row.textContent).toContain(t('admin.audit.change', { from: '2000', to: '500' }));
  });

  it('системную запись не выдают за человека', async () => {
    await render(<AuditTab />);
    await answer('admin-audit', {
      ok: true,
      entries: [entry({ actorNick: 'system', system: true, actor: undefined })],
      more: false,
    });

    const row = testid('admin-audit-11111111-1111-4111-8111-111111111111')!;
    // Лица у машины нет: нарисуй мы его по нику, человек с таким же именем
    // выглядел бы в журнале системой.
    expect(row.querySelector('.rl-identicon')).toBeNull();
    expect(row.textContent).toContain(en['admin.audit.system']);
  });

  it('следующая страница берётся курсором последней показанной строки', async () => {
    const first = [
      entry({ id: 'aaaaaaaa-1111-4111-8111-111111111111', at: 1_700_000_002_000 }),
      entry({ id: 'bbbbbbbb-1111-4111-8111-111111111111', at: 1_700_000_001_000 }),
      // Две записи в одну миллисекунду — обычное дело: сброс группы пишет их
      // пачкой. Ровно на них ломается страница, взятая по одному времени.
      entry({ id: 'cccccccc-1111-4111-8111-111111111111', at: 1_700_000_001_000 }),
    ];
    await render(<AuditTab />);
    await answer('admin-audit', { ok: true, entries: first, more: true });

    click(testid('admin-audit-more'));
    // Курсор — время И id последней строки. Одно время отрезало бы соседку по
    // той же миллисекунде: её `at` не меньше курсора, и она не попала бы ни в
    // эту страницу, ни в следующую.
    expect(calls('admin-audit').at(-1)?.[1]).toEqual({
      cursor: { at: 1_700_000_001_000, id: 'cccccccc-1111-4111-8111-111111111111' },
    });

    await answer('admin-audit', {
      ok: true,
      entries: [entry({ id: 'dddddddd-1111-4111-8111-111111111111', at: 1_700_000_001_000 })],
      more: false,
    });

    // Страница дополняет список, а не заменяет его, и никого не задваивает.
    for (const id of ['aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd']) {
      expect([id, !!testid(`admin-audit-${id}-1111-4111-8111-111111111111`)]).toEqual([id, true]);
    }
    expect(useAdminStore.getState().audit).toHaveLength(4);
    // Больше нечего — и кнопки больше нет: «показать ещё», не приносящее
    // ничего, читается как сломанная панель.
    expect(testid('admin-audit-more')).toBeNull();
  });

  it('пустой журнал объясняет себя', async () => {
    await render(<AuditTab />);
    await answer('admin-audit', { ok: true, entries: [], more: false });
    // Пустое место без подписи выглядит одинаково и когда записей нет, и когда
    // ответ ещё летит.
    expect(testid('admin-audit-empty')?.textContent).toBe(en['admin.audit.empty']);
  });

  it('отказ назван причиной, а не пустой страницей', async () => {
    await render(<AuditTab />);
    await answer('admin-audit', { ok: false, error: 'forbidden' });
    expect(testid('admin-audit-error')?.textContent).toBe(en['refused.admin.forbidden']);
    expect(testid('admin-audit-empty')).toBeNull();
  });
});

describe('вкладка «Обслуживание»', () => {
  beforeEach(mount);
  afterEach(unmount);

  it('действие не уходит на сервер, пока его не подтвердили', async () => {
    await render(<UpkeepTab />);

    click(testid('admin-action-retention-run'));
    // Ни одного события до ответа человека: подтверждение — это и есть решение.
    expect(calls('admin-action')).toHaveLength(0);
    expect(topDialog()?.textContent).toContain(en['admin.upkeep.retention-run.confirm']);

    confirmWith(en['admin.upkeep.retention-run.apply']);
    expect(calls('admin-action').at(-1)?.[1]).toEqual({
      action: 'retention-run',
      confirm: true,
    });
  });

  it('каждое опасное действие спрашивает, и только выгрузка — нет', async () => {
    await render(<UpkeepTab />);

    for (const action of ['owner-link', 'retention-run', 'files-sweep', 'revoke-sessions']) {
      click(testid(`admin-action-${action}`));
      expect([action, !!topDialog()]).toEqual([action, true]);
      confirmWith(t(`admin.upkeep.${action}.apply`));
      expect([action, calls('admin-action').at(-1)?.[1]]).toEqual([
        action,
        { action, confirm: true },
      ]);
      await answer('admin-action', { ok: false, error: 'not-found' });
    }

    // Выгрузка ничего не меняет и не показывает секретов — спрашивать не о чем.
    const before = calls('admin-action').length;
    click(testid('admin-action-export'));
    expect(calls('admin-action')).toHaveLength(before + 1);
    expect(calls('admin-action').at(-1)?.[1]).toEqual({ action: 'export' });
  });

  it('исход виден и когда получилось, и когда отказали', async () => {
    await render(<UpkeepTab />);

    click(testid('admin-action-files-sweep'));
    confirmWith(en['admin.upkeep.files-sweep.apply']);
    await answer('admin-action', { ok: true, action: 'files-sweep', count: 7 });
    expect(testid('admin-action-done-files-sweep')?.textContent).toBe(
      t('admin.upkeep.files-sweep.done', { count: 7 }),
    );

    click(testid('admin-action-retention-run'));
    confirmWith(en['admin.upkeep.retention-run.apply']);
    await answer('admin-action', { ok: false, error: 'forbidden' });
    // Молчание в ответ на нажатие неотличимо от «панель не работает».
    expect(testid('admin-action-error-retention-run')?.textContent).toBe(
      en['refused.admin.forbidden'],
    );
  });

  it('ссылка владельца показывается один раз, предупреждает об этом и копируется', async () => {
    const token = 'A'.repeat(43);
    await render(<UpkeepTab />);

    click(testid('admin-action-owner-link'));
    confirmWith(en['admin.upkeep.owner-link.apply']);
    await answer('admin-action', {
      ok: true,
      action: 'owner-link',
      link: { token, expiresAt: Date.now() + 24 * HOUR },
    });

    const box = testid('admin-owner-link')!;
    const link = ownerLink('http://localhost:3000', token);
    expect((box.querySelector('input') as HTMLInputElement).value).toBe(link);
    // Без этой строки человек закроет панель, решив, что ссылку покажут ещё
    // раз. Не покажут: в базе лежит только хэш.
    expect(box.textContent).toContain(en['admin.upkeep.owner-link.warn']);

    click(testid('admin-owner-link-copy'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(link);

    // В сторе ключа нет и не было: он живёт ровно в этом кадре экрана, а стор
    // переживает переключение вкладок.
    expect(JSON.stringify(useAdminStore.getState())).not.toContain(token);

    click(testid('admin-owner-link-hide'));
    expect(testid('admin-owner-link')).toBeNull();
  });

  it('импорт перечисляет отвергнутое, а не только применённое', async () => {
    await render(<UpkeepTab />);

    const file = { name: 'relay.json', text: async () => JSON.stringify({ values: { a: 1 } }) };
    const input = testid('admin-import-file') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    confirmWith(en['admin.upkeep.import.apply']);
    expect(calls('admin-action').at(-1)?.[1]).toEqual({
      action: 'import',
      confirm: true,
      values: { a: 1 },
    });

    await answer('admin-action', {
      ok: true,
      action: 'import',
      imported: {
        applied: ['messages.maxLength'],
        rejected: [{ key: 'files.maxUploadBytes', reason: 'out-of-range' }],
      },
    });

    const done = testid('admin-action-done-import')!;
    expect(done.textContent).toContain(t('admin.upkeep.import.done', { count: 1 }));
    // Молча проглоченная половина файла — худший исход: человек уходит уверенным,
    // что инсталляция настроена так, как в файле.
    expect(done.textContent).toContain('files.maxUploadBytes');
    expect(done.textContent).toContain(en['refused.admin.out-of-range']);
  });
});

describe('панель целиком', () => {
  beforeEach(mount);
  afterEach(unmount);

  /** Открыть панель и ответить за сервер состоянием. */
  async function open() {
    useUiStore.setState({ adminOpen: true });
    await render(<AdminDialog />);
    await answer('admin-state', { ok: true, catalog: [], values: {}, overview });
  }

  it('обзор, журнал и обслуживание — три вкладки, и ни одна не спорит с группой', async () => {
    await open();
    for (const tab of ['overview', 'audit', 'upkeep']) {
      expect([tab, !!testid(`admin-tab-${tab}`)]).toEqual([tab, true]);
    }
    // Группа каталога зовётся `maintenance`, и вкладка обслуживания названа
    // иначе именно поэтому: два разных места с одним именем спорили бы и на
    // экране, и в разметке.
    expect(testid('admin-tab-maintenance')).toBeNull();
  });

  it('открытая панель начинается с обзора', async () => {
    await open();
    // Сводка — то, ради чего панель открывают чаще всего: «жива ли машина и
    // сколько там всего». Начинать с поля настройки значило бы прятать ответ.
    expect(testid('admin-overview')).toBeTruthy();
    expect(testid('admin-tab-overview')?.getAttribute('aria-current')).toBe('true');
  });

  it('у обзора, журнала и обслуживания нет кнопки «вернуть к умолчаниям»', async () => {
    await open();
    // Сбрасывать там нечего: это не группа параметров.
    expect(testid('admin-reset-group')).toBeNull();
  });
});
