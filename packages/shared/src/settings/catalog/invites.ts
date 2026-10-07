/** Каталог настроек, группа `invites` — приглашения и гости. */

import type { SettingSpec } from '../spec';

export const INVITES_SETTINGS: readonly SettingSpec[] = [
  { key: 'invites.enabled', group: 'invites', kind: 'boolean', fallback: true, applies: 'now' },
  // GUEST_TOKEN_TTL_MS — сутки.
  {
    key: 'invites.ttlHours',
    group: 'invites',
    kind: 'number',
    fallback: 24,
    applies: 'now',
    min: 1,
    max: 720,
  },
  {
    key: 'invites.whoCanInvite',
    group: 'invites',
    kind: 'select',
    fallback: 'everyone',
    applies: 'now',
    options: ['everyone', 'owner'],
  },
  // Ноль — без предела: ссылка сегодня многоразовая, и сколько человек по ней
  // придёт, никто не считает.
  {
    key: 'invites.maxGuestsPerChannel',
    group: 'invites',
    kind: 'number',
    fallback: 0,
    applies: 'now',
    min: 0,
    max: 100,
  },
  {
    key: 'invites.listenerByDefault',
    group: 'invites',
    kind: 'boolean',
    fallback: false,
    applies: 'now',
  },
  // Час — GUEST_BAN_MS в gateway/perimeter.ts: столько выгнанный гость сегодня
  // не может вернуться по той же ссылке.
  {
    key: 'invites.guestKickCooldownMinutes',
    group: 'invites',
    kind: 'number',
    fallback: 60,
    applies: 'now',
    min: 1,
    max: 1440,
  },
];
