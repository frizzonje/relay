'use strict';

// Разбор адреса окна: от него зависит, кому оболочка отдаёт личность и куда
// пускает навигацию. Ошибка здесь тихая и дорогая, поэтому правила зафиксированы.

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { originOf, safeProtocol } = require('../src/url');

test('origin берётся только у http(s)', () => {
  assert.equal(originOf('https://relay.example.com/app#x'), 'https://relay.example.com');
  assert.equal(originOf('http://localhost:8080/'), 'http://localhost:8080');
  // Порт по умолчанию в origin не пишется — это тот же сервер.
  assert.equal(originOf('https://relay.example.com:443/'), 'https://relay.example.com');
});

test('у экрана выбора сервера личности нет', () => {
  // Локальная страница живёт по file://, и заводить там ключ не на что.
  assert.equal(originOf('file:///opt/relay/picker/index.html'), null);
  assert.equal(originOf('about:blank'), null);
  assert.equal(originOf('не адрес вовсе'), null);
});

test('протокол читается без падений', () => {
  assert.equal(safeProtocol('https://relay.example.com'), 'https:');
  assert.equal(safeProtocol('mailto:someone@example.com'), 'mailto:');
  assert.equal(safeProtocol(''), '');
});
