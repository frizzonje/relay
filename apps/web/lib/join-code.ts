/**
 * Быстрый вход по коду/ссылке канала. Общая логика лобби (десктоп) и мобильного
 * bottom sheet: из ссылки берём последний непустой сегмент пути, из кода — как
 * есть; слаг — латиница/цифры/дефис в нижнем регистре (как слаги каналов).
 */
export function codeToSlug(raw: string): string {
  let s = raw.trim();
  if (!s) return '';
  try {
    const url = new URL(s);
    const seg = url.pathname.split('/').filter(Boolean).pop();
    if (seg) s = seg;
  } catch {
    // не URL — оставляем как есть
  }
  return s
    .toLowerCase()
    .replace(/[^a-z0-9а-яё-]+/gi, '-')
    .replace(/^-+|-+$/g, '');
}
