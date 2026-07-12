import type { ConfigResponse, IceServer } from '@relay/shared';

/**
 * ICE-серверы для WebRTC берём с бэка (`GET /api/config`) — туда подставляются
 * STUN/TURN из окружения. Тянем один раз и кэшируем на сессию.
 */
const FALLBACK: IceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

let cache: IceServer[] | null = null;

export async function getIceServers(): Promise<IceServer[]> {
  if (cache) return cache;
  try {
    const base = process.env.NEXT_PUBLIC_API_URL || '';
    const res = await fetch(`${base}/api/config`, { credentials: 'include' });
    if (!res.ok) throw new Error(`config ${res.status}`);
    const data = (await res.json()) as ConfigResponse;
    cache = data.iceServers?.length ? data.iceServers : FALLBACK;
  } catch (err) {
    console.error('getIceServers failed, using fallback STUN', err);
    cache = FALLBACK;
  }
  return cache;
}
