/** Каталог настроек, группа `appearance` — вид инсталляции. */

import { NOTICE_MAX, RULES_MAX } from '../limits';
import type { SettingSpec } from '../spec';

export const APPEARANCE_SETTINGS: readonly SettingSpec[] = [
  {
    key: 'appearance.installName',
    group: 'appearance',
    kind: 'text',
    fallback: 'relay',
    applies: 'now',
    max: 48,
    client: true,
  },
  {
    key: 'appearance.installEmoji',
    group: 'appearance',
    kind: 'text',
    fallback: '',
    applies: 'now',
    max: 8,
    client: true,
  },
  // Тёмная — историческая тема relay и единственная, которую ставит layout.tsx
  // до первого выбора человека (lib/theme.ts).
  {
    key: 'appearance.defaultTheme',
    group: 'appearance',
    kind: 'select',
    fallback: 'dark',
    applies: 'new',
    options: ['system', 'dark', 'light'],
    client: true,
  },
  {
    key: 'appearance.defaultLocale',
    group: 'appearance',
    kind: 'select',
    fallback: 'en',
    applies: 'new',
    options: ['en', 'ru'],
    client: true,
  },
  {
    key: 'appearance.loginNotice',
    group: 'appearance',
    kind: 'multiline',
    fallback: '',
    applies: 'now',
    max: NOTICE_MAX,
    client: true,
  },
  {
    key: 'appearance.rulesText',
    group: 'appearance',
    kind: 'multiline',
    fallback: '',
    applies: 'now',
    max: RULES_MAX,
    client: true,
  },
  {
    key: 'appearance.showVersion',
    group: 'appearance',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
    client: true,
  },
];
