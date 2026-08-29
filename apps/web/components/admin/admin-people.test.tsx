// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminOverview, AdminPerson, BanEntry, SettingSpec } from '@relay/shared';
import en from '@/lib/i18n/messages/en.json';
import { translate } from '@/lib/i18n/translate';
import { shortFingerprint } from '@/lib/format';

/**
 * Вкладки «Личности» и «Баны».
 *
 * Стережётся здесь то, что ломается молча или дорого. Молча: поиск, который на
 * самом деле фильтрует привезённое (на десяти людях неотличим от серверного, на
 * тысяче — привозит тысячу); страница, теряющая набранный запрос при «показать
 * ещё»; пустой список без объяснения — он выглядит одинаково и когда никого
 * нет, и когда ответ ещё летит. Дорого: бан без внятного вопроса и кнопка
 * «забанить» у владельца, которая всегда отказывает.
 *
 * Отдельно проверяется, что разбан возвращает человека БЕЗ повторного вопроса
 * серверу: список банов и список людей — один и тот же снимок, и «обновится при
 * следующем открытии панели» здесь означало бы, что панель врёт до тех пор.
 */

const emit = vi.hoisted(() => vi.fn());
vi.mock('@/lib/socket', () => ({ getSocket: () => ({ emit }) }));

import { AdminDialog } from './AdminDialog';
import { PeopleTab } from './PeopleTab';
import { BansTab } from './BansTab';
import { useAdminStore } from '@/stores/admin';
import { useOwnerStore } from '@/stores/owner';
import { useUiStore } from '@/stores/ui';

const HOUR = 60 * 60 * 1000;

/**
 * Ник и отпечаток не должны быть подстрокой друг друга: иначе проверка «на
 * экране есть и то, и другое» прошла бы и без одного из них.
 */
function person(over: Partial<AdminPerson> = {}): AdminPerson {
  return {
    fingerprint: '6668-7aad-f862-bd77',
    nick: 'Марта',
    createdAt: Date.now() - 100 * HOUR,
    lastSeenAt: Date.now() - 3 * HOUR,
    devices: [],
    banned: false,
    owner: false,
    ...over,
  };
}

function ban(over: Partial<BanEntry> = {}): BanEntry {
  return {
    fingerprint: '1c9d-4e30-aa71-0b52',
    nick: 'Гриша',
    at: new Date(Date.now() - 5 * HOUR).toISOString(),
    by: 'Хозяйка',
    ...over,
  };
}

const t = (key: string, vars?: Record<string, string | number>) => translate('en', key, vars);

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

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

/** Настоящее ожидание: у debounce и у смены вкладки свои таймеры и кадры. */
async function wait(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** Меняет значение управляемого поля так, чтобы React увидел `onChange`. */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Нажать «Забанить» в диалоге подтверждения — он рисуется порталом. */
function confirmBan() {
  const dialog = [...document.querySelectorAll('[role="dialog"]')].at(-1);
  const apply = [...(dialog?.querySelectorAll('button') ?? [])].find(
    (b) => b.textContent?.trim() === en['admin.people.ban.apply'],
  );
  if (!apply) throw new Error('в диалоге нет кнопки подтверждения');
  act(() => apply.click());
}

function click(el: Element | null) {
  if (!el) throw new Error('нечего нажимать');
  act(() => (el as HTMLElement).click());
}

/** Показать вкладку людей и ответить за сервер первой страницей. */
async function showPeople(people: AdminPerson[], cursor?: string) {
  await act(async () => {
    root.render(<PeopleTab />);
  });
  await answer('admin-people', { ok: true, people, ...(cursor ? { cursor } : {}) });
}

function mount() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  emit.mockReset();
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
}

describe('вкладка «Личности»', () => {
  beforeEach(mount);
  afterEach(unmount);

  it('строка человека — лицо, имя, короткий отпечаток и когда его видели', async () => {
    const marta = person({
      devices: [{ id: 'dev-1', name: 'Ноутбук', lastSeenAt: Date.now() - HOUR, revoked: false }],
    });
    await showPeople([marta]);

    const row = testid(`admin-person-${marta.fingerprint}`)!;
    // Лицо выведено из отпечатка — той же картинкой, что и в составе канала.
    expect(row.querySelector('.rl-identicon')).toBeTruthy();
    expect(row.textContent).toContain(marta.nick);
    // Короткая форма, и только она: девятнадцать знаков в строку не влезают, а
    // показывать отпечаток целиком в интерфейсе здесь не принято нигде.
    expect(row.textContent).toContain(shortFingerprint(marta.fingerprint));
    expect(row.textContent).not.toContain(marta.fingerprint);
    expect(row.textContent).toContain(t('admin.people.devices', { count: 1 }));
    expect(row.textContent).toContain(t('admin.people.seen', { when: '3 hours ago' }));
  });

  it('того, кто ни разу не входил, не выдают за недавнего', async () => {
    const never = person({ lastSeenAt: null });
    await showPeople([never]);
    expect(testid(`admin-person-${never.fingerprint}`)?.textContent).toContain(
      en['admin.people.never'],
    );
  });

  it('владелец и забаненный помечены прямо в строке', async () => {
    const boss = person({ fingerprint: 'aaaa-bbbb-cccc-dddd', nick: 'Хозяйка', owner: true });
    const outcast = person({ fingerprint: '1111-2222-3333-4444', nick: 'Гриша', banned: true });
    await showPeople([boss, outcast]);

    expect(testid(`admin-person-${boss.fingerprint}`)?.textContent).toContain(
      en['admin.people.owner'],
    );
    expect(testid(`admin-person-${outcast.fingerprint}`)?.textContent).toContain(
      en['admin.people.banned'],
    );
  });

  it('владельца забанить нельзя — кнопки нет вовсе', async () => {
    const boss = person({ fingerprint: 'aaaa-bbbb-cccc-dddd', nick: 'Хозяйка', owner: true });
    const other = person();
    await showPeople([boss, other]);

    // Сервер откажет и так (`forbidden`), но кнопка, которая всегда отказывает,
    // — насмешка над тем, кто её нажал.
    expect(testid(`admin-ban-${boss.fingerprint}`)).toBeNull();
    expect(testid(`admin-ban-${other.fingerprint}`)).toBeTruthy();
  });

  it('поиск уходит на сервер, а не отбирает из привезённого', async () => {
    await showPeople([person(), person({ fingerprint: '1111-2222-3333-4444', nick: 'Гриша' })]);
    const before = calls('admin-people').length;

    type(testid('admin-people-search') as HTMLInputElement, 'гри');
    await wait(400);

    expect(calls('admin-people').length).toBe(before + 1);
    expect(calls('admin-people').at(-1)?.[1]).toEqual({ query: 'гри' });

    await answer('admin-people', {
      ok: true,
      people: [person({ fingerprint: '1111-2222-3333-4444', nick: 'Гриша' })],
    });
    expect(testid('admin-person-6668-7aad-f862-bd77')).toBeNull();
    expect(testid('admin-person-1111-2222-3333-4444')).toBeTruthy();
  });

  it('пока ищем — так и сказано', async () => {
    await act(async () => {
      root.render(<PeopleTab />);
    });
    // Ответа ещё нет: без этой строки медленная сеть неотличима от пустой
    // инсталляции, и владелец решит, что у него никого нет.
    expect(testid('admin-people-busy')).toBeTruthy();
    await answer('admin-people', { ok: true, people: [person()] });
    expect(testid('admin-people-busy')).toBeNull();
  });

  it('пустое место объясняет себя — и по-разному', async () => {
    await showPeople([]);
    expect(testid('admin-people-empty')?.textContent).toBe(en['admin.people.empty']);

    type(testid('admin-people-search') as HTMLInputElement, 'кого-нет');
    await wait(400);
    await answer('admin-people', { ok: true, people: [] });
    // «Никого не нашли» и «здесь никого нет» — разные новости.
    expect(testid('admin-people-empty')?.textContent).toBe(
      t('admin.people.nothing', { query: 'кого-нет' }),
    );
  });

  it('следующая страница берётся курсором и помнит запрос', async () => {
    await showPeople([person()], 'page-2');
    type(testid('admin-people-search') as HTMLInputElement, 'а');
    await wait(400);
    await answer('admin-people', { ok: true, people: [person()], cursor: 'page-2' });

    click(testid('admin-people-more'));
    // Запрос уезжает вместе с курсором: иначе вторая страница приходит из
    // общего списка и «показать ещё» подмешивает в находки посторонних.
    expect(calls('admin-people').at(-1)?.[1]).toEqual({ query: 'а', cursor: 'page-2' });

    await answer('admin-people', {
      ok: true,
      people: [person({ fingerprint: '1111-2222-3333-4444', nick: 'Гриша' })],
    });
    // Дописано, а не заменено.
    expect(testid('admin-person-6668-7aad-f862-bd77')).toBeTruthy();
    expect(testid('admin-person-1111-2222-3333-4444')).toBeTruthy();
    // Курсора в ответе нет — и предлагать «ещё» больше нечего.
    expect(testid('admin-people-more')).toBeNull();
  });

  it('бан спрашивает и говорит, что это значит', async () => {
    const marta = person();
    await showPeople([marta]);
    const before = calls('admin-action').length;

    click(testid(`admin-ban-${marta.fingerprint}`));
    // Ничего не уехало: сперва вопрос.
    expect(calls('admin-action').length).toBe(before);

    const dialog = [...document.querySelectorAll('[role="dialog"]')].at(-1)!;
    expect(dialog.textContent).toContain(marta.nick);
    // Вопрос называет последствия обеими половинами: что человек теряет и на
    // чём бан держится. Диалог «вы уверены?» не сообщает ни того, ни другого.
    expect(dialog.textContent).toContain(en['admin.people.ban.body']);
    expect(dialog.textContent).toContain(en['admin.people.ban.warn']);

    confirmBan();
    // Подтверждение — поле в запросе, а не доверие к тому, что диалог показали.
    expect(calls('admin-action').at(-1)?.[1]).toEqual({
      action: 'ban',
      target: marta.fingerprint,
      confirm: true,
    });

    await answer('admin-action', { ok: true, action: 'ban' });
    expect(testid(`admin-person-${marta.fingerprint}`)?.textContent).toContain(
      en['admin.people.banned'],
    );
  });

  it('отказ на бан виден в той же строке, а не в тишине', async () => {
    const marta = person();
    await showPeople([marta]);
    click(testid(`admin-ban-${marta.fingerprint}`));
    confirmBan();
    await answer('admin-action', { ok: false, error: 'not-found' });

    expect(testid(`admin-person-error-${marta.fingerprint}`)?.textContent).toBe(
      en['refused.admin.not-found'],
    );
    expect(testid(`admin-person-${marta.fingerprint}`)?.textContent).not.toContain(
      en['admin.people.banned'],
    );
  });

  it('чужое устройство отзывается, и отзыв виден сразу', async () => {
    const marta = person({
      devices: [{ id: 'dev-1', name: 'Ноутбук', lastSeenAt: null, revoked: false }],
    });
    await showPeople([marta]);

    click(testid(`admin-devices-${marta.fingerprint}`));
    click(testid('admin-revoke-dev-1'));
    expect(calls('admin-action').at(-1)?.[1]).toEqual({
      action: 'revoke-device',
      target: 'dev-1',
      confirm: true,
    });

    await answer('admin-action', { ok: true, action: 'revoke-device', count: 1 });
    expect(testid('admin-device-dev-1')?.textContent).toContain(en['admin.people.device.revoked']);
    expect(testid('admin-revoke-dev-1')).toBeNull();
  });

  it('своё устройство отозвать не дают — и объясняют почему именно', async () => {
    const boss = person({
      owner: true,
      devices: [{ id: 'dev-9', name: 'Этот', lastSeenAt: null, revoked: false }],
    });
    await showPeople([boss]);
    click(testid(`admin-devices-${boss.fingerprint}`));
    click(testid('admin-revoke-dev-9'));
    await answer('admin-action', { ok: false, error: 'forbidden' });

    // «Вы не владелец» здесь было бы неправдой: владение сервер уже проверил.
    expect(testid('admin-device-dev-9')?.textContent).toContain(en['admin.people.device.self']);
    expect(testid('admin-device-dev-9')?.textContent).not.toContain(en['refused.admin.forbidden']);
  });
});

describe('вкладка «Баны»', () => {
  beforeEach(mount);
  afterEach(unmount);

  it('строка бана — лицо, имя, короткий отпечаток, когда и кем', async () => {
    const entry = ban();
    await act(async () => {
      root.render(<BansTab />);
    });
    await answer('admin-bans', { ok: true, bans: [entry] });

    const row = testid(`admin-banned-${entry.fingerprint}`)!;
    expect(row.querySelector('.rl-identicon')).toBeTruthy();
    expect(row.textContent).toContain(entry.nick);
    expect(row.textContent).toContain(shortFingerprint(entry.fingerprint));
    expect(row.textContent).not.toContain(entry.fingerprint);
    expect(row.textContent).toContain(entry.by);
  });

  it('никого не забанили — так и написано', async () => {
    await act(async () => {
      root.render(<BansTab />);
    });
    expect(testid('admin-bans-busy')).toBeTruthy();
    await answer('admin-bans', { ok: true, bans: [] });
    expect(testid('admin-bans-empty')?.textContent).toBe(en['admin.bans.empty']);
  });

  it('разбан возвращает человека в список без перезагрузки панели', async () => {
    const entry = ban();
    // Оба списка уже показаны: человек забанен и виден на обеих вкладках.
    useAdminStore.setState({
      people: [person({ fingerprint: entry.fingerprint, nick: entry.nick, banned: true })],
      peopleLoaded: true,
      bans: [entry],
      bansLoaded: true,
    });
    await act(async () => {
      root.render(<BansTab />);
    });
    const asked = calls('admin-bans').length;

    click(testid(`admin-unban-${entry.fingerprint}`));
    expect(calls('admin-action').at(-1)?.[1]).toEqual({
      action: 'unban',
      target: entry.fingerprint,
      confirm: true,
    });
    await answer('admin-action', { ok: true, action: 'unban' });

    expect(testid('admin-bans-empty')).toBeTruthy();
    // Ни повторного вопроса о списке банов, ни повторного о людях: разбан
    // известен целиком, и человек перестаёт быть забаненным тем же мгновением.
    expect(calls('admin-bans').length).toBe(asked);
    expect(calls('admin-people').length).toBe(0);
    expect(useAdminStore.getState().people[0].banned).toBe(false);
  });

  it('бан на соседней вкладке помечает список несвежим', async () => {
    const marta = person();
    await showPeople([marta]);
    click(testid(`admin-ban-${marta.fingerprint}`));
    confirmBan();
    await answer('admin-action', { ok: true, action: 'ban' });

    // Когда и кем — знает только сервер, поэтому строку бана не сочиняем:
    // вкладка банов спросит её, когда её откроют.
    expect(useAdminStore.getState().bansLoaded).toBe(false);
  });
});

describe('панель находит место людям и банам', () => {
  const catalog: SettingSpec[] = [
    { key: 'zzz.flag', group: 'access', kind: 'boolean', fallback: true, applies: 'now' },
  ];
  const overview: AdminOverview = {
    people: 1,
    online: 1,
    bans: 0,
    messages: 0,
    servers: 0,
    channels: 0,
    storageBytes: 0,
    storageQuotaBytes: 0,
    retention: { mode: 'forever' },
    directRetention: null,
    version: '2.0.0',
  };

  beforeEach(mount);
  afterEach(unmount);

  it('у людей и банов свои вкладки, и сбрасывать к умолчаниям там нечего', async () => {
    useUiStore.setState({ adminOpen: true });
    await act(async () => {
      root.render(<AdminDialog />);
    });
    await answer('admin-state', { ok: true, catalog, values: { 'zzz.flag': true }, overview });

    expect(testid('admin-tab-identities')).toBeTruthy();
    expect(testid('admin-tab-bans')).toBeTruthy();

    click(testid('admin-tab-identities'));
    // `AnimatePresence mode="wait"` монтирует новую панель только после того,
    // как догасла прежняя, и гаснет она кадрами — ждать надо настоящее время.
    await wait(350);
    await answer('admin-people', { ok: true, people: [person()] });

    expect(testid('admin-people')).toBeTruthy();
    // «Вернуть к умолчаниям» на списке людей означало бы неизвестно что.
    expect(testid('admin-reset-group')).toBeNull();

    click(testid('admin-tab-bans'));
    await wait(350);
    await answer('admin-bans', { ok: true, bans: [] });
    expect(testid('admin-bans')).toBeTruthy();
    expect(testid('admin-reset-group')).toBeNull();
  });
});
