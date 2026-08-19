import { expect, type Page } from '@playwright/test';
import {
  connected,
  createServer,
  createVoiceChannel,
  joinVoice,
  openServer,
  person,
  test,
  unique,
} from '../fixtures/stand';
import { SFU_CONTAINER, dockerReachable, startContainer, stopContainer } from '../fixtures/docker';

/**
 * Медиасервер: то, ради чего он вообще есть, и то, что однажды уже стоило
 * живого звонка.
 *
 * До этого спека ни одна проверка не поднимала SFU вовсе — голос гонялся в
 * «P2P общем», и обе дороги, на которых звонок реально рвался, не проверял
 * никто: смена транспорта посреди разговора и падение самого медиасервера.
 *
 * Что нужно стенду: поднятый `sfu-e2e` (см. infra/docker-compose.e2e.yml) —
 * без него api не выдаст ни одного пропуска, и создать SFU-канал будет нечем.
 * Второму тесту нужен ещё и сокет docker: уронить медиасервер посреди звонка
 * может только тот, кто знает момент, — то есть сам тест.
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

/**
 * Как идёт медиа с точки зрения самого соединения — из тултипа со статами
 * (`net.via`, см. VideoTile). Прежней дороги при этом не должно остаться
 * нигде: иначе проверка сходилась бы на плитке, забытой прошлым транспортом,
 * и переезд, который на самом деле не случился, выглядел бы случившимся.
 */
async function route(page: Page, where: 'via the server' | 'direct') {
  const before = where === 'direct' ? 'via the server' : 'direct';
  await expect(page.getByText(where, { exact: true }).first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(before, { exact: true })).toHaveCount(0);
}

/** Переключить режим канала и подтвердить — тем же путём, что и рукой. */
async function switchMode(page: Page, to: 'sfu' | 'p2p') {
  const badge = page.getByTitle(
    to === 'sfu' ? /Click to route through the media server/ : /Click to call directly/,
  );
  await badge.first().click();
  await page.getByRole('button', { name: 'Switch' }).click();
}

test('режим канала переключается посреди разговора, и звонок это переживает', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const home = unique('Студия');
  const room = unique('переговорка');
  const her = unique('Аня');
  const him = unique('Борис');

  const anya = await person(browser, her, { permissions: ['microphone'] });
  const boris = await person(browser, him, { permissions: ['microphone'] });

  // Канал заводит Аня — режим правит только владелец канала.
  await createServer(anya, home, unique('текстовый'));
  await createVoiceChannel(anya, room, 'p2p');
  await openServer(boris, home);

  await joinVoice(anya, room, her);
  await joinVoice(boris, room, him);
  await connected(anya);
  await connected(boris);
  await route(anya, 'direct');

  // Владелец переводит канал на медиасервер. Звук пропадает на пару секунд —
  // об этом и предупреждает окно, — но звонок обязан собраться заново сам.
  await switchMode(anya, 'sfu');
  await route(anya, 'via the server');
  await route(boris, 'via the server');
  await connected(anya);
  await connected(boris);

  // И обратно: переезд туда и переезд оттуда — разные дороги в коде, и
  // проверяются обе (см. `remigrate` в apps/web/lib/voice.ts).
  await switchMode(anya, 'p2p');
  await route(anya, 'direct');
  await route(boris, 'direct');
  await connected(anya);
  await connected(boris);

  // Оба всё ещё в эфире — то есть переезды не выкинули никого из канала.
  await expect(anya.getByText(him, { exact: true }).first()).toBeVisible();
  await expect(boris.getByText(her, { exact: true }).first()).toBeVisible();
});

test('падение медиасервера роняет канал в прямые звонки, а не в тишину', async ({ browser }) => {
  test.setTimeout(300_000);
  test.skip(!dockerReachable(), 'нужен проброшенный сокет docker: -v /var/run/docker.sock:...');

  const home = unique('Студия');
  const room = unique('переговорка');
  const her = unique('Аня');
  const him = unique('Борис');

  const anya = await person(browser, her, { permissions: ['microphone'] });
  const boris = await person(browser, him, { permissions: ['microphone'] });

  await createServer(anya, home, unique('текстовый'));
  await createVoiceChannel(anya, room, 'sfu');
  await openServer(boris, home);

  await joinVoice(anya, room, her);
  await joinVoice(boris, room, him);
  await route(anya, 'via the server');
  await route(boris, 'via the server');

  try {
    expect(await stopContainer(SFU_CONTAINER)).toBeLessThan(400);

    // Пока лестница восстановления идёт, на плитках об этом написано. Не
    // мелочь: ступени занимают секунды, звука в них нет, и молчащий интерфейс
    // человек читает как поломку у себя — идёт крутить микрофон, которому
    // ничего не сделалось.
    await expect(anya.getByText(/reconnecting/).first()).toBeVisible({ timeout: 30_000 });

    // Лестница восстановления у SFU-транспорта своя (restart-ice, пересборка
    // транспортов), и только исчерпав её, он говорит дирижёру «потерян». Тот и
    // принимает решение: вдвоём — сразу напрямую.
    await route(anya, 'direct');
    await route(boris, 'direct');
    await connected(anya);
    await connected(boris);
  } finally {
    // Стенд общий: следующему спеку медиасервер нужен живым.
    await startContainer(SFU_CONTAINER).catch(() => {});
  }
});
