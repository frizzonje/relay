import { test, expect } from '@playwright/test';
import {
  createServer,
  openChannel,
  openServer,
  person,
  say,
  serverButton,
  unique,
} from '../fixtures/stand';

/**
 * Модерация целиком, двумя людьми сразу — иначе её и не проверить: у бана две
 * стороны, и вся суть в том, что видит вторая.
 *
 * Что нужно стенду:
 *
 *   - поднятый dev- или прод-стек (см. заголовок playwright.config);
 *   - `SITE_PASSWORD`, если ворота инсталляции включены; без него шаг входа
 *     пропускается сам;
 *   - `OWNER_TOKEN` для второго теста — свежий ключ владельца, тот самый, что
 *     печатает `relay owner-link`. Выдать его может только машина, на которой
 *     стоит relay (в этом весь смысл ссылки), поэтому тест без него пропускается,
 *     а не падает:
 *
 *       docker compose exec api node dist/owner-link.js
 *
 * Личности здесь настоящие: ключ рождается в браузере на первом заходе, и
 * каждый контекст — отдельный человек. Chromium нужен свежий: Ed25519 в
 * WebCrypto появился недавно, и на старом браузере relay честно скажет, что
 * ключ ему держать негде.
 */

test('бан с сервера: сервер пропадает у забаненного, список и разбан у модератора', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const kitchen = unique('Кухня');
  const room = unique('болталка');
  const boy = unique('Борис');

  const anya = await person(browser, unique('Аня'));
  const boris = await person(browser, boy);

  // Свой сервер и канал в нём: модерирует его создатель, и только его.
  await createServer(anya, kitchen, room);

  // Борис заходит на этот сервер и что-то говорит.
  await openServer(boris, kitchen);
  await openChannel(boris, room);
  await say(boris, 'дурное слово');
  await expect(boris.getByText('дурное слово')).toBeVisible({ timeout: 10_000 });

  // У создателя в меню чужой реплики появляются удаление и бан.
  await openChannel(anya, room);
  await expect(anya.getByText('дурное слово')).toBeVisible({ timeout: 10_000 });
  await anya.getByText('дурное слово').click({ button: 'right' });
  await expect(anya.getByText('Ban the author', { exact: true })).toBeVisible();
  // Бан на всю инсталляцию создателю сервера недоступен — власти ровно на своё.
  await expect(anya.getByText('Ban across the installation', { exact: true })).toHaveCount(0);
  await anya.getByText('Ban the author', { exact: true }).click();
  await anya.getByRole('button', { name: 'Ban', exact: true }).click();

  // У Бориса сервер пропал, остальная инсталляция осталась.
  await expect(serverButton(boris, kitchen)).toHaveCount(0, { timeout: 20_000 });
  await expect(boris.getByText('общий', { exact: true })).toBeVisible();

  // Список забаненных — единственное место, где бан снимается.
  await anya.getByRole('button', { name: 'Who is banned' }).click();
  await expect(anya.getByText(boy).first()).toBeVisible({ timeout: 15_000 });
  await anya.getByRole('button', { name: 'Lift the ban' }).first().click();

  // Разбан возвращает сервер на место без перезагрузки страницы.
  await expect(serverButton(boris, kitchen)).toBeVisible({ timeout: 15_000 });
});

test('бан на всю инсталляцию: экран вместо молчащего приложения', async ({ browser }) => {
  test.setTimeout(180_000);
  const token = process.env.OWNER_TOKEN;
  test.skip(!token, 'нужен свежий ключ владельца: docker compose exec api node dist/owner-link.js');

  const owner = await person(browser, unique('Хозяйка'));
  const stranger = await person(browser, unique('Прохожий'));
  const word = unique('пришёл-ломать');

  // Власть берётся тем же путём, что и у живого человека: ссылкой из терминала.
  await owner.goto(`/?owner=1#owner=${token}`);
  await owner.getByRole('button', { name: 'Make this identity the owner' }).click();
  await owner.waitForTimeout(2500);
  await owner.keyboard.press('Escape');

  // Главный сервер — тот, у которого создателя нет и быть не может: модерирует
  // его только владелец инсталляции. Реплику метим прогоном: «общий» один на
  // всю инсталляцию, и сказанное в нём соседним спеком тут же и лежит.
  await openChannel(stranger, 'общий');
  await say(stranger, word);
  await expect(stranger.getByText(word)).toBeVisible({ timeout: 10_000 });

  await openChannel(owner, 'общий');
  await expect(owner.getByText(word)).toBeVisible({ timeout: 15_000 });
  await owner.getByText(word).click({ button: 'right' });
  await owner.getByText('Ban across the installation', { exact: true }).click();
  await owner.getByRole('button', { name: 'Ban', exact: true }).click();

  // Экран, а не тост: сокета больше нет, и приложение вокруг — декорация.
  await expect(stranger.getByText('You are banned here')).toBeVisible({ timeout: 20_000 });

  // И на перезаходе то же самое: дверь не пускает — это не «сеть моргнула».
  await stranger.reload();
  await expect(stranger.getByText('You are banned here')).toBeVisible({ timeout: 25_000 });
});
