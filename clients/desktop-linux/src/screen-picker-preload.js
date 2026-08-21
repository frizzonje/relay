'use strict';

// Мост окна выбора источника демонстрации. Страница своя, локальная, но прав ей
// всё равно даём ровно два: спросить список источников и назвать выбранный.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screenPicker', {
  sources: () => ipcRenderer.invoke('screen-sources'),
  choose: (source) => ipcRenderer.send('screen-chosen', source),
  cancel: () => ipcRenderer.send('screen-chosen', null),
});
