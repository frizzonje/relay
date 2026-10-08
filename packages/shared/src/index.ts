// Пропуск-кука и проверка HMAC-токена (подпись завязана на SITE_PASSWORD).
// Единый формат для Next (middleware) и Nest — см. ./auth.
export { AUTH_COOKIE, TOKEN_TTL_MS, issueToken, verifyToken, parseCookies } from './auth';

// Гостевой инвайт-токен: подписанная ссылка на конкретный войс-канал (24 часа),
// без хранения на сервере. Гость по ней попадает только в этот эфир.
export {
  GUEST_TOKEN_TTL_MS,
  issueGuestToken,
  verifyGuestToken,
  type GuestTokenPayload,
} from './auth';

export {
  GUEST_KEY_CONTEXT,
  SFU_KEY_CONTEXT,
  SITE_KEY_CONTEXT,
  guestTokenSigned,
  readGuestToken,
  readSfuToken,
  readSiteToken,
  safeEqual,
  sfuTokenSigned,
  siteTokenSigned,
  type ReadToken,
  type SfuClaims,
} from './auth';

// Личность на ключах: кодирование, отпечаток и текст подписываемого сообщения.
// Считается одним кодом на обеих сторонах — см. ./identity.
export {
  FINGERPRINT_GROUPS,
  NICK_MAX,
  OWNER_TOKEN_BYTES,
  OWNER_TOKEN_CHARS,
  PAIR_CODE_DIGITS,
  PUBLIC_KEY_BYTES,
  SIGNATURE_BYTES,
  SIGN_ALGORITHM,
  authMessage,
  certificateMessage,
  fingerprint,
  formatPairCode,
  fromBase64Url,
  isOwnerToken,
  isPairCode,
  isPublicKey,
  isSignature,
  ownerLink,
  pairLink,
  readOwnerToken,
  readPairCode,
  sanitizeNick,
  toBase64Url,
  type OwnDevice,
  type PairOffer,
} from './identity';

// Каталог настроек инсталляции: один список параметров с типами, границами и
// умолчаниями. По нему сервер проверяет запись, а панель владельца сама рисует
// контролы — см. ./settings.
export * from './settings';
// Адреса и маски сетей — по ним каталог проверяет списки адресов, а api
// сверяет с ними входящих (см. ./net).
export * from './net';

// Машина состояний вызова: чистый переход, по которому владелец живых вызовов
// на сервере и оба экрана — исходящий и входящий — одинаково решают, чем
// кончился дозвон. Считается одним кодом на всех сторонах — см. ./ring.
export {
  missed,
  settled,
  step,
  type MissedState,
  type Ring,
  type RingEvent,
  type RingState,
} from './ring';

// Протокол админ-панели: события владельца, сводка, люди, выгрузка настроек.
// Отдельным файлом, а не здесь, потому что панель — единственная часть
// контракта, которой пользуется один экран из всех, — см. ./admin.
export * from './admin';

// Протокол медиасервера (сокет `/sfu/`) — см. ./sfu.
export * from './sfu';

// Вложения и модерация — свои файлы, потому что их знают не только события:
// виды вложений — каталог настроек, список забаненных — панель.
export * from './attachments';
export * from './moderation';

// Домены контракта — по файлу на каждый.
export * from './common';
export * from './chat';
export * from './dm';
export * from './presence';
export * from './registry';
export * from './http';
export * from './voice';
export * from './call';
export * from './events';
