'use strict';

// Настройки и автозапуск. Проверяем ровно то, что ломается молча: чужие поля в
// общем файле и запись автозапуска, которая должна указывать на нас.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, beforeEach, test } = require('node:test');

let settings;
let home;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-settings-'));
  process.env.XDG_CONFIG_HOME = home;
  settings = require('../src/settings');
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const settingsFile = () => path.join(home, 'app.relay.desktop', 'settings.json');
const autostartFile = () => path.join(home, 'autostart', 'relay.desktop');

beforeEach(() => {
  fs.rmSync(settingsFile(), { force: true });
  fs.rmSync(autostartFile(), { force: true });
});

test('нет файла — это первый запуск, а не ошибка', () => {
  assert.deepEqual(settings.load(), { data: {}, error: null });
});

test('битый файл не валит клиент, но и не молчит', () => {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), '{это не json');
  const { data, error } = settings.load();
  assert.deepEqual(data, {});
  assert.match(error, /битый/);
});

test('чужой хоткей переживает нашу запись', () => {
  // Поле `ptt` пишет Tauri-оболочка. Затереть его значит забрать у человека
  // push-to-talk на другой системе — файл-то общий.
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify({ ptt: 'Ctrl+Shift+KeyT', autostart: false }));

  settings.setAutostart(true);

  const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  assert.equal(saved.ptt, 'Ctrl+Shift+KeyT');
  assert.equal(saved.autostart, true);
});

test('автозапуск — запись XDG с --hidden и путём до нас', () => {
  assert.equal(settings.setAutostart(true), null);
  const entry = fs.readFileSync(autostartFile(), 'utf8');
  assert.match(entry, /^\[Desktop Entry\]/);
  assert.match(entry, /--hidden/);
  assert.ok(entry.includes(settings.launchTarget()));
  assert.equal(settings.autostartEnabled(), true);

  settings.setAutostart(false);
  assert.equal(fs.existsSync(autostartFile()), false);
  assert.equal(settings.autostartEnabled(), false);
});

test('снятый средствами системы автозапуск не навязываем обратно', () => {
  settings.setAutostart(true);
  fs.rmSync(autostartFile()); // человек убрал запись сам
  settings.reconcileAutostart();
  assert.equal(fs.existsSync(autostartFile()), false);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).autostart, false);
});

test('переехавшее приложение перерегистрирует свою запись', () => {
  settings.setAutostart(true);
  // Тот самый случай: AppImage перенесли, и запись показывает в пустоту.
  fs.writeFileSync(autostartFile(), 'Exec="/старый/путь/relay.AppImage" --hidden\n');
  assert.equal(settings.autostartEnabled(), false);

  settings.reconcileAutostart();

  assert.equal(settings.autostartEnabled(), true);
  assert.ok(fs.readFileSync(autostartFile(), 'utf8').includes(settings.launchTarget()));
});
