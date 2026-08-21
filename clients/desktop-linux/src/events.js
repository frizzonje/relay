'use strict';

// Словарь моста: какие события ходят между web-UI и оболочкой. Имена — те же,
// что у Tauri-клиента (clients/desktop/src-tauri/src/main.rs), потому что
// web-сторона одна на обе оболочки: apps/web/lib/desktop.ts, lib/signer-shell.ts.
//
// Список — это граница доверия, а не документация: страницу мы грузим с чужого
// сервера, и всё, чего здесь нет, отклоняется с внятной ошибкой (у Tauri ту же
// роль играет capabilities/remote.json).

/** Страница → оболочка. */
const FROM_PAGE = [
  // Статус звонка для трея: { in_call, muted }.
  'voice-status',
  // Запрос настроек оболочки; ответ — событие `desktop-settings`.
  'desktop-settings-get',
  // Автозапуск при входе в систему (bool).
  'set-autostart',
  // Глобальный PTT-хоткей. Linux-оболочка его пока не умеет и честно отвечает
  // отказом — но имя принимаем, чтобы старый web-UI получил причину, а не
  // молчание (см. main.js).
  'set-ptt-shortcut',
  // Вернуться на экран выбора сервера.
  'switch-server',
  // Обновления: проверить / поставить.
  'check-updates',
  'install-update',
  // Личность: { id, op: 'key' | 'sign', message? } → `identity-reply`.
  'identity-request',
  // Экран выбора сервера доложил, что в движке нет WebRTC. В Electron такого
  // быть не может — но если вдруг, это первое, что нужно увидеть в логе.
  'webrtc-missing',
  // Открылся/закрылся выбор источника демонстрации экрана (bool) — только лог.
  'screen-picker',
];

/** Оболочка → страница. */
const TO_PAGE = [
  // Глобальный push-to-talk нажат/отпущен (bool). Оболочка его пока не шлёт.
  'ptt',
  // Настройки оболочки (ответ на `desktop-settings-get`).
  'desktop-settings',
  // Статус обновления: checking | up-to-date | available | installing | error.
  'update-status',
  // Ответ на `identity-request` с тем же id.
  'identity-reply',
];

module.exports = { FROM_PAGE, TO_PAGE };
