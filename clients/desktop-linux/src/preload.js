'use strict';

// Мост между web-UI и оболочкой. Единственное, что страница получает от Node, —
// две функции: подписаться на событие и отправить событие. Ни файловой системы,
// ни ключа личности, ни доступа к окну.
//
// Форма нарочно повторяет `window.__TAURI__.event` (listen → Promise<unlisten>,
// handler получает `{ payload }`, emit → Promise, который ОТКЛОНЯЕТСЯ при
// отказе): web-сторона (apps/web/lib/desktop.ts) говорит с обеими оболочками
// одним кодом, а отказ видно в консоли, а не «оболочка просто ничего не умеет».
//
// Preload здесь песочный (sandbox: true), и `require` относительных файлов ему
// недоступен — списки разрешённых событий приезжают из главного процесса
// аргументами окна (`additionalArguments`, см. src/main.js). Так у списка
// остаётся ровно один источник истины (src/events.js), и он не разъедется с
// тем, что реально принимает главный процесс.

const { contextBridge, ipcRenderer } = require('electron');

/** Канал IPC один на все события: имя события едет первым аргументом. */
const EMIT = 'shell:emit';
const EVENT = 'shell:event';

function listFromArgv(flag) {
  const arg = process.argv.find((a) => a.startsWith(flag));
  if (!arg) return [];
  try {
    return JSON.parse(arg.slice(flag.length));
  } catch {
    return [];
  }
}

const FROM_PAGE = listFromArgv('--relay-from=');
const TO_PAGE = listFromArgv('--relay-to=');

function listen(event, handler) {
  if (!TO_PAGE.includes(event)) {
    return Promise.reject(new Error(`оболочка не шлёт событие «${event}»`));
  }
  const wrapped = (_e, name, payload) => {
    if (name === event) handler({ payload });
  };
  ipcRenderer.on(EVENT, wrapped);
  return Promise.resolve(() => ipcRenderer.removeListener(EVENT, wrapped));
}

function emit(event, payload) {
  if (!FROM_PAGE.includes(event)) {
    return Promise.reject(new Error(`оболочка не принимает событие «${event}»`));
  }
  return ipcRenderer.invoke(EMIT, event, payload);
}

// Только главный фрейм: iframe со сторонним содержимым не должен получить мост.
if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('__RELAY_SHELL__', { kind: 'electron', listen, emit });
}
