/** Каталог настроек, группа `access` — доступ. */

import { SECRET_MAX, LIST_MAX } from '../limits';
import type { SettingSpec } from '../spec';

export const ACCESS_SETTINGS: readonly SettingSpec[] = [
  /**
   * Пароль инсталляции. Хранится хэшем, наружу уходит признаком «задано»;
   * `.env` остаётся резервом на случай пустой таблицы (SITE_PASSWORD).
   * Значение — строка (новый пароль), а не флажок: флажком пароль не сменишь,
   * а «задано/не задано» панель считает сама из непустоты.
   */
  {
    key: 'access.sitePasswordSet',
    group: 'access',
    kind: 'secret',
    fallback: '',
    applies: 'now',
    max: SECRET_MAX,
    secret: true,
    danger: true,
    env: 'SITE_PASSWORD',
  },
  {
    key: 'access.sitePasswordEnabled',
    group: 'access',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  // Дверей ровно две, потому что третьей в relay нет: приглашение здесь —
  // гостевая ссылка в один голосовой канал, личности она не заводит и завести
  // не может. Строка «по приглашению» отличалась бы от «закрыто» только словом,
  // а закрывала бы ровно то же самое — то же враньё, что вид вложения «видео».
  // Вернётся вместе с приглашениями, которые заводят личность.
  {
    key: 'access.identityCreation',
    group: 'access',
    kind: 'select',
    fallback: 'open',
    applies: 'new',
    options: ['open', 'closed'],
  },
  // Ноль — без предела, и это сегодняшнее поведение: связать с личностью можно
  // сколько угодно устройств. Восемь выглядели бы недостижимыми, но у человека
  // с девятью ключами девятый перестал бы связываться в день обновления.
  {
    key: 'access.maxDevicesPerIdentity',
    group: 'access',
    kind: 'number',
    fallback: 0,
    applies: 'now',
    min: 0,
    max: 64,
  },
  // Ровно TOKEN_TTL_MS (30 дней) — срок жизни пропуска сегодня.
  {
    key: 'access.sessionTtlDays',
    group: 'access',
    kind: 'number',
    fallback: 30,
    applies: 'new',
    min: 1,
    max: 365,
  },
  // Восемь неудач подряд живой человек ещё может, дальше это уже не опечатки.
  // Порог один на вход на сайт (auth.controller) и на пароль сервера
  // (gateway/unlock.ts) — оба читают его отсюда.
  {
    key: 'access.unlockAttempts',
    group: 'access',
    kind: 'number',
    fallback: 8,
    applies: 'now',
    min: 1,
    max: 50,
  },
  // Докуда растёт простой после череды неудачных паролей (gateway/unlock.ts).
  {
    key: 'access.unlockLockoutMinutes',
    group: 'access',
    kind: 'number',
    fallback: 5,
    applies: 'now',
    min: 1,
    max: 1440,
  },
  // Ноль — без предела. Дверь сегодня считает НЕУДАЧИ за окно
  // (`access.unlockAttempts`), а попыток в минуту не считает вовсе: поставь
  // сюда двадцать — и общий выход в интернет, за которым сидит десяток людей,
  // упёрся бы в предел, которого вчера не было.
  {
    key: 'access.loginRatePerMinute',
    group: 'access',
    kind: 'number',
    fallback: 0,
    applies: 'now',
    min: 0,
    max: 600,
  },
  {
    key: 'access.newIdentityQuietMinutes',
    group: 'access',
    kind: 'number',
    fallback: 0,
    applies: 'now',
    min: 0,
    max: 1440,
  },
  { key: 'access.guestsEnabled', group: 'access', kind: 'boolean', fallback: true, applies: 'now' },
  /**
   * Закрытые адреса — список масок, а не адресов поимённо.
   *
   * Бан по ключу останавливает происходящее ровно на секунду: личность в relay
   * рождается на устройстве без чьего-либо разрешения, и забаненный заводит
   * новую быстрее, чем владелец закрывает панель. Адрес сменить дороже — не
   * невозможно, но дороже, — и этой разницы хватает, чтобы «прекрати сейчас
   * же» стало исполнимым.
   *
   * Список НЕ уезжает клиенту (`client` не ставим): с кем воюет владелец — не
   * дело чужого браузера, и уж точно не гостевого. Пустой по умолчанию, то
   * есть до первой записи дверь открыта всем, как и была.
   */
  {
    key: 'access.blockedAddresses',
    group: 'access',
    kind: 'list',
    fallback: [],
    applies: 'now',
    max: LIST_MAX,
    items: 'cidr',
  },
];
