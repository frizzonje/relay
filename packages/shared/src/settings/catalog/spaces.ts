/** Каталог настроек, группа `spaces` — серверы и каналы. */

import type { SettingSpec } from '../spec';

export const SPACES_SETTINGS: readonly SettingSpec[] = [
  {
    key: 'spaces.creationAllowed',
    group: 'spaces',
    kind: 'select',
    fallback: 'everyone',
    applies: 'now',
    options: ['everyone', 'owner'],
  },
  // MAX_SERVERS_PER_PERSON = 5, MAX_SERVERS = 50, MAX_CHANNELS_PER_SERVER = 25
  // — потолки реестра (gateway/registry/registry.service.ts). Ноль в личном потолке —
  // «своих серверов заводить нельзя».
  {
    key: 'spaces.maxServersPerIdentity',
    group: 'spaces',
    kind: 'number',
    fallback: 5,
    applies: 'now',
    min: 0,
    max: 100,
  },
  {
    key: 'spaces.maxServersInstall',
    group: 'spaces',
    kind: 'number',
    fallback: 50,
    applies: 'now',
    min: 1,
    max: 1000,
  },
  {
    key: 'spaces.maxChannelsPerServer',
    group: 'spaces',
    kind: 'number',
    fallback: 25,
    applies: 'now',
    min: 1,
    max: 500,
  },
  {
    key: 'spaces.lockedServersAllowed',
    group: 'spaces',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  // Канал, заведённый без явного режима, сегодня прямой (mode не проставлен).
  {
    key: 'spaces.defaultVoiceMode',
    group: 'spaces',
    kind: 'select',
    fallback: 'p2p',
    applies: 'new',
    options: ['p2p', 'sfu'],
  },
  // Ноль — без предела, как у квот на файлы и у первых реплик в ЛС: сегодня в
  // голосовой канал пускают всех, кто до него дошёл, и число здесь означало бы
  // запрет там, где вчера запрета не было.
  {
    key: 'spaces.maxVoiceOccupants',
    group: 'spaces',
    kind: 'number',
    fallback: 0,
    applies: 'now',
    min: 0,
    max: 100,
  },
  // LIMIT.name = 32 — столько сервер принимает в имени сервера или канала.
  {
    key: 'spaces.channelNameMaxLength',
    group: 'spaces',
    kind: 'number',
    fallback: 32,
    applies: 'now',
    min: 1,
    max: 64,
    client: true,
  },
];
