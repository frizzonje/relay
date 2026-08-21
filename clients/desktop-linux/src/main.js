'use strict';

// relay desktop для Linux — Electron-оболочка над тем же web-клиентом.
//
// ПОЧЕМУ ОТДЕЛЬНАЯ ОБОЛОЧКА, А НЕ ОБЩАЯ TAURI-СБОРКА
//
// Tauri берёт системный webview, а на Linux это WebKitGTK, собранный БЕЗ
// WebRTC: upstream держит `-DENABLE_WEB_RTC=OFF` по умолчанию, и ни один
// мейнстрим-дистрибутив флаг не включает. Проверено 2026-08-21 на самых свежих
// стабильных сборках: Debian 13 (2.52.5) — `RTCPeerConnection` в движке
// `undefined` даже при выставленном `enable-webrtc`; Fedora 44 (2.52.5) — в
// `libwebkit2gtk-4.1.so.0` нет ни `createOffer`, ни `addIceCandidate`. То есть
// голосового клиента на Tauri под Linux не бывает, и правками нашего кода это
// не лечится. Chromium (Electron) звонит — поэтому под Linux оболочка своя.
//
// Всё остальное — как у Tauri-клиента и специально теми же именами: события
// моста, файл настроек, файл ключа личности, `~/relay-update.log`. Человек,
// обновившийся с Tauri-сборки, остаётся собой (см. paths.js, identity.js).
//
// Мост (страница ↔ оболочка) — только события из src/events.js:
//   • оболочка → страница: `desktop-settings`, `update-status`, `identity-reply`;
//   • страница → оболочка: `voice-status`, `desktop-settings-get`,
//     `set-autostart`, `switch-server`, `check-updates`, `install-update`,
//     `identity-request`, `screen-picker`, `webrtc-missing`.

const path = require('node:path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');

const identity = require('./identity');
const settings = require('./settings');
const { FROM_PAGE, TO_PAGE } = require('./events');
const { icon, pickerPage } = require('./assets');
const { ulog } = require('./log');
const { configDir } = require('./paths');
const { installMediaHandlers } = require('./media');
const { buildTray, updateTray } = require('./tray');
const { originOf, safeProtocol } = require('./url');
const { checkUpdates, installUpdate } = require('./updater');

/** Аргумент записи автозапуска: окно при входе в систему не показываем. */
const HIDDEN_ARG = settings.HIDDEN_ARG;

/** Сколько ждём перед тихой стартовой проверкой обновлений: сначала окно и звук. */
const STARTUP_CHECK_DELAY_MS = 15_000;

const state = {
  /** Главное окно. */
  win: null,
  /** Состояние звонка — его показывает трей (приходит событием `voice-status`). */
  inCall: false,
  muted: false,
};

// ── Окружение ───────────────────────────────────────────────────────────────

// Wayland: без подсказки Electron уходит в XWayland, и вместе с ним — в
// размытую картинку на HiDPI и в X11-путь захвата экрана вместо портала.
// Переменную, заданную пользователем, не трогаем: человек, обходящий баг
// своего драйвера, должен иметь возможность это сделать.
if (!process.env.ELECTRON_OZONE_PLATFORM_HINT) {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
}

app.setName('relay');
// Профиль Chromium и наши файлы — в общий с Tauri-клиентом каталог (см. paths.js).
app.setPath('userData', configDir());

// ── Одно окно на машину ─────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  // Второй запуск не плодит процесс: показываем окно уже работающего и уходим.
  app.exit(0);
} else {
  app.on('second-instance', () => showMain());
  start();
}

function start() {
  app.on('window-all-closed', () => {
    // Трей — не «свернуть в фон навсегда»: окно закрыли — приложение закрылось.
    // Иначе на Linux, где трея может не быть вовсе (GNOME без расширения),
    // relay остался бы висеть процессом без единого способа его достать.
    app.quit();
  });

  app.whenReady().then(() => {
    const hidden = process.argv.includes(HIDDEN_ARG);
    ulog(
      `start (hidden=${hidden}) electron ${process.versions.electron}, chrome ${process.versions.chrome}, ` +
        `session=${process.env.XDG_SESSION_TYPE || '-'}, wayland=${process.env.WAYLAND_DISPLAY || '-'}, ` +
        `ozone=${app.commandLine.getSwitchValue('ozone-platform-hint') || '-'}`,
    );

    settings.reconcileAutostart();
    installMediaHandlers(() => state.win);
    wireBridge();
    createWindow(hidden);
    buildTray({
      onOpen: showMain,
      onSwitchServer: showPicker,
      onCheckUpdates: () => checkUpdates(sendToPage, { announce: true }),
      onQuit: () => app.quit(),
    });

    // Тихая проверка при старте: находку показываем системным уведомлением,
    // ставим — только по кнопке. Отложена, чтобы не толкаться с загрузкой UI.
    setTimeout(() => checkUpdates(sendToPage, { notify: true }), STARTUP_CHECK_DELAY_MS);
  });
}

// ── Окно ────────────────────────────────────────────────────────────────────

function createWindow(hidden) {
  state.win = new BrowserWindow({
    width: 1280,
    height: 788,
    minWidth: 960,
    minHeight: 600,
    center: true,
    show: !hidden,
    title: 'relay',
    backgroundColor: '#08090b',
    icon: icon('icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Списки событий моста — в песочный preload их иначе не передать
      // (`require` относительных файлов там недоступен), а дублировать их
      // в двух файлах значит однажды разъехаться.
      additionalArguments: [
        `--relay-from=${JSON.stringify(FROM_PAGE)}`,
        `--relay-to=${JSON.stringify(TO_PAGE)}`,
      ],
    },
  });

  // Куда бы ни ушла страница — origin для личности снимаем с самого окна.
  const wc = state.win.webContents;
  wc.on('did-navigate', (_e, url) => {
    ulog(`page load finished: ${url}`);
  });
  wc.on('did-start-navigation', (_e, url, _isInPlace, isMainFrame) => {
    if (isMainFrame) ulog(`page load started: ${url}`);
  });
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame) ulog(`page load FAILED (${code} ${desc}): ${url}`);
  });
  wc.on('render-process-gone', (_e, details) => ulog(`renderer gone: ${details.reason}`));

  // Внешние ссылки (в чате их полно) открывает системный браузер, а не наше
  // окно: иначе человек уходит с relay и не понимает, как вернуться, а страница
  // чужого сайта оказывается внутри оболочки с мостом.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(safeProtocol(url))) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    const proto = safeProtocol(url);
    if (proto === 'file:' || proto === 'http:' || proto === 'https:') return;
    event.preventDefault();
    ulog(`навигация отклонена: ${url}`);
  });

  state.win.on('closed', () => {
    state.win = null;
  });

  state.win.loadFile(pickerPage());
}

function showMain() {
  if (!state.win) return;
  state.win.show();
  if (state.win.isMinimized()) state.win.restore();
  state.win.focus();
}

/**
 * Вернуть окно на экран выбора сервера. `#pick` запрещает пикеру автоматически
 * уйти на последний сервер — иначе «Сменить сервер» замкнулось бы в петлю:
 * экран открылся и тут же ушёл обратно, и адрес было бы не поменять.
 */
function showPicker() {
  if (!state.win) return;
  ulog('switch-server -> picker');
  state.win.loadFile(pickerPage(), { hash: 'pick' });
  showMain();
  // Звонок рвётся вместе с уходом со страницы — трей об этом уже не услышит.
  state.inCall = false;
  state.muted = false;
  updateTray(false, false);
}

// ── Мост ────────────────────────────────────────────────────────────────────

/** Отправить событие странице (то, что у Tauri делает `app.emit`). */
function sendToPage(event, payload) {
  if (!state.win || state.win.isDestroyed()) return;
  state.win.webContents.send('shell:event', event, payload);
}

function wireBridge() {
  ipcMain.handle('shell:emit', (event, name, payload) => {
    if (!FROM_PAGE.includes(name)) {
      // Отказ возвращается странице отклонённым промисом — web-UI пишет причину
      // в консоль (см. `send` в apps/web/lib/desktop.ts).
      throw new Error(`оболочка не принимает событие «${name}»`);
    }
    handle(name, payload, event.sender);
  });
}

function handle(name, payload, sender) {
  switch (name) {
    case 'voice-status': {
      state.inCall = Boolean(payload && payload.in_call);
      state.muted = Boolean(payload && payload.muted);
      updateTray(state.inCall, state.muted);
      return;
    }

    case 'desktop-settings-get':
      sendSettings();
      return;

    case 'set-autostart': {
      const error = settings.setAutostart(payload === true);
      sendSettings(error);
      return;
    }

    case 'set-ptt-shortcut':
      // Глобального хоткея у Linux-оболочки пока нет. Молчать нельзя: старый
      // web-UI ждёт ответа и без него оставит «Применяю…» навсегда.
      ulog(`set-ptt-shortcut ${JSON.stringify(payload)} — не поддержано в Linux-оболочке`);
      sendSettings();
      return;

    case 'switch-server':
      showPicker();
      return;

    case 'check-updates':
      checkUpdates(sendToPage, { notify: payload && payload.notify === true, announce: false });
      return;

    case 'install-update':
      installUpdate(sendToPage);
      return;

    case 'identity-request': {
      // Origin берём у самого окна, а не из тела запроса: то, что прислала
      // страница, — это её слова о себе.
      const origin = originOf(sender.getURL());
      sendToPage('identity-reply', identity.answer(payload, origin));
      return;
    }

    case 'screen-picker':
      ulog(`screen picker ${payload === true ? 'opened' : 'closed'}`);
      return;

    case 'webrtc-missing':
      ulog(`WEBRTC MISSING (в Chromium такого быть не должно): ${JSON.stringify(payload)}`);
      return;

    default:
      ulog(`событие «${name}» принято, но обработчика нет`);
  }
}

/**
 * Ответить web-UI состоянием оболочки. Ответ — он же признак поддержки:
 * клиент, который промолчит, не получит в настройках блоков, которые ничего не
 * переключают. Полей `ptt`/`pttDefault` здесь НЕТ намеренно — глобального
 * хоткея эта оболочка не умеет, и строку с рекордером клавиш web-UI не покажет.
 */
function sendSettings(autostartError = null) {
  sendToPage('desktop-settings', {
    autostart: settings.autostartEnabled(),
    autostartError,
    version: app.getVersion(),
  });
}
