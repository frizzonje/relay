import type { CSSProperties } from 'react';
import { tx } from '@/lib/i18n';
import { seedGradient } from './gradient';

/**
 * Аватар участника — детерминированный градиент по имени (стабилен для одного
 * человека), из общей холодной палитры relay (см. lib/gradient).
 */

/** Приглушённый холодный градиент — фон кружка-аватара. */
export function avatarGradient(name: string): string {
  // Свой суффикс «(вы)» не должен менять цвет — отбрасываем его перед seed.
  // Хвост «(вы)» переводится вместе с интерфейсом, поэтому срезаем любой
  // парный хвост в скобках: в теге их не бывает (sanitizeTag их выкидывает),
  // а аватар обязан остаться тем же, на каком бы языке ни была подпись.
  const seed = (name || '?').replace(/\s*\([^)]*\)\s*$/, '').trim() || '?';
  return seedGradient(seed);
}

/** Плоский кружок-аватар (панель юзера, состав, чат). */
export function avatarStyle(name: string): CSSProperties {
  return { background: avatarGradient(name) };
}

/** Случайное имя-подсказка вида «Сокол-42». */
export function randomCallsign(): string {
  // Пул подсказок живёт в словаре: русскому предлагать «Falcon-42» так же
  // неуютно, как англичанину «Сокол-42». Список — строка через запятую,
  // потому что словарь плоский; свой язык добавляет свой набор слов.
  const pool = tx('identity.callsigns').split(',');
  const base = pool[Math.floor(Math.random() * pool.length)];
  const num = Math.floor(Math.random() * 90) + 10;
  return `${base}-${num}`;
}
