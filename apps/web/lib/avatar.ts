import type { CSSProperties } from 'react';
import { CALLSIGNS } from './constants';
import { seedGradient } from './gradient';

/**
 * Аватар участника — детерминированный градиент по имени (стабилен для одного
 * человека), из общей холодной палитры relay (см. lib/gradient).
 */

/** Приглушённый холодный градиент — фон кружка-аватара. */
export function avatarGradient(name: string): string {
  // Свой суффикс «(вы)» не должен менять цвет — отбрасываем его перед seed.
  const seed = (name || '?').replace(/\s*\(вы\)\s*$/, '').trim() || '?';
  return seedGradient(seed);
}

/** Плоский кружок-аватар (панель юзера, состав, чат). */
export function avatarStyle(name: string): CSSProperties {
  return { background: avatarGradient(name) };
}

/** Случайное имя-подсказка вида «Сокол-42». */
export function randomCallsign(): string {
  const base = CALLSIGNS[Math.floor(Math.random() * CALLSIGNS.length)];
  const num = Math.floor(Math.random() * 90) + 10;
  return `${base}-${num}`;
}
