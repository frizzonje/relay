/** Каталог настроек, группа `maintenance` — обслуживание. */

import { NOTICE_MAX } from '../limits';
import type { SettingSpec } from '../spec';

export const MAINTENANCE_SETTINGS: readonly SettingSpec[] = [
  {
    key: 'maintenance.mode',
    group: 'maintenance',
    kind: 'boolean',
    fallback: false,
    applies: 'now',
    danger: true,
  },
  {
    key: 'maintenance.message',
    group: 'maintenance',
    kind: 'multiline',
    fallback: '',
    applies: 'now',
    max: NOTICE_MAX,
  },
  {
    key: 'maintenance.bannerText',
    group: 'maintenance',
    kind: 'multiline',
    fallback: '',
    applies: 'now',
    max: 500,
    client: true,
  },
];
