/** Каталог настроек, группа `moderation` — модерация. */

import { NOTICE_MAX, LIST_MAX } from '../limits';
import type { SettingSpec } from '../spec';

export const MODERATION_SETTINGS: readonly SettingSpec[] = [
  // Двадцать реплик в секунду и всплеск в сорок — это RL_REFILL_PER_SEC и
  // RL_CAPACITY общего лимитера (gateway/perimeter.ts): столько сервер
  // принимает от одного сокета сегодня. Потолок равен умолчанию по той же
  // причине, что и у размера загрузки: выше общий лимитер всё равно не пустит,
  // и поле, которое вверх не двигается, не должно этого обещать.
  {
    key: 'moderation.messageRatePerMinute',
    group: 'moderation',
    kind: 'number',
    fallback: 1200,
    applies: 'now',
    min: 1,
    max: 1200,
  },
  {
    key: 'moderation.messageBurst',
    group: 'moderation',
    kind: 'number',
    fallback: 40,
    applies: 'now',
    min: 1,
    max: 40,
  },
  {
    key: 'moderation.allowEdit',
    group: 'moderation',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  // Ноль — без предела: сегодня правка не протухает.
  {
    key: 'moderation.editWindowMinutes',
    group: 'moderation',
    kind: 'number',
    fallback: 0,
    applies: 'now',
    min: 0,
    max: 10080,
  },
  {
    key: 'moderation.allowDelete',
    group: 'moderation',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  {
    key: 'moderation.bannedWords',
    group: 'moderation',
    kind: 'list',
    fallback: [],
    applies: 'now',
    max: LIST_MAX,
  },
  {
    key: 'moderation.bannedWordsAction',
    group: 'moderation',
    kind: 'select',
    fallback: 'block',
    applies: 'now',
    options: ['block', 'flag'],
  },
  {
    key: 'moderation.linksAllowed',
    group: 'moderation',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  // Восемь — LIMIT.mentions в gateway/protocol.ts: больше сервер и сегодня не
  // принимает, лишние имена просто не доезжают.
  {
    key: 'moderation.maxMentionsPerMessage',
    group: 'moderation',
    kind: 'number',
    fallback: 8,
    applies: 'now',
    min: 0,
    max: 50,
  },
  {
    key: 'moderation.readOnlyMode',
    group: 'moderation',
    kind: 'boolean',
    fallback: false,
    applies: 'now',
    danger: true,
  },
  {
    key: 'moderation.serverOwnersCanBan',
    group: 'moderation',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  {
    key: 'moderation.banNotice',
    group: 'moderation',
    kind: 'multiline',
    fallback: '',
    applies: 'now',
    max: NOTICE_MAX,
  },
];
