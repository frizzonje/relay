import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

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
 */
export async function createServer(page: Page, server: string, channel: string): Promise<void> {
  await page.getByRole('button', { name: 'Create a server' }).click();
  await page.getByPlaceholder('My server').fill(server);
  await page.getByRole('button', { name: 'Create server' }).click();
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
 * Дождаться, что соединение с собеседником и правда встало: миллисекунды в
 * панели считаются по `getStats` живого `RTCPeerConnection` — пока пиры не
 * договорились, там `waiting`, а не число.
 */
export async function connected(page: Page): Promise<void> {
  await expect(page.getByText(/latency:\s*\d+ ms/)).toBeVisible({ timeout: 45_000 });
}
