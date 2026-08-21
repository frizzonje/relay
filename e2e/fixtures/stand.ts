import {
  devices,
  expect,
  test as base,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

/**
 * Общая часть всех спеков: как в relay заходит человек, как он заводит сервер
 * и как открывает канал.
 *
 * До этого файла каждый спек носил свою копию — семь почти одинаковых `person`,
 * расходившихся в мелочах (один умел нажать «Try again», другой нет). Копия,
 * которую поправили в одном месте из семи, — это не страховка, а её вид.
 *
 * ВАЖНЕЕ ОДНАКО ДРУГОЕ. Спеки не были изолированы друг от друга: каждый заводил
 * сервер «Дом» и канал «болталка» под этими самыми именами, и в общем прогоне
 * второй такой же спутывал и людей, и проверки — `getByText('болталка')`
 * находил три строки, `.first()` выбирал чужую. Поэтому спеки и гонялись по
 * одному на чистой базе, то есть весь прогон целиком в CI был красным и никем
 * не читался. Лечится это здесь: имена берутся через `unique()`, и двух
 * одинаковых на стенде не бывает — ни между спеками, ни между прогонами.
 */

export const PASSWORD = process.env.SITE_PASSWORD || '';
export const BASE = process.env.BASE_URL || 'https://localhost';

/**
 * Метка этого прогона в этом воркере. Индекс воркера — потому что файлы
 * Playwright гоняет параллельно и два процесса стартуют в одну и ту же
 * миллисекунду; время — потому что при повторе индекс тот же, а стенд между
 * прогонами не чистят.
 */
const RUN = `${process.env.TEST_WORKER_INDEX ?? 0}${Date.now().toString(36).slice(-4)}`;
let seq = 0;

/**
 * Имя, которого на стенде больше ни у кого нет. Счётчик — потому что один
 * воркер прогоняет несколько файлов подряд, не перезапускаясь: без него
 * «болталка» из соседнего спека была бы ровно той же строкой.
 *
 * Ник с такой меткой остаётся ником: `sanitizeNick` пропускает буквы, цифры и
 * дефис, а `NICK_MAX` — двадцать символов, в которые метка укладывается.
 */
export function unique(name: string): string {
  seq += 1;
  return `${name}-${RUN}${seq.toString(36)}`;
}

/** Что нужно этому человеку сверх обычного захода. */
export interface PersonOptions {
  /** Разрешения контексту: голосовым спекам нужен микрофон. */
  permissions?: string[];
  /**
   * Человек с телефона: узкий экран и тач вместо мыши. Именно тач тут главное —
   * на мобильной раскладке половина кнопок раньше жила на ховере, которого на
   * телефоне не бывает, и спек с настольным браузером узкого окна этого не
   * ловит (мышь в нём есть).
   */
  mobile?: boolean;
}

/**
 * Человек с собственным ключом: свой контекст, своя личность, своё имя.
 *
 * Личность настоящая — ключ рождается в браузере на первом заходе, и подменить
 * его нечем. Отсюда и порядок шагов: ворота инсталляции, потом выбор имени,
 * и только потом приложение.
 */
export async function person(
  browser: Browser,
  nick: string,
  options: PersonOptions = {},
): Promise<Page> {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    ...(options.mobile ? devices['Pixel 7'] : {}),
    ...(options.permissions ? { permissions: options.permissions } : {}),
  });
  await ctx.addCookies([{ name: 'relay-lang', value: 'en', url: BASE }]);
  const page = await ctx.newPage();
  await page.goto('/');

  // Ворота инсталляции, если они включены.
  const pass = page.getByPlaceholder('Password');
  if (PASSWORD && (await pass.isVisible().catch(() => false))) {
    await pass.fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }

  // Стенд иногда встречает первым кадром «сервер не ответил» — api ещё
  // поднимался. Это не то, что мы проверяем.
  const retry = page.getByRole('button', { name: 'Try again' });
  if (await retry.isVisible().catch(() => false)) {
    await retry.click();
    await page.waitForTimeout(1500);
  }

  // Первый заход спрашивает имя — ключ к этому моменту уже родился.
  const cont = page.getByRole('button', { name: 'Continue' });
  await cont.waitFor({ state: 'visible', timeout: 25_000 }).catch(() => {});
  if (await cont.isVisible().catch(() => false)) {
    await page.locator('form input').first().fill(nick);
    await cont.click();
    await cont.waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {});
  }

  await ready(page);
  crowd.push(page);
  return page;
}

/**
 * Второе устройство того же человека: та же сессионная кука личности, пустые
 * localStorage и IndexedDB. Пустое хранилище и есть то единственное, чем второй
 * компьютер отличается от первого, — всё остальное он получает от сервера.
 */
export async function secondDevice(browser: Browser, from: Page): Promise<Page> {
  const cookies = (await from.context().cookies()).filter((c) => c.name !== 'relay-lang');
  const ctx: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true });
  await ctx.addCookies([{ name: 'relay-lang', value: 'en', url: BASE }, ...cookies]);
  const page = await ctx.newPage();
  await page.goto('/');
  await ready(page);
  crowd.push(page);
  return page;
}

/**
 * Приложение открыто и разговаривает с сервером: главный сервер с его «общим»
 * приехал по сокету, значит реестр доехал и рейка нарисована.
 *
 * Заодно снимаем оверлей дев-инструментов Next: он перехватывает клики в левом
 * нижнем углу, а там же живут кнопки рейки.
 */
async function ready(page: Page): Promise<void> {
  await expect(page.getByText('общий', { exact: true })).toBeVisible({ timeout: 25_000 });
  await page.evaluate(() => document.querySelectorAll('nextjs-portal').forEach((n) => n.remove()));
}

/** Кнопка сервера в рейке: её подпись — имя сервера (см. ServerRail). */
export function serverButton(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

/**
 * Открыть сервер, заведённый кем-то другим. Ждём саму кнопку, а не «секунды
 * три»: реестр приезжает по сокету, и на загруженном стенде он приезжает
 * дольше, чем на пустом.
 */
export async function openServer(page: Page, name: string): Promise<void> {
  const button = serverButton(page, name);
  await expect(button).toBeVisible({ timeout: 25_000 });
  await button.click();
}

/** Открыть текстовый канал и дождаться поля ввода. */
export async function openChannel(page: Page, channel: string): Promise<void> {
  await page.getByText(channel, { exact: true }).click();
  await expect(page.getByPlaceholder(/^message #/)).toBeVisible({ timeout: 15_000 });
}

/** Сказать в открытом канале. */
export async function say(page: Page, text: string): Promise<void> {
  const composer = page.getByPlaceholder(/^message #/);
  await composer.fill(text);
  await composer.press('Enter');
}

/**
 * Свой сервер с первым текстовым каналом — чтобы разговаривать в своём, а не в
 * чужом: модерирует сервер его создатель, и права проверяются только там.
 *
 * С паролем сервер становится закрытым: в рейке он у всех, а каналы — только у
 * тех, кто пароль ввёл.
 */
export async function createServer(
  page: Page,
  server: string,
  channel: string,
  options: { password?: string } = {},
): Promise<void> {
  await page.getByRole('button', { name: 'Create a server' }).click();
  await page.getByPlaceholder('My server').fill(server);
  if (options.password) {
    await page.getByPlaceholder('no password — an open server').fill(options.password);
  }
  await page.getByRole('button', { name: 'Create server' }).click();
  litter.push({ page, server });
  // Создание сервера само зовёт завести первый канал — окно уже открыто, и
  // спрашивать «а не открыто ли оно» тут нельзя: на первом кадре его ещё нет,
  // и ответ «нет» уводил бы жать кнопку, которой в этот момент не видно.
  await fillChannel(page, channel);
}

/** Ещё один текстовый канал текущего сервера. */
export async function createChannel(page: Page, channel: string): Promise<void> {
  await page.locator('button[aria-label="Create a text channel"]:visible').first().click();
  await fillChannel(page, channel);
}

/**
 * Заполнить открытое окно создания канала. Ждём строку канала в сайдбаре, а не
 * фиксированную паузу: канал появляется рассылкой реестра, у которой есть своё
 * окно коалесцирования (см. api/gateway/directory).
 */
async function fillChannel(page: Page, channel: string): Promise<void> {
  const field = page.getByPlaceholder('new-channel');
  await field.waitFor({ state: 'visible', timeout: 20_000 });
  await field.fill(channel);
  await page.getByRole('button', { name: 'Create channel' }).click();
  await expect(page.getByText(channel, { exact: true })).toBeVisible({ timeout: 20_000 });
}

/**
 * Голосовой канал своего сервера. Режим выбирается прямо в окне создания:
 * «Through the server» недоступен, пока медиасервер не поднят, — поэтому спек,
 * которому он нужен, на невзведённом стенде честно упадёт здесь, а не через
 * минуту на непонятном месте.
 */
export async function createVoiceChannel(
  page: Page,
  channel: string,
  mode: 'p2p' | 'sfu' = 'p2p',
): Promise<void> {
  await page.locator('button[aria-label="Create a voice channel"]:visible').first().click();
  const field = page.getByPlaceholder('meeting-room');
  await field.waitFor({ state: 'visible', timeout: 20_000 });
  if (mode === 'sfu') await page.getByRole('button', { name: /Through the server/ }).click();
  await field.fill(channel);
  await page.getByRole('button', { name: 'Create channel' }).click();
  await expect(page.getByText(channel, { exact: true })).toBeVisible({ timeout: 20_000 });
}

/**
 * Зайти в голосовой канал и дождаться своей плитки: она и значит, что заход
 * состоялся, — до неё интерфейс показывает канал, но не эфир.
 */
export async function joinVoice(page: Page, channel: string, nick: string): Promise<void> {
  await page.getByText(channel, { exact: true }).click();
  await expect(page.getByText(`${nick} (you)`).first()).toBeVisible({ timeout: 25_000 });
}

/**
 * Плитка собеседника на сцене. Считаем именно её: имя человека написано ещё и
 * в списке участников сбоку, и `getByText` находит оба места — «плиток две»
 * тогда значит «плитка и строка», а не то, о чём проверка спрашивала.
 */
export const tile = (page: Page, nick: string) =>
  page.getByRole('button', { name: `${nick}: expand to fill the stage` });

/**
 * Дождаться, что соединение с собеседником и правда встало: миллисекунды в
 * панели считаются по `getStats` живого `RTCPeerConnection` — пока пиры не
 * договорились, там `waiting`, а не число.
 */
export async function connected(page: Page): Promise<void> {
  await expect(page.getByText(/latency:\s*\d+ ms/)).toBeVisible({ timeout: 45_000 });
}

// ─────────────────────────────────────────────────────────────────────────
// Уборка за собой
// ─────────────────────────────────────────────────────────────────────────

/**
 * Серверы на инсталляции не бесконечны: их двадцать (`MAX_SERVERS`), а полный
 * прогон заводит около шести. Стенд, поднятый один раз на день работы, упирался
 * в потолок к третьему прогону — и упирался молча: сервер просто не создавался,
 * а спек падал через двадцать секунд на «где мой канал», ничего не сказав про
 * настоящую причину. Поэтому спеки убирают за собой, а не полагаются на то, что
 * кто-то помнит про `down -v`.
 */
const crowd: Page[] = [];
const litter: { page: Page; server: string }[] = [];

/**
 * Общий `test` для всех спеков: тот же, что у Playwright, плюс уборка после
 * каждого теста. Фикстура `auto`, потому что убирать надо всегда, а не когда
 * спек вспомнил её попросить.
 */
export const test = base.extend<{ tidy: void }>({
  tidy: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await use();
      // Сначала из эфиров: пока в голосовом канале сервера кто-то есть, сервер
      // удаляться отказывается (см. DeleteServerDialog — кнопка просто не
      // предлагается).
      for (const page of crowd.splice(0)) await hangUp(page).catch(() => {});
      for (const { page, server } of litter.splice(0)) {
        await removeServer(page, server).catch(() => {});
      }
    },
    { auto: true },
  ],
});

async function hangUp(page: Page): Promise<void> {
  if (page.isClosed()) return;
  const leave = page.getByRole('button', { name: 'Disconnect' });
  if (await leave.isVisible().catch(() => false)) await leave.click({ timeout: 20_000 });
}

/**
 * Убрать за собой сервер. Со второй попытки, если первая не вышла: к моменту
 * уборки на странице может быть открыт диалог (его закрывает Escape), а состав
 * эфиров сервер пересчитывает не мгновенно — а пока в эфире кто-то есть,
 * удаление он не предложит вовсе.
 */
async function removeServer(page: Page, server: string): Promise<void> {
  if (page.isClosed()) return;
  await page.keyboard.press('Escape').catch(() => {});
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await tryRemove(page, server)) return;
    await page.waitForTimeout(2000);
  }
}

async function tryRemove(page: Page, server: string): Promise<boolean> {
  const button = serverButton(page, server);
  if (!(await button.isVisible().catch(() => false))) return true; // уже нет
  try {
    await button.click({ timeout: 20_000 });
    // Крестик в шапке сайдбара и кнопка подтверждения зовутся одинаково —
    // «Delete server»; вторая живёт в диалоге, им и различаем.
    await page
      .getByRole('button', { name: 'Delete server', exact: true })
      .first()
      .click({ timeout: 20_000 });
    const dialog = page.getByRole('dialog');
    await dialog
      .getByRole('button', { name: 'Delete server', exact: true })
      .click({ timeout: 15_000 });
    await expect(button).toHaveCount(0, { timeout: 15_000 });
    return true;
  } catch (err) {
    // Молчаливая неудача уборки — ровно то, из-за чего потолок серверов
    // когда-то выглядел загадкой: спек падал не там, где ломалось.
    console.log('[tidy]', server, 'остался:', String((err as Error).message).slice(0, 200));
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
}
