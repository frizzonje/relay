/** Каталог настроек, группа `notifications` — уведомления. */

import type { SettingSpec } from '../spec';

export const NOTIFICATIONS_SETTINGS: readonly SettingSpec[] = [
  {
    key: 'notifications.soundEnabled',
    group: 'notifications',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
    client: true,
  },
  {
    key: 'notifications.mentionSound',
    group: 'notifications',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
    client: true,
  },
  {
    key: 'notifications.directSound',
    group: 'notifications',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
    client: true,
  },
  // Раньше здесь стояла заметка «системных уведомлений relay не показывает: ни
  // одного вызова Notification API в клиенте нет — переключатель появится
  // вместе с кодом, который их шлёт». Этот код — входящий звонок (задача 7
  // плана B, `apps/web/lib/notify.ts`, `notifyCall`): первый и пока
  // единственный вызов `new Notification(...)` во всём клиенте. Заметка была
  // верна ровно до этой строки.
  //
  // Своя настройка, а не второе чтение `soundEnabled`: то — рубильник над
  // звуком ЧАТОВЫХ сигналов (сообщение/упоминание/личка, apps/web/lib/
  // notify.ts), это — про системное окошко поверх остальных окон, когда
  // вкладку/приложение свернули. Рингтон входящего звонка под `soundEnabled`
  // не подчинён вовсе: он играет так же, как остальные звуки голоса в этой
  // кодовой базе (apps/web/lib/voice/index.ts) — без отдельного рубильника, но под
  // общим мутом (`sfx.setAllMuted`, деафен глушит и его). Человек волен
  // выключить одно, не трогая другое (беззвучная вкладка — законный выбор, и
  // его не должно чинить выключение попапов, о которых речь не шла).
  {
    key: 'notifications.desktopEnabled',
    group: 'notifications',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
    client: true,
  },
];
