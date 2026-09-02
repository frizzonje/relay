import { expect, type Browser, type Page } from '@playwright/test';
import { person, test, unique } from '../fixtures/stand';

/**
 * Панель владельца — на живом стенде.
 *
 * Юнит-тесты панели проверяют её по частям: каталог, поля, отказы сервера,
 * журнал. Здесь проверяется то, чего по частям не увидеть, — что правка,
 * сделанная пальцем в окне, ДОХОДИТ до поведения инсталляции и доходит СРАЗУ:
 * без перезапуска контейнера, без перезагрузки чужой вкладки, без «а теперь
 * подождите час».
 *
 * Что нужно стенду:
 *
 *   - поднятый прод-стек (см. заголовок playwright.config);
 *   - `SITE_PASSWORD`, если ворота инсталляции включены;
 *   - `OWNER_TOKEN` — свежий ключ владельца, тот самый, что печатает
 *     `relay owner-link`. Без него весь файл пропускается: власть на
 *     инсталляции выдаёт только тот, у кого есть машина, и выдумать её тест
 *     не может.
 *
 *       docker compose exec api node dist/owner-link.js
 *
 * ПОЧЕМУ ФАЙЛ ГОНЯЕТСЯ ОТДЕЛЬНО И ТОЛЬКО ПО ПРОСЬБЕ. Остальные спеки изолированы
 * друг от друга именами (см. fixtures/stand), но режим обслуживания именем не
 * изолируешь: он запирает дверь ВСЕЙ инсталляции, и соседний спек, которому в
 * эту секунду понадобилось завести человека, честно получил бы экран
 * «закрыто». Поэтому в CI, где `OWNER_TOKEN` не задан, эти проверки
 * пропускаются, а руками их гоняют отдельным прогоном:
 *
 *   OWNER_TOKEN=… npx playwright test admin.spec.ts
 *
 * ВЛАДЕЛЕЦ ЗДЕСЬ ОДИН НА ВЕСЬ ФАЙЛ, и это не экономия. Ссылка владельца сгорает
 * с первого раза (см. OwnerService.claim) — второй тест по тому же ключу власти
 * бы не получил. Поэтому личность хозяйки заводится один раз и живёт до конца
 * файла, а тесты идут по порядку (`mode: 'serial'`): второй из них опирается на
 * то, что первый уже взял власть.
 *
 * И каждый тест убирает за собой сам: инсталляция после него обязана остаться
 * такой же, какой была. Ретенция возвращается к прежнему сроку, обслуживание
 * выключается в `finally` — иначе упавший на середине прогон оставил бы стенд
 * запертым, и следующий человек искал бы поломку не там.
 */

const TOKEN = process.env.OWNER_TOKEN ?? '';

const NEEDS_TOKEN = 'нужен свежий ключ владельца: docker compose exec api node dist/owner-link.js';

test.describe.configure({ mode: 'serial' });

/**
 * Хозяйка инсталляции: заводится с первым тестом, которому понадобилась, и
 * живёт до конца файла. Контекст, созданный в тесте, Playwright между тестами
 * одного воркера не закрывает — на этом и стоит.
 */
let hostess: Page | null = null;

async function owner(browser: Browser): Promise<Page> {
  if (hostess && !hostess.isClosed()) return hostess;
  const page = await person(browser, unique('Хозяйка'));
  // Власть берётся тем же путём, что и у живого человека: ссылкой из терминала.
  await page.goto(`/?owner=1#owner=${TOKEN}`);
  await page.getByRole('button', { name: 'Make this identity the owner' }).click();
  // Щит в тулбаре — и есть доказательство, что власть перешла: кнопку рисует
  // только владелец (см. Toolbar). Ждём её, а не секунды: на нагруженном стенде
  // ответ приходит и через пять.
  await expect(page.getByTestId('toolbar-admin')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Escape');
  hostess = page;
  return page;
}

/**
 * Открыть панель.
 *
 * Ждём ленту вкладок, а не содержимое сводки: открытая панель помнит вкладку, на
 * которой её закрыли, и «жду сводку» означало бы «жду того, чего в этот раз не
 * покажут». Вкладки же есть всегда, какая бы из них ни была выбрана.
 *
 * И ждём вкладку ГРУППЫ, а не только своих: вкладки без параметров нарисованы с
 * первого кадра, а группы приезжают каталогом с сервера — панель, пойманная до
 * его приезда, показывает пять вкладок из семнадцати и выглядит открытой.
 */
async function panel(page: Page): Promise<void> {
  const shield = page.getByTestId('toolbar-admin');
  await expect(shield).toBeVisible({ timeout: 30_000 });
  await shield.click();
  await expect(page.getByTestId('admin-tab-overview')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('admin-tab-maintenance')).toBeVisible({ timeout: 30_000 });
}

/** Вкладка панели по её ключу. */
async function tab(page: Page, name: string): Promise<void> {
  await page.getByTestId(`admin-tab-${name}`).click();
}

async function closePanel(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('admin-tab-overview')).toHaveCount(0, { timeout: 15_000 });
}

interface Config {
  retentionMode: string;
  retentionDays: number;
  settings: Record<string, unknown>;
}

/**
 * Публичный ответ инсталляции — тот самый, по которому вкладка узнаёт, как
 * инсталляция устроена. Спрашиваем его пропуском той же вкладки: без него
 * запертая инсталляция ответит 401, и «настройка не доехала» было бы неотличимо
 * от «нас не пустили».
 */
async function config(page: Page): Promise<Config> {
  const res = await page.request.get('/api/config');
  expect(res.ok(), 'GET /api/config').toBeTruthy();
  return (await res.json()) as Config;
}

/**
 * Срок хранения — параметр с `applies: 'now'`, и «сразу» здесь проверяется
 * буквально: тот же процесс api, никаких перезапусков, а ответ `/api/config`
 * меняется через секунды после нажатия. Ретенцию исполняет и показывает один и
 * тот же сервис (см. ConfigController), поэтому новое число в ответе значит,
 * что по нему теперь и подметают.
 */
test('владелец меняет параметр, и он действует без перезапуска', async ({ browser }) => {
  test.setTimeout(180_000);
  test.skip(!TOKEN, NEEDS_TOKEN);

  const her = await owner(browser);
  const before = await config(her);
  expect(
    before.retentionMode,
    'стенд поднят с чужой ретенцией — верните RETENTION_DAYS к умолчанию',
  ).toBe('days');

  // Число заметное и заведомо большее прежнего: проверка не должна нечаянно
  // подмести переписку, которой в этот момент живут соседние спеки.
  const days = 1234;

  try {
    await panel(her);
    await tab(her, 'messages');
    const field = her.getByTestId('admin-field-messages.retentionDays');
    await expect(field).toBeVisible({ timeout: 15_000 });
    // Рядом с полем написано, когда правка подействует. Если однажды каталог
    // передумает и напишет «после перезапуска» — проверка ниже станет ложью, и
    // узнать об этом надо здесь, а не из отчёта человека.
    await expect(her.getByTestId('admin-applies-messages.retentionDays')).toHaveText(
      'applies at once',
    );

    const input = field.locator('input[type="number"]');
    await input.fill(String(days));
    await input.press('Enter');

    await expect
      .poll(async () => (await config(her)).retentionDays, { timeout: 30_000 })
      .toBe(days);
  } finally {
    const input = her
      .getByTestId('admin-field-messages.retentionDays')
      .locator('input[type="number"]');
    if (await input.isVisible().catch(() => false)) {
      await input.fill(String(before.retentionDays));
      await input.press('Enter');
      await expect
        .poll(async () => (await config(her)).retentionDays, { timeout: 30_000 })
        .toBe(before.retentionDays);
    }
    await closePanel(her).catch(() => {});
  }
});

/**
 * Панели у обычного человека нет — и нет именно в разметке, а не «спрятана».
 * Кнопка, которой нет, ничего не запрещает сама по себе: каждое событие панели
 * сервер проверяет отдельно (§9 протокола, тесты гейтвея), — но нарисованный
 * щит у не-владельца был бы приглашением постучаться и обещанием, которого
 * инсталляция не держит.
 *
 * Вторая половина — про то же, но со стороны сервера: в публичном ответе не
 * должно быть ни одного параметра, который панель показывает только владельцу.
 * Отбор живёт в каталоге (пометка `client`), и разъехаться он может молча:
 * список стоп-слов, розданный всем, — подсказка тем, против кого он заведён, а
 * маски закрытых адресов — карта обхода.
 */
test('не владельцу панель не открывается и внутренности инсталляции не видны', async ({
  browser,
}) => {
  test.setTimeout(120_000);

  const stranger = await person(browser, unique('Прохожий'));
  await expect(stranger.getByTestId('toolbar-admin')).toHaveCount(0);

  const settings = (await config(stranger)).settings;
  expect(Object.keys(settings).length).toBeGreaterThan(0);
  for (const key of [
    'access.sitePasswordSet',
    'access.blockedAddresses',
    'access.unlockAttempts',
    'moderation.bannedWords',
    'maintenance.mode',
  ]) {
    expect(Object.keys(settings), `${key} не должен уезжать в чужой браузер`).not.toContain(key);
  }
});

/**
 * Обслуживание — единственный параметр, который выключает инсталляцию целиком,
 * и проверяется он с обеих сторон сразу: отвергнутый видит экран с текстом
 * владельца, а сам владелец продолжает работать — иначе включивший режим
 * запирал бы себя снаружи и чинил бы это уже через ssh.
 *
 * Прохожий заводится ДО того, как дверь закрылась: режим запирает вход, а не
 * выгоняет из комнаты (см. perimeter.recognize), и увидеть отказ можно только
 * постучавшись заново.
 */
test('режим обслуживания закрывает вход всем, кроме владельца', async ({ browser }) => {
  test.setTimeout(180_000);
  test.skip(!TOKEN, NEEDS_TOKEN);

  const her = await owner(browser);
  const stranger = await person(browser, unique('Прохожий'));
  const notice = unique('чиним свет');

  try {
    await panel(her);
    await tab(her, 'maintenance');

    // Сперва текст, потом замок: текст едет отвергнутому вместе с отказом
    // двери, и написанный после того, как дверь закрылась, он не доехал бы до
    // тех, кто уже стучится.
    const message = her.getByTestId('admin-field-maintenance.message').locator('textarea');
    await expect(message).toBeVisible({ timeout: 15_000 });
    await message.fill(notice);
    await message.blur();

    const mode = her.getByTestId('admin-field-maintenance.mode').getByRole('switch');
    await mode.click();
    // Режим опасный — панель спрашивает, и это часть пути, а не помеха ему.
    await her.getByRole('button', { name: 'Change', exact: true }).click();
    await expect(mode).toHaveAttribute('aria-checked', 'true', { timeout: 15_000 });

    // Прохожего не пускают, и он читает то, что написал владелец, а не
    // «переподключаюсь».
    await stranger.reload();
    await expect(stranger.getByTestId('maintenance-message')).toHaveText(notice, {
      timeout: 45_000,
    });

    // А владелец заходит и на перезаходе: панель, из которой режим выключают,
    // обязана оставаться доступной.
    await her.reload();
    await expect(her.getByText('общий', { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(her.getByTestId('maintenance-message')).toHaveCount(0);
  } finally {
    await maintenanceOff(her);
  }
});

/**
 * Выключить обслуживание чем бы тест ни кончился. Через ту же панель, а не в
 * обход неё: если выключение работает только запросом мимо интерфейса, то
 * владелец, включивший режим пальцем, обратно его пальцем не выключит.
 */
async function maintenanceOff(page: Page): Promise<void> {
  try {
    const open = await page
      .getByTestId('admin-tab-overview')
      .isVisible()
      .catch(() => false);
    if (!open) await panel(page);
    await tab(page, 'maintenance');
    const mode = page.getByTestId('admin-field-maintenance.mode').getByRole('switch');
    await expect(mode).toBeVisible({ timeout: 15_000 });
    if ((await mode.getAttribute('aria-checked')) === 'true') {
      await mode.click();
      await page.getByRole('button', { name: 'Change', exact: true }).click();
      await expect(mode).toHaveAttribute('aria-checked', 'false', { timeout: 15_000 });
    }
    const message = page.getByTestId('admin-field-maintenance.message').locator('textarea');
    await message.fill('');
    await message.blur();
    await closePanel(page);
  } catch (err) {
    // Молчаливая неудача уборки оставила бы стенд запертым, и следующий прогон
    // падал бы там, где ничего не ломалось.
    console.log(
      '[admin] обслуживание не выключилось:',
      String((err as Error).message).slice(0, 200),
    );
  }
}

/**
 * Телефон. Вкладок в панели семнадцать, а ширины у телефона — 375 точек, и
 * лента, уехавшая вбок, прячет последние из них целиком: горизонтальной
 * прокрутки на телефоне не видно, и её край выглядит краем списка. Проверка
 * поэтому не про класс в разметке, а про то же, что видит палец: каждая вкладка
 * обязана быть В КАДРЕ, и до последней («Обслуживание») можно дотянуться, не
 * отгадывая, что список продолжается.
 */
test('с телефона: все вкладки панели видны без горизонтальной прокрутки', async ({ browser }) => {
  test.setTimeout(180_000);
  test.skip(!TOKEN, NEEDS_TOKEN);

  const her = await owner(browser);
  await her.setViewportSize({ width: 375, height: 812 });

  try {
    await panel(her);
    const tabs = her.locator('nav [data-testid^="admin-tab-"]');
    const count = await tabs.count();
    // Семнадцать: сводка, двенадцать групп каталога и четыре вкладки без
    // параметров. Число здесь — не проверка каталога, а страховка от того,
    // чтобы проверка ниже не оказалась «все три вкладки на месте».
    expect(count).toBeGreaterThan(12);

    for (let at = 0; at < count; at += 1) {
      const item = tabs.nth(at);
      await expect(item, await item.getAttribute('data-testid')).toBeInViewport();
    }

    // И до последней действительно дотягиваются: видно — значит нажимается.
    await tab(her, 'upkeep');
    await expect(her.getByTestId('admin-upkeep')).toBeVisible({ timeout: 20_000 });
  } finally {
    await closePanel(her).catch(() => {});
    await her.setViewportSize({ width: 1280, height: 720 });
  }
});
