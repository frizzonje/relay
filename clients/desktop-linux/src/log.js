'use strict';

// Диагностический лог оболочки — тот же файл, что у Tauri-клиента:
// `$HOME/relay-update.log`, строки `<unix-время> <текст>`. Имя историческое (начиналось
// как лог апдейтера) и НЕ меняется намеренно: его уже знают и просят у людей первым
// делом, когда «просто не работает». Формат одинаковый с
// `clients/desktop/src-tauri/src/main.rs` (`ulog`), чтобы один и тот же вопрос
// «пришли лог» работал для обеих оболочек.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FILE = path.join(os.homedir(), 'relay-update.log');

/** Строка в stderr (видно при запуске из терминала) и в файл (видно потом). */
function ulog(msg) {
  process.stderr.write(`[relay-update] ${msg}\n`);
  try {
    fs.appendFileSync(FILE, `${Math.floor(Date.now() / 1000)} ${msg}\n`);
  } catch {
    // Лог — вспомогательная вещь: недоступный $HOME не повод падать.
  }
}

module.exports = { ulog, LOG_FILE: FILE };
