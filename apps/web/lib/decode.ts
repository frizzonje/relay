/**
 * `decodeURIComponent`, который не бросает. Адрес и кука приходят снаружи:
 * обрезанная ссылка (`/invite/%E0%A4`) или кука, поправленная руками, бросают
 * `URIError` там, где его никто не ждёт, — в рендере, провайдере сокета,
 * серверной странице. Битая кодировка — это «значения нет», а не авария.
 */
export function decodeOrNull(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}
