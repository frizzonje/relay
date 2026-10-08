import { createHmac } from 'node:crypto';
import { SFU_KEY_CONTEXT, readSfuToken, safeEqual, type SfuClaims } from '@relay/shared';

/**
 * Пропуск в медиасервер. Выдаёт api (по сокету, `sfu-token`), проверяет sfu;
 * формат — `readSfuToken` в `@relay/shared`, здесь только ключ и подпись.
 *
 * Смысл разделения: пароль сайта, закрытые серверы и гостевые ссылки живут
 * целиком на стороне api. Медиасервер про них не знает ничего — он проверяет
 * подпись и берёт из клейма комнату, дальше пускает только в неё. Утечка
 * SFU_SECRET даёт доступ к медиа, но не к аккаунтам и не к чату.
 */

function secret(): string {
  return process.env.SFU_SECRET ?? '';
}

export function verifySfuToken(token: unknown): SfuClaims | null {
  // Пустой SFU_SECRET — не «всё можно», а «сервис не настроен»: подписать такой
  // токен смог бы кто угодно, поэтому не пускаем никого.
  if (!secret()) return null;
  const read = readSfuToken(token);
  if (!read) return null;
  const expected = createHmac('sha256', SFU_KEY_CONTEXT + secret())
    .update(read.signed)
    .digest('base64url');
  return safeEqual(expected, read.sig) ? read.payload : null;
}
