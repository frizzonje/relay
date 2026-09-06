'use strict';

// Строка статуса в трее. Проверяем ровно то, из-за чего трей вообще есть:
// глядя на подсказку у иконки, человек должен понять, что происходит, — и
// входящий вызов тут главнее всего остального, потому что на него надо
// ответить сейчас, а не когда-нибудь.
//
// Electron подделан целиком: тесты идут обычным `node --test`, где
// `require('electron')` возвращает путь к бинарнику, а не API. Подменяем
// загрузчик модулей — так же дёшево, как и честно: из всего Electron строке
// статуса нужен один `app.getLocale()`.

const assert = require('node:assert/strict');
const Module = require('node:module');
const { test } = require('node:test');

let locale = 'en-US';

const electron = {
  app: { getLocale: () => locale, getVersion: () => '1.0.0' },
  Menu: { buildFromTemplate: (items) => items },
  Tray: class {},
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
};

const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'electron' ? electron : load.call(this, request, ...rest);
};

const { callBody, statusText } = require('../src/tray');

test('входящий вызов вытесняет всё остальное — на него отвечают сейчас', () => {
  locale = 'ru-RU';
  assert.equal(statusText(false, false, true), 'входящий вызов');
  // Даже посреди разговора: второй вызов ждать не будет.
  assert.equal(statusText(true, true, true), 'входящий вызов');
});

test('вызов кончился — статус возвращается к тому, что было', () => {
  locale = 'ru-RU';
  assert.equal(statusText(false, false, false), 'не в эфире');
  assert.equal(statusText(true, false, false), 'в эфире');
  assert.equal(statusText(true, true, false), 'в эфире · микрофон выключен');
});

test('старый вызов о двух аргументах ничего не звонит', () => {
  // `updateTray(inCall, muted)` зовут из мест, которые о звонке не знают
  // (смена сервера, старт) — молчаливый undefined там обязан значить «не
  // звонит», а не «звонит».
  locale = 'ru-RU';
  assert.equal(statusText(true, false), 'в эфире');
});

test('en — база, а не забытый перевод', () => {
  locale = 'en-US';
  assert.equal(statusText(false, false, true), 'incoming call');
  assert.equal(statusText(true, true, false), 'live · microphone off');
});

test('окошко называет вид вызова до ответа — и тоже на языке системы', () => {
  // «Принять», молча включающее камеру, было бы враньём — вид вызова человек
  // читает ДО того, как нажмёт (то же правило, что и у тоста web-UI).
  locale = 'ru-RU';
  assert.equal(callBody(false), 'Входящий вызов');
  assert.equal(callBody(true), 'Входящий видеозвонок');
  locale = 'en-US';
  assert.equal(callBody(true), 'Incoming video call');
});
