/**
 * Визуал иконки сервера в рейке. У созданных пользователями серверов нет своей
 * картинки — рисуем эмодзи (если выбрал) или инициалы имени на детерминированном
 * градиенте (цвет стабилен для одного id, как аватарки участников). Главный
 * сервер оформлен отдельно.
 */
import { seedGradient } from './gradient';

/** Приглушённый холодный градиент — фон плашки сервера (см. lib/gradient). */
export function serverGradient(seed: string): string {
  return seedGradient(seed);
}

/** Инициалы из имени: 1–2 значимые буквы для плашки без эмодзи. */
export function serverInitials(name: string): string {
  const words = name
    .replace(/["'«»]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
