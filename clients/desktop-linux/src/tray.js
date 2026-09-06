'use strict';

// Трей: статус звонка, дорога к спрятанному окну, смена сервера, обновления.
// Повторяет меню Tauri-клиента (build_menu в main.rs) — тем же составом и в том
// же порядке, чтобы человек, обновившийся с Tauri-сборки, ничего не искал.
//
// Язык берём у системы, как это делает экран выбора сервера: en — база, ru —
// перевод (см. apps/web/lib/i18n). Трей и системное окошко о входящем звонке —
// единственные места оболочки со своими строками (потому и живут вместе, в
// одном словаре); всё остальное рисует web-UI и переводит себя сам.

const { Menu, Tray, app, nativeImage } = require('electron');

const { icon } = require('./assets');
const { ulog } = require('./log');

let tray = null;
let actions = {};

const RU = {
  status: {
    idle: 'не в эфире',
    live: 'в эфире',
    muted: 'в эфире · микрофон выключен',
    ringing: 'входящий вызов',
  },
  call: { audio: 'Входящий вызов', video: 'Входящий видеозвонок' },
  open: 'Открыть relay',
  switch: 'Сменить сервер…',
  check: 'Проверить обновления',
  quit: 'Выйти из relay',
};

const EN = {
  status: {
    idle: 'not live',
    live: 'live',
    muted: 'live · microphone off',
    ringing: 'incoming call',
  },
  call: { audio: 'Incoming call', video: 'Incoming video call' },
  open: 'Open relay',
  switch: 'Switch server…',
  check: 'Check for updates',
  quit: 'Quit relay',
};

function dict() {
  return app.getLocale().toLowerCase().startsWith('ru') ? RU : EN;
}

/**
 * Строка статуса. Входящий вызов главнее всего остального: на него отвечают
 * сейчас, а не когда-нибудь, — и человек, увидевший подсказку трея, должен
 * узнать об этом первым делом. Разговор при этом никуда не делся: вызов
 * кончится (любым исходом — приняли, отклонили, не ответили), придёт
 * `call-ringing{ringing:false}`, и статус вернётся к тому, что было.
 */
function statusText(inCall, muted, ringing) {
  const t = dict().status;
  if (ringing) return t.ringing;
  if (!inCall) return t.idle;
  return muted ? t.muted : t.live;
}

/**
 * Тело системного окошка о входящем. Вид вызова назван ДО ответа — как и в
 * тосте web-UI: «принять», молча включающее камеру, было бы враньём.
 */
function callBody(video) {
  const t = dict().call;
  return video ? t.video : t.audio;
}

function menu(inCall, muted, ringing) {
  const t = dict();
  return Menu.buildFromTemplate([
    { label: `relay ${app.getVersion()}`, enabled: false },
    { label: statusText(inCall, muted, ringing), enabled: false },
    { type: 'separator' },
    // Первым — единственная дорога к окну, если relay стартовал свёрнутым.
    { label: t.open, click: () => actions.onOpen && actions.onOpen() },
    { label: t.switch, click: () => actions.onSwitchServer && actions.onSwitchServer() },
    { label: t.check, click: () => actions.onCheckUpdates && actions.onCheckUpdates() },
    { label: t.quit, click: () => actions.onQuit && actions.onQuit() },
  ]);
}

/**
 * Поднять трей. Отсутствие трея в системе (GNOME без расширения AppIndicator) —
 * не повод падать: окно и так открыто, а пункты меню дублируются в web-UI.
 */
function buildTray(handlers) {
  actions = handlers || {};
  try {
    const image = nativeImage.createFromPath(icon('tray.png'));
    tray = new Tray(image.isEmpty() ? nativeImage.createFromPath(icon('32x32.png')) : image);
    tray.setToolTip(`relay — ${statusText(false, false, false)}`);
    tray.setContextMenu(menu(false, false, false));
    // На Linux клик по иконке меню НЕ открывает (это делает AppIndicator сам),
    // поэтому вешаем показ окна на клик там, где он вообще доходит.
    tray.on('click', () => actions.onOpen && actions.onOpen());
  } catch (e) {
    tray = null;
    ulog(`трея нет: ${e.message}`);
  }
}

function updateTray(inCall, muted, ringing) {
  if (!tray) return;
  tray.setToolTip(`relay — ${statusText(inCall, muted, ringing)}`);
  tray.setContextMenu(menu(inCall, muted, ringing));
}

module.exports = { buildTray, callBody, statusText, updateTray };
