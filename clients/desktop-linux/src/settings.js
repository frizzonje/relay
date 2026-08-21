'use strict';

// Настройки самой оболочки. Файл — `settings.json` в конфиг-каталоге, общий с
// Tauri-клиентом (см. paths.js и clients/desktop/src-tauri/src/settings.rs).
//
// Здесь живёт только автозапуск: глобального PTT-хоткея у Linux-оболочки пока
// нет (на Wayland он упирается в портал GlobalShortcuts, у которого свои
// незакрытые баги), и поле `ptt` мы НЕ трогаем — читаем и переписываем как есть,
// чтобы человек, вернувшийся на Tauri-сборку, нашёл свою комбинацию на месте.
//
// Автозапуск на Linux — это файл `~/.config/autostart/relay.desktop` (XDG).
// Electron его писать не умеет (`app.setLoginItemSettings` — только Windows и
// macOS), поэтому пишем сами, тем же именем и с тем же аргументом `--hidden`,
// что и tauri-plugin-autostart: одна запись на две оболочки, а не две записи,
// спорящие друг с другом.

const fs = require('node:fs');
const path = require('node:path');

const { autostartDir, settingsFile } = require('./paths');
const { ulog } = require('./log');

/** Имя записи автозапуска — то же, что у Tauri-клиента (productName = relay). */
const AUTOSTART_FILE = 'relay.desktop';

/** Аргумент записи автозапуска: при входе в систему окно не лезет в лицо. */
const HIDDEN_ARG = '--hidden';

/**
 * Прочитать настройки. Любая беда (нет файла, битый JSON, нет прав) — это
 * дефолты, а не отказ стартовать: без настроек клиент обязан работать. Причина
 * возвращается строкой, чтобы вызывающий её залогировал.
 */
function load() {
  const file = settingsFile();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // Файла нет — обычный первый запуск, не ошибка.
    return e.code === 'ENOENT'
      ? { data: {}, error: null }
      : { data: {}, error: `чтение ${file}: ${e.message}` };
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { data: {}, error: `битый ${file}: не объект` };
    }
    return { data, error: null };
  } catch (e) {
    return { data: {}, error: `битый ${file}: ${e.message}` };
  }
}

/**
 * Дописать поля в `settings.json`, сохранив всё остальное (в том числе `ptt`
 * чужой оболочки). Пишем через временный файл: оборванная запись не должна
 * оставить человека с битым файлом настроек.
 */
function patch(fields) {
  const file = settingsFile();
  const { data } = load();
  const next = { ...data, ...fields };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (e) {
    ulog(`settings save: ${e.message}`);
  }
  return next;
}

/** Путь, который должен стоять в записи автозапуска. */
function launchTarget() {
  // AppImage переезжает вместе с файлом, и `process.execPath` внутри него
  // указывает на распакованный /tmp/.mount_* — запись с таким путём протухнет
  // сразу после закрытия приложения. $APPIMAGE ставит сам рантайм AppImage.
  return process.env.APPIMAGE || process.execPath;
}

function autostartPath() {
  return path.join(autostartDir(), AUTOSTART_FILE);
}

/** Фактическое состояние: файл автозапуска есть и указывает на нас. */
function autostartEnabled() {
  try {
    return fs.readFileSync(autostartPath(), 'utf8').includes(launchTarget());
  } catch {
    return false;
  }
}

function desktopEntry() {
  const exec = launchTarget();
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=relay',
    'Comment=relay — голос и чат',
    // Кавычки: путь к AppImage запросто лежит в каталоге с пробелом.
    `Exec="${exec}" ${HIDDEN_ARG}`,
    'Icon=relay',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

/**
 * Включить/выключить автозапуск. Возвращает причину отказа строкой (её увидит
 * человек в настройках) или null, если всё получилось.
 */
function setAutostart(on) {
  const file = autostartPath();
  try {
    if (on) {
      fs.mkdirSync(autostartDir(), { recursive: true });
      fs.writeFileSync(file, desktopEntry());
      patch({ autostart: true, autostart_path: launchTarget() });
      ulog(`autostart on -> ${file} (${launchTarget()})`);
    } else {
      fs.rmSync(file, { force: true });
      patch({ autostart: false, autostart_path: null });
      ulog('autostart off');
    }
    return null;
  } catch (e) {
    ulog(`autostart ${on ? 'on' : 'off'} failed: ${e.message}`);
    return e.message;
  }
}

/**
 * Сверить запись автозапуска с текущим положением приложения. AppImage
 * переносят руками — после переезда запись указывала бы в пустоту, и человек
 * узнал бы об этом только тем, что relay перестал подниматься при входе.
 */
function reconcileAutostart() {
  const { data, error } = load();
  if (error) ulog(`settings load: ${error} (беру значения по умолчанию)`);
  if (!data.autostart) return;
  if (autostartEnabled()) return;
  // Пользователь мог снять автозапуск средствами системы — тогда файла нет
  // вовсе, и навязываться нельзя. Перерегистрируем ТОЛЬКО переехавшую запись.
  if (!fs.existsSync(autostartPath())) {
    patch({ autostart: false, autostart_path: null });
    ulog('autostart: записи нет — считаем выключенным');
    return;
  }
  ulog(`autostart: путь устарел (${data.autostart_path}) → перерегистрирую`);
  setAutostart(true);
}

module.exports = {
  HIDDEN_ARG,
  autostartEnabled,
  launchTarget,
  load,
  patch,
  reconcileAutostart,
  setAutostart,
};
