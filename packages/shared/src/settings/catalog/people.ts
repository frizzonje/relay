/** Каталог настроек, группа `people` — люди. */

import type { SettingSpec } from '../spec';

export const PEOPLE_SETTINGS: readonly SettingSpec[] = [
  {
    key: 'people.nickMinLength',
    group: 'people',
    kind: 'number',
    fallback: 1,
    applies: 'now',
    min: 1,
    max: 32,
  },
  // NICK_MAX = 20 и в @relay/shared, и в identity/crypto.ts сервера: длиннее
  // ник не помещается ни в ленту, ни в список участников.
  {
    key: 'people.nickMaxLength',
    group: 'people',
    kind: 'number',
    fallback: 20,
    applies: 'now',
    min: 1,
    max: 64,
  },
  {
    key: 'people.nickChangeCooldownMinutes',
    group: 'people',
    kind: 'number',
    fallback: 0,
    applies: 'now',
    min: 0,
    max: 1440,
  },
  {
    key: 'people.showFingerprints',
    group: 'people',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
    client: true,
  },
  {
    key: 'people.lastSeenVisible',
    group: 'people',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
    client: true,
  },
  // Ноль — не чистить: сегодня личности не удаляются по бездействию вовсе.
  {
    key: 'people.pruneInactiveDays',
    group: 'people',
    kind: 'number',
    fallback: 0,
    applies: 'now',
    min: 0,
    max: 3650,
  },
];
