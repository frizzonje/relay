import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, type Page } from '@playwright/test';
import {
  BASE,
  PASSWORD,
  connected,
  createServer,
  createVoiceChannel,
  joinVoice,
  openServer,
  person,
  test,
  unique,
} from '../fixtures/stand';

/**
 * Linux-клиент: звонок из НАСТОЯЩЕЙ оболочки против браузера.
 *
 * Это главная проверка всего Linux-направления, и вот почему. На Tauri
 * голосового клиента под Linux не бывает: системный WebKitGTK собран без
 * WebRTC, `RTCPeerConnection` там просто нет (проверено на Debian 13 и Fedora
 * 44 со свежайшим 2.52.5). Оболочка на Electron берёт Chromium — но верить в
 * это на слово нельзя, поэтому спек поднимает саму оболочку, ведёт её через
 * экран выбора сервера на стенд и заставляет разговаривать с обычным браузером.
 *
 * Что здесь доказывается разом:
 *   • звонок из оболочки действительно встаёт (метка задержки считается по
 *     `getStats` живого соединения — пока пиры не договорились, там `waiting`);
 *   • мост дожил до удалённого origin (`window.__RELAY_SHELL__` на странице);
 *   • личность живёт в оболочке, а не в webview: после входа на диске лежит
 *     файл ключа с правами 0600 — тем же путём, что у Tauri-клиента;
 *   • настройки оболочки доезжают обратно (вкладка «Application» показывает
 *     автозапуск и версию оболочки — их присылает главный процесс).
 *
 * Стенд: `clients/desktop-linux/testbench` (Docker, Xvfb, фальшивые устройства).
 * Без `RELAY_LINUX_SHELL` спек пропускается — в обычном прогоне e2e оболочки
 * рядом нет.
 */

/** Путь к каталогу оболочки (clients/desktop-linux) — его задаёт стенд. */
const APP = process.env.RELAY_LINUX_SHELL;

/**
 * Микрофон собеседника — такой же фальшивый, как у оболочки: без этих флагов
 * Chromium встал бы на системном окне доступа, которого в контейнере некому
 * нажать, и «не зашёл в канал» выглядело бы как беда оболочки, а не стенда.
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

/** Каналу нужен человек, а человеку — своя папка настроек: личность у теста своя. */
function freshConfigHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-shell-'));
}

/** Файлы ключей, которые оболочка завела в этом прогоне. */
function keyFiles(configHome: string): string[] {
  const dir = path.join(configHome, 'app.relay.desktop', 'identity');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.key')) : [];
}

/**
 * Провести оболочку от экрана выбора сервера до готового приложения — то же,
 * что делает `person()` для браузера, но начиная на страницу раньше: у клиента
 * нет адресной строки, адрес инсталляции вводят в пикере.
 */
async function shellPerson(win: Page, nick: string): Promise<void> {
  // Экран выбора сервера: адрес и «Подключиться».
  await win.locator('#url').fill(BASE);
  await win.locator('#go').click();
  await win.waitForURL((url) => url.protocol !== 'file:', { timeout: 60_000 });

  const pass = win.getByPlaceholder('Password');
  if (PASSWORD && (await pass.isVisible().catch(() => false))) {
    await pass.fill(PASSWORD);
    await win.getByRole('button', { name: 'Sign in' }).click();
  }

  const cont = win.getByRole('button', { name: 'Continue' });
  await cont.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => {});
  if (await cont.isVisible().catch(() => false)) {
    await win.locator('form input').first().fill(nick);
    await cont.click();
    await cont.waitFor({ state: 'detached', timeout: 30_000 }).catch(() => {});
  }
}

test.describe('Linux-оболочка (Electron)', () => {
  test.skip(!APP, 'нет RELAY_LINUX_SHELL — оболочки рядом нет');

  test('звонок из оболочки с браузером: соединение встаёт, ключ на диске', async ({ browser }) => {
    test.setTimeout(300_000);

    const configHome = freshConfigHome();
    const her = unique('Аня');
    const him = unique('Борис');
    const server = unique('Стенд');
    const text = unique('болталка');
    const channel = unique('эфир');

    const app = await electron.launch({
      // Стенд кладёт бинарь Electron рядом с собой (см. testbench/Dockerfile);
      // без подсказки Playwright искал бы его в node_modules самого спека.
      ...(process.env.RELAY_ELECTRON_BIN ? { executablePath: process.env.RELAY_ELECTRON_BIN } : {}),
      args: [
        APP!,
        // Стенд стоит на внутреннем сертификате Caddy — как и у браузерных
        // спеков (ignoreHTTPSErrors). Флаг живёт ТОЛЬКО здесь, в тесте.
        '--ignore-certificate-errors',
        // Микрофон настоящий, но фальшивый: иначе клиент встал бы на системном
        // окне доступа, которого в контейнере некому нажать.
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--no-sandbox',
      ],
      env: {
        ...process.env,
        // Своя папка настроек: ключ личности этого прогона не должен смешиваться
        // ни с чьим другим, а после теста его видно и можно проверить.
        XDG_CONFIG_HOME: configHome,
      },
    });

    try {
      const win = await app.firstWindow();
      // Английский интерфейс — как у остальных спеков: селекторы по тексту.
      await app.context().addCookies([{ name: 'relay-lang', value: 'en', url: BASE }]);

      await shellPerson(win, her);

      // Мост доехал до удалённого origin. Без него не будет ни трея, ни
      // настроек, ни личности — и всё это молча.
      const bridge = await win.evaluate(
        () => typeof (window as unknown as { __RELAY_SHELL__?: unknown }).__RELAY_SHELL__,
      );
      expect(bridge, 'мост оболочки виден странице сервера').toBe('object');

      // Личность родилась в главном процессе и легла файлом — как в Rust.
      const keys = keyFiles(configHome);
      expect(keys, 'оболочка завела ключ для этого сервера').toHaveLength(1);
      const mode = fs.statSync(
        path.join(configHome, 'app.relay.desktop', 'identity', keys[0]),
      ).mode;
      expect(mode & 0o777, 'ключ читается только владельцем').toBe(0o600);

      // Собеседник — обычный браузер: ровно тот случай, ради которого всё.
      const boris = await person(browser, him, { permissions: ['microphone'] });
      // Сервер заводит браузерный человек: оболочке важно уметь ЗАЙТИ на чужой
      // сервер и говорить — заводить его она умеет ровно так же, тем же web-UI.
      await createServer(boris, server, text);
      await createVoiceChannel(boris, channel);

      await openServer(win, server);
      await joinVoice(win, channel, her);
      await joinVoice(boris, channel, him);

      // Друг друга видно…
      await expect(win.getByText(him, { exact: true }).first()).toBeVisible({ timeout: 45_000 });
      await expect(boris.getByText(her, { exact: true }).first()).toBeVisible({ timeout: 45_000 });

      // …и медиаканал открыт с обеих сторон: миллисекунды приходят из getStats.
      await connected(win);
      await connected(boris);

      // Настройки оболочки доезжают обратно: блок автозапуска и версия — это
      // ответ главного процесса на `desktop-settings-get`.
      await win.getByRole('button', { name: 'Settings' }).first().click();
      await win.getByRole('button', { name: 'Application' }).click();
      await expect(win.getByText('Launch at login')).toBeVisible({ timeout: 15_000 });
      await expect(win.getByText(/relay shell \d+\.\d+\.\d+/)).toBeVisible();
    } finally {
      await app.close().catch(() => {});
    }
  });
});
