import { buildId } from '@/lib/build-id';

/**
 * Какая сборка веба сейчас на сервере. Спрашивает её открытая страница — чтобы
 * заметить, что сервер обновился, а она осталась на старом бандле (см.
 * lib/freshness.ts). Точка в пути уводит запрос мимо гейта паролем
 * (middleware.ts): секрета здесь нет.
 */
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ build: buildId() }, { headers: { 'Cache-Control': 'no-store' } });
}
