'use strict';

// Микрофон, камера и демонстрация экрана.
//
// РАЗРЕШЕНИЯ. Chromium по умолчанию спрашивает про микрофон само приложение, а
// не пользователя: без обработчика запрос просто отклоняется. Окно оболочки
// показывает ровно тот сервер, который человек выбрал в пикере, поэтому доступ
// к микрофону здесь — его осознанный выбор (как в любом десктоп-мессенджере).
// Разрешаем только медиа и уведомления и только странице сервера; всё прочее
// (геолокация, MIDI, датчики) отклоняем — чужой странице тут делать нечего.
//
// ДЕМОНСТРАЦИЯ ЭКРАНА. В браузере источник выбирает сам движок, в Electron
// выбор обязано показать приложение. Развилка одна и важная:
//   • Wayland — выбор делает системный портал (xdg-desktop-portal). Свой список
//     окон там взять неоткуда, да и не нужно: портал и есть правильный диалог.
//   • X11 — портала может не быть вовсе, зато есть `desktopCapturer`; рисуем
//     собственный список экранов и окон (screen-picker.html).
//
// Системный звук демонстрации на Linux не идёт ни одним из путей: портал отдаёт
// только видео, а loopback-захват Chromium умеет на Windows и macOS. Это
// честное ограничение, а не недоделка — так и написано в README.

const path = require('node:path');
const { BrowserWindow, desktopCapturer, ipcMain, session } = require('electron');

const { ulog } = require('./log');
const { originOf } = require('./url');

/** Что позволяем странице сервера. Всё, чего здесь нет, отклоняется. */
const ALLOWED = new Set([
  'media',
  'display-capture',
  'notifications',
  'fullscreen',
  'clipboard-sanitized-write',
]);

/** Wayland: выбор источника показывает портал, а не мы. */
const wayland = () =>
  process.env.XDG_SESSION_TYPE === 'wayland' || Boolean(process.env.WAYLAND_DISPLAY);

function installMediaHandlers(getWindow) {
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    const from = originOf(webContents.getURL());
    const ok = ALLOWED.has(permission) && from !== null;
    ulog(`permission ${permission} для ${from || 'file://'}: ${ok ? 'allow' : 'deny'}`);
    callback(ok);
  });

  // Синхронная проверка (`navigator.permissions.query`, ярлыки устройств в
  // enumerateDevices). Без неё web-UI показывает список микрофонов без имён.
  ses.setPermissionCheckHandler((webContents, permission) => {
    const from = webContents ? originOf(webContents.getURL()) : null;
    return ALLOWED.has(permission) && from !== null;
  });

  ses.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        const source = await pickSource(getWindow());
        if (!source) {
          // Отказ пользователя — это отказ: `callback()` без аргументов даёт
          // странице NotAllowedError, ровно как «Отмена» в браузере.
          ulog('screen share: отменено пользователем');
          callback();
          return;
        }
        ulog(`screen share: ${source.name} (${source.id})`);
        // audio не просим: на Linux Chromium системный звук не отдаёт (см. шапку).
        callback({ video: source });
      } catch (e) {
        ulog(`screen share failed: ${e.message}`);
        callback();
      }
    },
    // На Wayland отдаём выбор порталу — тогда наш обработчик даже не позовут.
    { useSystemPicker: wayland() },
  );

  ipcMain.handle('screen-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: false,
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: s.thumbnail.toDataURL(),
    }));
  });
}

/**
 * Свой выбор источника (X11). Модальное окно поверх главного: пока человек
 * выбирает, кликать по web-UI нельзя — иначе можно начать второй звонок, пока
 * первый ждёт источник.
 */
function pickSource(parent) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      parent: parent || undefined,
      modal: Boolean(parent),
      width: 760,
      height: 560,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'relay',
      backgroundColor: '#0d0f12',
      webPreferences: {
        preload: path.join(__dirname, 'screen-picker-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    let answered = false;
    const done = (value) => {
      if (answered) return;
      answered = true;
      ipcMain.removeListener('screen-chosen', onChosen);
      resolve(value);
      if (!win.isDestroyed()) win.close();
    };

    const onChosen = (event, source) => {
      if (event.sender === win.webContents) done(source || null);
    };

    ipcMain.on('screen-chosen', onChosen);
    // Закрыли крестиком — это отказ, а не зависший промис.
    win.on('closed', () => done(null));
    win.loadFile(path.join(__dirname, 'screen-picker.html'));
  });
}

module.exports = { installMediaHandlers };
