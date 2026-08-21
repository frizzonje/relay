'use strict';

// Где оболочка держит своё. Каталог ТОТ ЖЕ, что у Tauri-клиента —
// `$XDG_CONFIG_HOME/app.relay.desktop` (по умолчанию `~/.config/app.relay.desktop`).
//
// Это не косметика, а условие апгрейда: у человека, который сидел на Tauri-сборке,
// там уже лежат `settings.json` и ключи личности (`identity/<хеш>.key`). Возьми
// Electron свой каталог по умолчанию (`~/.config/relay`), и после обновления
// клиент представился бы серверу НОВЫМ человеком — с чужой лентой и без имени.
// Профиль Chromium (куки, localStorage) кладём туда же: движок другой, старые
// куки WebKitGTK всё равно не переносимы, но дальше они переживают обновления.

const os = require('node:os');
const path = require('node:path');

/** Идентификатор приложения — он же имя каталога и имя записи автозапуска. */
const APP_ID = 'app.relay.desktop';

function configDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, APP_ID);
}

/** Каталог ключей личности (по ключу на origin) — см. identity.js. */
function identityDir() {
  return path.join(configDir(), 'identity');
}

/** Файл настроек оболочки (PTT-хоткей, автозапуск) — формат общий с Rust. */
function settingsFile() {
  return path.join(configDir(), 'settings.json');
}

/** Каталог автозапуска по XDG: туда кладётся `relay.desktop`. */
function autostartDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'autostart');
}

module.exports = { APP_ID, configDir, identityDir, settingsFile, autostartDir };
