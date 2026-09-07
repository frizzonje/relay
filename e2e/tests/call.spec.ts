import { expect, type Browser, type Page } from '@playwright/test';
import {
  connected,
  conversationRow,
  onStage,
  openDirect,
  person,
  test,
  tile,
  unique,
  writeTo,
} from '../fixtures/stand';

/**
 * Дозвон (задача 10 плана B) — четыре ветви из брифа, каждая доказана тем, что
 * происходит на самом деле, а не тем, что на экране сменилась картинка:
 *
 *  1. **принят и слышен** — тем же приёмом, что и `voice.spec.ts`: метка
 *     задержки рисуется из живого `getStats()` `RTCPeerConnection`, и до тех
 *     пор, пока пиры не договорились, там `waiting`, а не число. Разговор
 *     после принятого вызова садит ОБЕИХ в ту же mesh-комнату, что у обычного
 *     голосового канала (`lib/call.ts` → `seat()` → `lib/voice.ts`
 *     `joinVoice()`), поэтому годятся ровно те же плитки и та же метка;
 *  2. **отклонён** — тост гаснет немедленно, экран звонящего объясняет исход
 *     словом «Declined the call», а в переписке НЕ появляется отметка (§4.2
 *     протокола: «отклонён» нажали сами, отметки не оставляет). Отсутствие
 *     проверяется явно, а не молчанием — слабый тест здесь ровно тот, что не
 *     смотрит вовсе;
 *  3. **не ответили по таймауту** — 45 секунд умолчания нечестно ждать в
 *     тесте, поэтому владелец инсталляции (тот же путь, что в `admin.spec.ts`)
 *     сокращает `calls.ringTimeoutSeconds` до минимума каталога (10 с) на
 *     время теста и возвращает как было в `finally`;
 *  4. **собеседник исчезает посреди дозвона** — это и есть «звонок в закрытую
 *     вкладку» из брифа. Дозвонившийся до уже закрытой (никогда не
 *     открывавшейся) вкладки получил бы отказ `offline` ДО того, как что-либо
 *     зазвонило (§4.2: «offline — это отказ до вызова»), а такой отказ вызова
 *     не заводит и отметки не оставляет — проверять там нечего. Ветка из
 *     брифа осмысленна ровно для другого момента: вкладку закрывают, пока уже
 *     звонит, — и вот это `Rings.dropSocket` (без грейса, «оба конца смотрят
 *     на экран прямо сейчас») превращает в `failed`, а `failed` — один из двух
 *     исходов, что отметку оставляют. Тест закрывает страницу Playwright'ом
 *     (`page.close()`) ровно в этот момент — тот же эффект, что у закрытой
 *     вкладки в реальном браузере.
 *
 * Микрофон нужен только первому тесту (настоящее WebRTC-соединение); Chromium
 * отдаёт синтетическую дорожку по `--use-fake-device-for-media-stream` и сам
 * выдаёт права — иначе браузер встал бы на системном окне доступа.
 *
 * Дозвон при умолчании каталога `calls.whoCanCall: conversation` разрешён
 * только тем, с кем уже заведена переписка (§4.2, `DmService.hasConversation`)
 * — поэтому каждый тест сперва пишет собеседнику, как в `dm.spec.ts`.
 */

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

const TOKEN = process.env.OWNER_TOKEN ?? '';
const NEEDS_TOKEN = 'нужен свежий ключ владельца: docker compose exec api node dist/owner-link.js';

/**
 * Хозяйка инсталляции для теста с таймаутом — тем же приёмом, что и
 * `admin.spec.ts`: заводится один раз на весь модуль и живёт до конца файла.
 *
 * Почему нельзя заводить её заново в каждом запуске теста. Ссылка владельца
 * одноразовая (`OwnerService.claim` сжигает токен с первого же захода) — а
 * Playwright в CI повторяет упавший тест (`retries: 1`, playwright.config).
 * Заведи тест хозяйку внутри своего тела — второй заход (ретрай) получил бы
 * тот же `OWNER_TOKEN` уже потраченным, «Make this identity the owner» отдал
 * бы отказ, и щит `toolbar-admin` не появился бы никогда: ретрай был бы
 * обречён с той секунды, что и первая попытка, но по другой причине, — ровно
 * то падение, которое и увидели на этой строке. Модульная переменная того же
 * воркера переживает повтор теста внутри одного файла, поэтому второй заход
 * находит уже авторизованную хозяйку и токен не трогает вовсе.
 */
let hostess: Page | null = null;

async function ownerPage(browser: Browser): Promise<Page> {
  if (hostess && !hostess.isClosed()) return hostess;
  const page = await person(browser, unique('Хозяйка'));
  await page.goto(`/?owner=1#owner=${TOKEN}`);
  await page.getByRole('button', { name: 'Make this identity the owner' }).click();
  await expect(page.getByTestId('toolbar-admin')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Escape');
  hostess = page;
  return page;
}

/**
 * Кнопка звонка карточки собеседника (правая колонка беседы, `DmPeerCard`).
 * У шапки беседы (`DmThread`) есть вторая кнопка с тем же доступным именем
 * «Call» (подстраховка на узком десктопе, см. её докком) — уточняем контейнер:
 * карточка собеседника — единственный `<aside>` на сцене беседы.
 */
function callButton(page: Page) {
  return page.locator('aside').getByRole('button', { name: 'Call', exact: true });
}

/** Экран исходящего вызова — `role="dialog"` (см. `OutgoingCall.tsx`). */
function outgoingScreen(page: Page) {
  return page.getByRole('dialog');
}

test('звонок принят — доказано состоянием RTCPeerConnection, а не сменой экрана', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const her = unique('Аня');
  const him = unique('Борис');
  const hello = unique('привет');

  const anya = await person(browser, her, { permissions: ['microphone'] });
  const boris = await person(browser, him, { permissions: ['microphone'] });

  await openDirect(anya);
  await writeTo(anya, him, hello);
  await expect(boris.getByText(hello)).toBeVisible({ timeout: 25_000 });

  await callButton(anya).click();
  await expect(outgoingScreen(anya)).toBeVisible({ timeout: 15_000 });

  const accept = boris.getByRole('button', { name: 'Accept' });
  await expect(accept).toBeVisible({ timeout: 20_000 });
  await accept.click();

  // «Садится в комнату клиент, а не сервер» (lib/call.ts) — обе вкладки сами
  // входят по `accepted`, и это та же сцена «voice», что у обычного канала:
  // своя плитка рисуется первой, ровно как в `joinVoice()` фикстуры.
  //
  // Имя собеседника проверяем через `onStage()`, а не голым `getByText` —
  // у Ани открыта переписка (`writeTo` уже завела её), и `DmPeerCard`
  // (боковая карточка беседы) стоит РЯДОМ с плиткой сцены внутри того же
  // `<main>` (см. `Stage.tsx`: карточка и лента — соседи в одном узле, а не
  // разные части каркаса, как гласил старый комментарий здесь). На
  // десктопном вьюпорте она не спрятана (`max-md:hidden` гасит её только на
  // узких экранах) — значит, тот же самый ник «Борис» лежит на сцене
  // ВТОРЫМ видимым узлом. Голый `getByText` без `.first()` попал бы то в
  // один, то в другой — и на медленном стенде ловил бы то один, то другой
  // непредсказуемо: ровно так спек падал до этой правки.
  await expect(anya.getByText(`${her} (you)`).first()).toBeVisible({ timeout: 25_000 });
  await expect(boris.getByText(`${him} (you)`).first()).toBeVisible({ timeout: 25_000 });
  await expect(onStage(anya, him).first()).toBeVisible({ timeout: 20_000 });
  await expect(onStage(boris, her).first()).toBeVisible({ timeout: 20_000 });

  // Доказательство — не плитка, а то, что RTCPeerConnection и правда
  // договорился: миллисекунды приезжают из getStats живого соединения (см.
  // `connected()` в fixtures/stand.ts и voice.spec.ts, тот же приём).
  await connected(anya);
  await connected(boris);

  // Уход любого кончает разговор сразу — комната на одного не бывает.
  //
  // Проверяем через `tile()` (плитку сцены), а не голым текстом и не через
  // `onStage()`: приняв вызов, Борис оказывается в переписке с Аней
  // (`view: 'dm'`, см. `stores/ui.ts` → `clearVoice`), и после разговора его
  // вид возвращается ровно туда же — карточка собеседника (`DmPeerCard`)
  // ПРОДОЛЖАЕТ честно показывать её ник, и стоит она внутри того же
  // `<main>`, что и лента (см. правку комментария выше). Значит, ни голый
  // `getByText`, ни `onStage()` здесь не годятся — оба нашли бы этот
  // законный, никуда не девшийся ник карточки и посчитали бы разговор
  // «незавершённым». Ушедший разговор доказывается тем, что исчезает именно
  // ПЛИТКА, а не тем, что имя перестало где-либо встречаться.
  await anya.getByRole('button', { name: 'Disconnect' }).click();
  await expect(tile(boris, her)).toHaveCount(0, { timeout: 20_000 });
});

test('отклонённый звонок гасит тост немедленно и не оставляет отметку', async ({ browser }) => {
  test.setTimeout(120_000);
  const her = unique('Аня');
  const him = unique('Борис');
  const hello = unique('привет');

  const anya = await person(browser, her);
  const boris = await person(browser, him);
  await openDirect(anya);
  await writeTo(anya, him, hello);
  await expect(boris.getByText(hello)).toBeVisible({ timeout: 25_000 });

  await callButton(anya).click();
  const decline = boris.getByRole('button', { name: 'Decline' });
  await expect(decline).toBeVisible({ timeout: 20_000 });
  await decline.click();

  // Тост — не модалка, но и не вечный: закрывается фактом исхода, а не своим
  // таймером (см. `IncomingToast.tsx`).
  await expect(decline).toHaveCount(0, { timeout: 10_000 });

  // У звонящего экран не гаснет молча — он объясняет исход словом, цветом
  // `danger` по глобальному правилу плана 2.0.
  const dialog = outgoingScreen(anya);
  await expect(dialog.getByText('Declined the call')).toBeVisible({ timeout: 15_000 });

  // «Отклонён» нажали сами — протокол §4.2 прямо говорит, что такой исход
  // отметки не оставляет (в отличие от «не ответили»/«не в сети», см. два
  // следующих теста). Проверяем это явным отсутствием, а не тишиной.
  await expect(onStage(anya, 'Missed call')).toHaveCount(0);
  await expect(onStage(anya, 'You called')).toHaveCount(0);

  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0, { timeout: 10_000 });
});

test('не ответили по таймауту — отметка приезжает обеим сторонам', async ({ browser }) => {
  test.setTimeout(180_000);
  test.skip(!TOKEN, NEEDS_TOKEN);

  const her = unique('Аня');
  const him = unique('Борис');
  const hello = unique('привет');

  // Хозяйка инсталляции — отдельная личность, не участник звонка (тот же
  // приём, что и в admin.spec.ts): её единственная роль — временно сократить
  // `calls.ringTimeoutSeconds`, потому что сорок пять секунд умолчания
  // нечестно ждать в тесте. Заводится через `ownerPage()`, а не заново
  // здесь, — см. комментарий над ней про одноразовый токен и ретраи CI.
  const owner = await ownerPage(browser);

  const anya = await person(browser, her);
  const boris = await person(browser, him);
  await openDirect(anya);
  await writeTo(anya, him, hello);
  await expect(boris.getByText(hello)).toBeVisible({ timeout: 25_000 });

  let originalTimeout = '';
  try {
    await owner.getByTestId('toolbar-admin').click();
    await expect(owner.getByTestId('admin-tab-overview')).toBeVisible({ timeout: 30_000 });
    await expect(owner.getByTestId('admin-tab-maintenance')).toBeVisible({ timeout: 30_000 });
    await owner.getByTestId('admin-tab-calls').click();

    const field = owner.getByTestId('admin-field-calls.ringTimeoutSeconds');
    await expect(field).toBeVisible({ timeout: 15_000 });
    // Параметр `applies: 'now'` — если каталог однажды передумает и напишет
    // «после перезапуска», весь тест ниже станет ложью, и узнать об этом надо
    // здесь, а не подождав минуту зря на нагруженном стенде.
    await expect(owner.getByTestId('admin-applies-calls.ringTimeoutSeconds')).toHaveText(
      'applies at once',
    );

    const input = field.locator('input[type="number"]');
    originalTimeout = await input.inputValue();
    // Минимум каталога (`min: 10`) — самый быстрый честный таймаут, какой
    // инсталляция вообще позволяет.
    await input.fill('10');
    await input.press('Enter');
    await expect(owner.getByTestId('admin-saving-calls.ringTimeoutSeconds')).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(owner.getByTestId('admin-error-calls.ringTimeoutSeconds')).toHaveCount(0);
    await expect(input).toHaveValue('10');

    await callButton(anya).click();
    const accept = boris.getByRole('button', { name: 'Accept' });
    await expect(accept).toBeVisible({ timeout: 20_000 });

    // Не отвечаем — ждём, пока владелец гейтвея сам скажет «не ответили»
    // (`Rings.armTimeout`, взведённый по числу, снятому в момент набора).
    const dialog = outgoingScreen(anya);
    await expect(dialog.getByText('No answer')).toBeVisible({ timeout: 25_000 });
    await expect(accept).toHaveCount(0, { timeout: 15_000 });

    await expect(onStage(anya, 'You called')).toBeVisible({ timeout: 15_000 });
    await expect(onStage(anya, 'no answer')).toBeVisible();

    // И у Бориса — тем же путём, каким `dm.spec.ts` проверяет, что реплика
    // переживает перезагрузку: список переписок → строка → лента. Перезагрузка
    // тут не только доказательство персистентности — она же снимает облачко
    // `DmToast` про пропущенный звонок: `TOAST_MS` держит его на экране шесть
    // секунд, и без сброса живой узел совпал бы с той же строкой по нику и
    // слову «Missed call» ровно тем же текстом — `getByRole` увидел бы два
    // элемента вместо одного и упал бы на «strict mode violation», а не на
    // содержательной проверке.
    await boris.reload();
    await expect(boris.getByText('общий', { exact: true })).toBeVisible({ timeout: 25_000 });
    await openDirect(boris);
    const row = conversationRow(boris, her, 'Missed call');
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    await expect(onStage(boris, 'Missed call')).toBeVisible({ timeout: 15_000 });
    await expect(onStage(boris, 'no answer')).toBeVisible();
    await expect(boris.getByRole('button', { name: 'Call back' })).toBeVisible();

    await dialog.getByRole('button', { name: 'Close' }).click();
  } finally {
    // Инсталляция после теста обязана остаться такой же, какой была — иначе
    // упавший на середине прогон оставил бы стенд с чужим таймаутом, и
    // следующий человек искал бы поломку не там (см. admin.spec.ts).
    if (originalTimeout) {
      const field = owner.getByTestId('admin-field-calls.ringTimeoutSeconds');
      const input = field.locator('input[type="number"]');
      if (await input.isVisible().catch(() => false)) {
        await input.fill(originalTimeout);
        await input.press('Enter');
        await expect(owner.getByTestId('admin-saving-calls.ringTimeoutSeconds')).toHaveCount(0, {
          timeout: 15_000,
        });
      }
    }
    await owner.keyboard.press('Escape').catch(() => {});
  }
});

test('собеседник исчезает посреди дозвона (закрытая вкладка) — отметка остаётся у звонившего', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const her = unique('Аня');
  const him = unique('Борис');
  const hello = unique('привет');

  const anya = await person(browser, her);
  const boris = await person(browser, him);
  await openDirect(anya);
  await writeTo(anya, him, hello);
  await expect(boris.getByText(hello)).toBeVisible({ timeout: 25_000 });

  await callButton(anya).click();
  // Дожидаемся, что вызов и правда зазвонил у Бориса: до этого момента у него
  // ещё нет ни одного устройства В ВЫЗОВЕ, и закрытие вкладки означало бы
  // просто «набирать оказалось некуда» (`offline`, отказ ДО вызова, §4.2) —
  // вызов не завёлся бы вовсе, и оставлять там отметку не с чего.
  await expect(boris.getByRole('button', { name: 'Accept' })).toBeVisible({ timeout: 20_000 });

  // Закрытая вкладка из брифа: последнее устройство Бориса уходит без грейса
  // (`Rings.dropSocket` — «оба конца смотрят на экран прямо сейчас», в отличие
  // от голосовой сессии с её 24-секундным окном). Сервер немедленно превращает
  // вызов в `failed` на стороне Ани.
  await boris.close();

  const dialog = outgoingScreen(anya);
  await expect(dialog.getByText('Not online right now')).toBeVisible({ timeout: 15_000 });

  // `failed` — один из двух исходов, что оставляют отметку (второй —
  // `no-answer`, см. предыдущий тест): собеседник иначе не узнал бы вовсе, что
  // ему звонили.
  await expect(onStage(anya, 'You called')).toBeVisible({ timeout: 15_000 });
  await expect(onStage(anya, 'not online')).toBeVisible();
  await expect(anya.getByRole('button', { name: 'Call back' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Close' }).click();
});
