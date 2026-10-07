/** Каталог настроек, группа `messages` — сообщения и хранение. */

import type { SettingSpec } from '../spec';

export const MESSAGES_SETTINGS: readonly SettingSpec[] = [
  /**
   * Режим хранения и число дней засеваются одной переменной `RETENTION_DAYS`
   * (её разбирает db/retention.service.ts): она задаёт и то, и другое сразу.
   * Повесь `env` только на режим — и инсталляция с `RETENTION_DAYS=30` после
   * обновления начала бы удалять переписку через четырнадцать дней.
   */
  {
    key: 'messages.retentionMode',
    group: 'messages',
    kind: 'select',
    fallback: 'days',
    applies: 'now',
    options: ['days', 'forever', 'ephemeral'],
    danger: true,
    env: 'RETENTION_DAYS',
  },
  {
    key: 'messages.retentionDays',
    group: 'messages',
    kind: 'number',
    fallback: 14,
    applies: 'now',
    min: 1,
    max: 3650,
    env: 'RETENTION_DAYS',
  },
  // LIMITS.chatText — столько сервер принимает от клиента сегодня.
  {
    key: 'messages.maxLength',
    group: 'messages',
    kind: 'number',
    fallback: 500,
    applies: 'now',
    min: 1,
    max: 8000,
    client: true,
  },
  {
    key: 'messages.pageSize',
    group: 'messages',
    kind: 'number',
    fallback: 50,
    applies: 'new',
    min: 10,
    max: 200,
  },
  {
    key: 'messages.pinLimit',
    group: 'messages',
    kind: 'number',
    fallback: 50,
    applies: 'now',
    min: 0,
    max: 500,
  },
  {
    key: 'messages.searchEnabled',
    group: 'messages',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  {
    key: 'messages.reactionsEnabled',
    group: 'messages',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  {
    key: 'messages.typingIndicator',
    group: 'messages',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  // Выключены, потому что сегодня системных строк в ленте нет вовсе: колонка
  // `system` есть, лента её рисует, а писать в неё некому. Включённые по
  // умолчанию, они добавили бы в чужие каналы строку, которой там не было, —
  // это и есть «умолчание, близкое к прежнему поведению», а требуется равное.
  {
    key: 'messages.systemMessages',
    group: 'messages',
    kind: 'boolean',
    fallback: false,
    applies: 'now',
  },
  {
    key: 'messages.replyPreviewLength',
    group: 'messages',
    kind: 'number',
    fallback: 120,
    applies: 'now',
    min: 20,
    max: 500,
  },
];
