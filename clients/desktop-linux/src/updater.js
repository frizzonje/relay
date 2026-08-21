'use strict';

// Обновления. Правило то же, что у Tauri-клиента: НИЧЕГО не ставится само.
// Оболочка тихо проверяет релизы при старте и, если что-то вышло, показывает
// системное уведомление; ставится обновление только по кнопке в настройках или
// по пункту трея. Решение обновляться — за человеком, не за нами.
//
// Канал — те же релизы `desktop-v*` на GitHub, что и у остальных платформ, но
// файл описания свой (`latest-linux.yml` от electron-builder против
// `latest.json` от Tauri): формат апдейтера привязан к оболочке, а не к релизу.
// Существующие Linux-клиенты на Tauri переезжают сюда одним разом — их апдейтер
// заменяет AppImage целиком, и внутри оказывается уже эта сборка (см. README).
//
// Обновляется ТОЛЬКО AppImage: deb/rpm/AUR ставит и обновляет пакетный
// менеджер, и лезть в его файлы своими руками — верный способ сломать систему.

const { Notification, app, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');

const { ulog } = require('./log');

/** Жёсткий срок одной проверки: зависший запрос должен стать ошибкой, а не «Проверяю…» навсегда. */
const CHECK_TIMEOUT_MS = 20_000;

/** Идёт ли уже проверка: мост шлёт `check-updates` на каждый (пере)запуск фронта. */
let inFlight = false;

/** Найденное обновление — его ставит `install-update`. */
let pending = null;

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.logger = { info: ulog, warn: ulog, error: ulog, debug: () => {} };

/** Запущены ли мы из AppImage — только его апдейтер умеет заменить. */
const isAppImage = () => Boolean(process.env.APPIMAGE);

function ru() {
  return app.getLocale().toLowerCase().startsWith('ru');
}

const T = {
  packaged: () =>
    ru()
      ? 'Эта сборка обновляется средствами системы (пакетный менеджер), а не сама.'
      : 'This build is updated by your package manager, not by relay itself.',
  found: (v) => (ru() ? `Вышла версия ${v}` : `Version ${v} is out`),
  foundBody: () =>
    ru()
      ? 'Установить можно в настройках relay: «Проверить обновления».'
      : 'Install it from relay settings: “Check for updates”.',
  upToDate: () => (ru() ? 'У вас последняя версия relay.' : 'relay is up to date.'),
  failed: (e) => (ru() ? `Проверка не удалась: ${e}` : `Update check failed: ${e}`),
  install: () => (ru() ? 'Установить и перезапустить' : 'Install and restart'),
  later: () => (ru() ? 'Позже' : 'Later'),
};

function status(send, value) {
  send('update-status', value);
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_r, reject) =>
      setTimeout(() => reject(new Error(`нет ответа за ${ms / 1000}s`)), ms),
    ),
  ]);
}

/**
 * Проверить релизы и доложить статус. Ничего не ставит.
 * `notify` — можно показать системное уведомление о находке (тихая проверка при
 * старте); `announce` — сообщить результат даже когда всё актуально (пункт трея).
 */
async function checkUpdates(send, { notify = false, announce = false } = {}) {
  if (!isAppImage()) {
    // Пакет из репозитория (deb/AUR) или запуск из исходников: обновлять нам
    // здесь нечего. Фоновой проверке (она приходит и от моста при каждом
    // старте фронта) на это отвечать нечем — молчим, иначе человек находил бы
    // в настройках «ошибку обновления», которой нет. Спросили руками — говорим.
    ulog('check-updates: не AppImage — обновления у пакетного менеджера');
    if (announce) dialog.showMessageBox({ message: T.packaged(), buttons: ['OK'] });
    else if (!notify) status(send, { state: 'error', message: T.packaged() });
    return;
  }
  if (inFlight) {
    ulog('check-updates skipped (already in flight)');
    return;
  }
  inFlight = true;
  ulog(`check-updates received (notify=${notify}, announce=${announce})`);

  try {
    const result = await withTimeout(autoUpdater.checkForUpdates(), CHECK_TIMEOUT_MS);
    const version = result && result.updateInfo ? result.updateInfo.version : null;
    const fresh = version && version !== app.getVersion();
    ulog(`check() ok -> ${version || 'нет данных'}${fresh ? ' (свежее)' : ''}`);

    if (!fresh) {
      status(send, { state: 'up-to-date' });
      if (announce) dialog.showMessageBox({ message: T.upToDate(), buttons: ['OK'] });
      return;
    }

    pending = version;
    status(send, { state: 'available', version });

    if (announce) {
      const { response } = await dialog.showMessageBox({
        message: T.found(version),
        buttons: [T.install(), T.later()],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) await installUpdate(send);
      return;
    }
    if (notify && Notification.isSupported()) {
      new Notification({ title: T.found(version), body: T.foundBody() }).show();
    }
  } catch (e) {
    ulog(`check() error: ${e.message}`);
    status(send, { state: 'error', message: T.failed(e.message) });
    if (announce) dialog.showMessageBox({ message: T.failed(e.message), buttons: ['OK'] });
  } finally {
    inFlight = false;
  }
}

/** Скачать и поставить найденное обновление. Приходит только по явной кнопке. */
async function installUpdate(send) {
  ulog('install-update received');
  if (!isAppImage()) {
    status(send, { state: 'error', message: T.packaged() });
    return;
  }
  try {
    status(send, { state: 'installing', version: pending || '' });
    await autoUpdater.downloadUpdate();
    ulog('installed, restarting');
    // isSilent=true: своего диалога у AppImage нет, перезапуск и есть установка.
    autoUpdater.quitAndInstall(true, true);
  } catch (e) {
    ulog(`install failed: ${e.message}`);
    status(send, { state: 'error', message: T.failed(e.message) });
  }
}

module.exports = { checkUpdates, installUpdate };
