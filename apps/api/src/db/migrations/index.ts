import { InitialSchema1755000000000 } from './1755000000000-InitialSchema';
import { OwnerClaim1756000000000 } from './1756000000000-OwnerClaim';
import { CreatorIdentity1757000000000 } from './1757000000000-CreatorIdentity';
import { Prefs1758000000000 } from './1758000000000-Prefs';

/**
 * Миграции по порядку. Список руками, а не `migrations: ['dist/**']` по маске:
 * забытый файл в маске — это молча непримененная миграция на чужом сервере, а
 * забытая строка здесь ломает сборку у нас.
 */
export const MIGRATIONS = [
  InitialSchema1755000000000,
  OwnerClaim1756000000000,
  CreatorIdentity1757000000000,
  Prefs1758000000000,
];
