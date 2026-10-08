/**
 * Адрес HTTP-ручки api. Обычно api живёт на том же origin за Caddy, и адрес —
 * просто путь; `NEXT_PUBLIC_API_URL` нужен, только когда api вынесен отдельно
 * (см. docs/frontend.md).
 *
 * Переменная читается буквально `process.env.NEXT_PUBLIC_API_URL`: Next
 * подставляет её при сборке по точному имени, и через переменную-ключ она бы
 * не доехала до браузера.
 */
export function apiUrl(path: string): string {
  return `${process.env.NEXT_PUBLIC_API_URL || ''}${path}`;
}
