'use client';

import { tx as msg } from '@/lib/i18n';

/**
 * Почему устройство не досталось — словами, которые человек может прочитать.
 *
 * Отдельным файлом, потому что спрашивают об этом двое (микрофон и камера), а
 * ответ у них общий: отказ в доступе, занятое устройство и незащищённое
 * соединение выглядят одинаково независимо от того, что именно просили.
 */
export function mediaErrorText(err: unknown): string {
  const e = err as { name?: string; message?: string } | null;
  switch (e?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return msg('media.error.denied');
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return msg('media.error.notFound');
    case 'NotReadableError':
    case 'TrackStartError':
      return msg('media.error.busy');
    case 'OverconstrainedError':
      return msg('media.error.constraints');
    case 'SecurityError':
      return msg('media.error.insecure');
    case 'AbortError':
      return msg('media.error.timeout');
    default:
      return e?.message || msg('media.error.unknown');
  }
}
