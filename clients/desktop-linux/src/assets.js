'use strict';

// Общие с Tauri-клиентом файлы: экран выбора сервера (clients/desktop/src) и
// знак relay (clients/desktop/src-tauri/icons). Копий здесь нет намеренно — у
// пикера и иконок один источник, иначе две оболочки разъедутся внешне. В
// собранное приложение они попадают через `extraResources` (см. package.json →
// build), в рабочем дереве берутся прямо из соседнего каталога.

const path = require('node:path');
const { app } = require('electron');

const packaged = () => app.isPackaged;

/** Экран выбора сервера — единственная «своя» страница оболочки. */
function pickerPage() {
  return packaged()
    ? path.join(process.resourcesPath, 'picker', 'index.html')
    : path.join(__dirname, '..', '..', 'desktop', 'src', 'index.html');
}

function icon(name) {
  return packaged()
    ? path.join(process.resourcesPath, 'icons', name)
    : path.join(__dirname, '..', '..', 'desktop', 'src-tauri', 'icons', name);
}

module.exports = { icon, pickerPage };
