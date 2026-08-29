import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminOverview, SettingSpec, SettingsSnapshot } from '@relay/shared';

/**
 * Стор панели инсталляции.
 *
 * Проверяется здесь не «положили значение — оно лежит», а то, что ломается
 * молча и на глаз незаметно: поле, оставшееся в «сохраняется» навсегда;
 * откат, вернувший не то; правка со второго устройства, не доехавшая до
 * открытой панели. Всё это выглядит как работающая панель ровно до того
 * момента, когда владелец обнаруживает, что двигал поле впустую.
 */

const emit = vi.hoisted(() => vi.fn());
vi.mock('@/lib/socket', () => ({ getSocket: () => ({ emit }) }));

import { useAdminStore } from './admin';
import { useOwnerStore } from './owner';

/** Ответить за сервер: подтверждение — всегда последний аргумент вызова. */
function answer(call: unknown[] | undefined, res: unknown) {
  const cb = call?.at(-1);
  if (typeof cb !== 'function') throw new Error('в этом вызове нечем ответить');
  (cb as (r: unknown) => void)(res);
}

const replyLast = (res: unknown) => answer(emit.mock.calls.at(-1), res);
/** Ответить на вызов по счёту — тем самым и с опозданием, после следующего. */
const replyTo = (n: number, res: unknown) => answer(emit.mock.calls[n], res);

const admin = () => useAdminStore.getState();

const LENGTH = 'messages.maxLength';
const DIRECT = 'direct.enabled';
const PASSWORD = 'access.sitePasswordSet';
const TURN = 'voice.turnSecretSet';

/**
 * Каталог с сервера — маленький, но со всеми видами, ради которых стор и
 * различает дороги: обычное число, флаг, секрет сменяемый и секрет из
 * окружения.
 */
const catalog: SettingSpec[] = [
  {
    key: LENGTH,
    group: 'messages',
    kind: 'number',
    fallback: 500,
    applies: 'now',
    min: 1,
    max: 4000,
  },
  { key: DIRECT, group: 'direct', kind: 'boolean', fallback: true, applies: 'now', danger: true },
  { key: PASSWORD, group: 'access', kind: 'secret', fallback: '', applies: 'now', secret: true },
  {
    key: TURN,
    group: 'voice',
    kind: 'secret',
    fallback: '',
    applies: 'env',
    secret: true,
    readOnly: true,
  },
];

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

/** Открыть панель: спросить состояние и ответить за сервер. */
async function open(
  values: SettingsSnapshot = { [LENGTH]: 500, [DIRECT]: true, [PASSWORD]: false },
) {
  const loading = admin().load();
  replyLast({ ok: true, catalog, values, overview });
  await loading;
  emit.mockClear();
}

beforeEach(() => {
  emit.mockClear();
  admin().reset();
  useOwnerStore.setState({ owner: true, claiming: null });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('открытие панели', () => {
  it('привозит каталог с сервера, значения и сводку', async () => {
    await open();
    // Каталог именно серверный: параметры добавляются в любом выпуске, а своя
    // копия показала бы поля, которых этот сервер не знает.
    expect(admin().catalog.map((s) => s.key)).toEqual([LENGTH, DIRECT, PASSWORD, TURN]);
    expect(admin().values[LENGTH]).toBe(500);
    expect(admin().overview?.people).toBe(3);
    expect(admin().loaded).toBe(true);
  });

  it('без владельца не спрашивает сервер вовсе', async () => {
    useOwnerStore.setState({ owner: false });
    await admin().load();
    expect(emit).not.toHaveBeenCalled();
    // Прав стор не проверяет — их проверяет сервер; но и заведомо пустой
    // запрос не шлёт. Отказ при этом виден, а не проглочен.
    expect(admin().error).toBe('forbidden');
    expect(admin().loaded).toBe(false);
  });

  it('отказ на состояние виден, а не выглядит пустой панелью', async () => {
    const loading = admin().load();
    replyLast({ ok: false, error: 'forbidden' });
    await loading;
    expect(admin().error).toBe('forbidden');
  });
});

describe('правка параметра', () => {
  it('оптимистично показывает новое значение и откатывает при отказе', async () => {
    await open();

    const saving = admin().set(LENGTH, 9000);
    // Значение показано ДО ответа сервера: иначе поле дёргается обратно на
    // время сети, и человек успевает нажать его второй раз.
    expect(admin().values[LENGTH]).toBe(9000);
    expect(admin().saving).toEqual([LENGTH]);
    expect(emit).toHaveBeenCalledWith(
      'admin-set',
      { key: LENGTH, value: 9000 },
      expect.any(Function),
    );

    replyLast({ ok: false, error: 'out-of-range' });
    await saving;

    expect(admin().values[LENGTH]).toBe(500);
    expect(admin().saving).toEqual([]);
    // Причина, а не тишина: молчаливый откат неотличим от «панель сломана».
    expect(admin().errors[LENGTH]).toBe('out-of-range');
  });

  it('принятое значение берётся из ответа, а пометка снимается', async () => {
    await open();
    const saving = admin().set(LENGTH, 800);
    replyLast({ ok: true, key: LENGTH, changed: true, value: 800 });
    await saving;
    expect(admin().values[LENGTH]).toBe(800);
    expect(admin().saving).toEqual([]);
    expect(admin().errors[LENGTH]).toBeUndefined();
  });

  it('две правки одного поля подряд не оставляют его в «сохраняется»', async () => {
    await open();

    const first = admin().set(LENGTH, 800);
    const second = admin().set(LENGTH, 900);

    // Ответ на ПЕРВУЮ приходит, когда вторая уже в полёте. Он не снимает
    // пометку, поставленную второй, и не откатывает её значение: иначе поле
    // либо застревало бы в «сохраняется» навсегда, либо показывало бы то, что
    // человек уже переписал.
    replyTo(0, { ok: false, error: 'out-of-range' });
    await first;

    expect(admin().saving).toEqual([LENGTH]);
    expect(admin().values[LENGTH]).toBe(900);
    expect(admin().errors[LENGTH]).toBeUndefined();

    replyTo(1, { ok: true, key: LENGTH, changed: true, value: 900 });
    await second;

    expect(admin().saving).toEqual([]);
    expect(admin().values[LENGTH]).toBe(900);
  });

  it('молчание сервера тоже снимает «сохраняется» и возвращает прежнее', async () => {
    await open();
    const saving = admin().set(LENGTH, 800);
    await vi.advanceTimersByTimeAsync(9000);
    await saving;
    expect(admin().saving).toEqual([]);
    expect(admin().values[LENGTH]).toBe(500);
    expect(admin().errors[LENGTH]).toBe('timeout');
  });

  it('опасное умеет уехать с подтверждением, а без него объясняет отказ', async () => {
    await open();

    const refused = admin().set(DIRECT, false);
    expect(emit).toHaveBeenCalledWith(
      'admin-set',
      { key: DIRECT, value: false },
      expect.any(Function),
    );
    replyLast({ ok: false, error: 'needs-confirm' });
    await refused;
    expect(admin().errors[DIRECT]).toBe('needs-confirm');
    expect(admin().values[DIRECT]).toBe(true);

    const confirmed = admin().set(DIRECT, false, { confirm: true });
    expect(emit).toHaveBeenCalledWith(
      'admin-set',
      { key: DIRECT, value: false, confirm: true },
      expect.any(Function),
    );
    replyLast({ ok: true, key: DIRECT, changed: true, value: false });
    await confirmed;
    expect(admin().values[DIRECT]).toBe(false);
    // Прежний отказ снят: поле тронули заново, и старая подпись под ним врала бы.
    expect(admin().errors[DIRECT]).toBeUndefined();
  });

  it('секрет общей дорогой не уезжает вовсе', async () => {
    await open();
    await admin().set(PASSWORD, 'тайна');
    // Не «сервер откажет», а «мы не посылаем»: у пароля своя дорога, и уехать
    // мимо неё он не должен даже для того, чтобы получить отказ.
    expect(emit).not.toHaveBeenCalled();
    expect(admin().errors[PASSWORD]).toBe('secret-path');
  });
});

describe('правка из другой сессии владельца', () => {
  it('чужая правка приезжает в поле', async () => {
    await open();
    admin().applyRemote({ keys: [DIRECT], values: { [DIRECT]: false } });
    expect(admin().values[DIRECT]).toBe(false);
  });

  it('не перебивает правку, которая сейчас в полёте, но меняет то, куда откатывать', async () => {
    await open();

    const saving = admin().set(LENGTH, 800);
    admin().applyRemote({ keys: [LENGTH], values: { [LENGTH]: 600 } });
    // Своя правка новее чужой: показанное человеку не подменяем под руками.
    expect(admin().values[LENGTH]).toBe(800);

    replyLast({ ok: false, error: 'out-of-range' });
    await saving;
    // Откат — к тому, что сервер подтвердил ПОСЛЕДНИМ, а не к тому, что было
    // на экране до правки: иначе панель вернула бы заведомо устаревшее.
    expect(admin().values[LENGTH]).toBe(600);
  });
});

describe('сброс группы', () => {
  it('подтверждение уезжает всегда, а пришедшие значения ложатся в поля', async () => {
    await open({ [LENGTH]: 800, [DIRECT]: false, [PASSWORD]: false });

    const resetting = admin().resetGroup('direct');
    expect(emit).toHaveBeenCalledWith(
      'admin-reset',
      { group: 'direct', confirm: true },
      expect.any(Function),
    );
    replyLast({ ok: true, group: 'direct', changed: [DIRECT], values: { [DIRECT]: true } });
    await resetting;

    expect(admin().values[DIRECT]).toBe(true);
    // Соседняя группа не тронута: сброс приезжает своими ключами, а не снимком.
    expect(admin().values[LENGTH]).toBe(800);
  });

  it('отказ на сброс не пропадает', async () => {
    await open();
    const resetting = admin().resetGroup('direct');
    replyLast({ ok: false, error: 'forbidden' });
    await resetting;
    expect(admin().error).toBe('forbidden');
  });
});

describe('пароль инсталляции', () => {
  it('идёт своей дорогой и обновляет признак «задано»', async () => {
    await open();

    const saving = admin().setPassword('тайна');
    expect(emit).toHaveBeenCalledWith(
      'admin-password',
      { password: 'тайна', confirm: true },
      expect.any(Function),
    );
    replyLast({ ok: true, set: true, changed: true, count: 2 });
    await saving;

    // Признак, а не значение: сервер знает только хэш, и показывать нечего.
    // Ключ найден по каталогу — сменить можно ровно один секрет, остальные
    // живут в окружении.
    expect(admin().values[PASSWORD]).toBe(true);
    expect(admin().values[TURN]).toBeUndefined();
  });

  it('отказ подписывается под тем же полем', async () => {
    await open();
    const saving = admin().setPassword('');
    replyLast({ ok: false, error: 'needs-confirm' });
    await saving;
    expect(admin().errors[PASSWORD]).toBe('needs-confirm');
  });
});
