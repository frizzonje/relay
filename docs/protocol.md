# Протокол клиент ↔ сервер

Спецификация для тех, кто пишет клиента: веб, десктоп-оболочку, iOS, Android.
Сервер не знает, какая у клиента платформа, — все говорят по одному контракту.

**Источник правды — код, а не этот файл.** Типы всех событий и ответов лежат в
[`packages/shared/src/index.ts`](../packages/shared/src/index.ts)
(`ClientToServerEvents`, `ServerToClientEvents`), админка — в
[`admin.ts`](../packages/shared/src/admin.ts), каталог настроек — в
[`settings.ts`](../packages/shared/src/settings.ts). Этот документ объясняет,
что они значат и в каком порядке их слать. Меняете контракт — правьте оба
места в одном коммите. `pnpm docs:check` ([`tools/check-docs.mjs`](../tools/check-docs.mjs))
падает, если событие из `@relay/shared` или `@SubscribeMessage` из гейтвеев
здесь не упомянуто.

Медиа (mesh, SFU, TURN) описаны отдельно — [media.md](media.md).

## Содержание

1. [Транспорты](#1-транспорты)
2. [Пропуска и токены](#2-пропуска-и-токены)
3. [REST](#3-rest)
4. [Socket.io: подключение](#4-socketio-подключение)
5. [Серверы и каналы](#5-серверы-и-каналы)
6. [Текстовые каналы](#6-текстовые-каналы)
7. [Личные сообщения](#7-личные-сообщения)
8. [Присутствие и дозвон](#8-присутствие-и-дозвон)
9. [Голосовые комнаты](#9-голосовые-комнаты)
10. [Гости по приглашению](#10-гости-по-приглашению)
11. [Модерация](#11-модерация)
12. [Личное состояние: прочитанное, настройки, имя](#12-личное-состояние-прочитанное-настройки-имя)
13. [Настройки инсталляции и панель владельца](#13-настройки-инсталляции-и-панель-владельца)
14. [Чек-лист нового клиента](#14-чек-лист-нового-клиента)

---

## 1. Транспорты

Всё за одним origin, TLS терминирует Caddy ([`infra/Caddyfile`](../infra/Caddyfile)):

| Путь | Куда | Что |
|---|---|---|
| `/api/*` | api `:3000` | REST: вход, личность, ICE-конфиг, загрузки, метрики |
| `/socket.io/*` | api `:3000` | Socket.io 4: сигналинг, чат, реестр, присутствие, админка |
| `/uploads/*` | api `:3000` | отдача вложений (за тем же гейтом, что и API) |
| `/sfu/*` | sfu `:3100` | Socket.io медиасервера (только профиль `sfu`) |
| всё остальное | web `:3001` | Next.js |

Socket.io — не голый WebSocket: нужен клиент Socket.IO v4 / Engine.IO v4
(iOS — `socket.io-client-swift`, Android — `socket.io-client-java`).

## 2. Пропуска и токены

В relay два независимых вопроса: «пустить ли на инсталляцию» (пароль) и «кто
это» (ключ устройства). У каждого своя кука.

| Что | Где выдаётся | Формат | Живёт | Код |
|---|---|---|---|---|
| **`relay_pass`** — пропуск на инсталляцию | `POST /api/login` | `<exp>.<HMAC-SHA256>`, ключ `relay-auth-v1:` + пароль (или его scrypt-хэш, если пароль задан из панели) | 30 дней; смена пароля отзывает все | [`auth/auth.ts`](../apps/api/src/auth/auth.ts), web-близнец [`shared/src/auth.ts`](../packages/shared/src/auth.ts) |
| **`relay_id`** — сессия личности | `POST /api/identity/verify` | `<identity>.<device>.<exp>.<HMAC>`, ключ случайный на процесс | `access.sessionTtlDays` (30), **рестарт api отзывает все** — клиент молча проходит вход заново | [`identity/session.ts`](../apps/api/src/identity/session.ts) |
| Гостевая ссылка | `invite-create` | `g2.<b64url(slug)>.<talk\|listen>.<exp>.<HMAC>`, ключ `relay-guest-v1:` + пароль | `invites.ttlHours` (24 ч) | `issueGuestToken` в [`auth/auth.ts`](../apps/api/src/auth/auth.ts) |
| Пропуск на закрытый сервер | `server-create` / `server-unlock` | `u1.<b64url(serverId)>.<exp>.<HMAC>`, подписан хэшем пароля сервера | 30 дней; смена пароля сервера отзывает | `issueUnlockToken` в [`gateway/unlock.ts`](../apps/api/src/gateway/unlock.ts) |
| Пропуск в медиасервер | `sfu-token` | `s1.<b64url(json)>.<HMAC>`, ключ `relay-sfu-v1:` + `SFU_SECRET` | 60 с — только на подключение | [`sfu/sfu-token.ts`](../apps/api/src/sfu/sfu-token.ts) ↔ [`apps/sfu/src/token.ts`](../apps/sfu/src/token.ts) |
| TURN-пара | `GET /api/config` | `username = <exp>:<rand>`, `credential = base64(HMAC-SHA1(TURN_SECRET, username))` (TURN REST API) | `TURN_TTL_SECONDS` (сутки) | [`turn.ts`](../apps/api/src/turn.ts) |

Клиенту все токены непрозрачны: хранить и предъявлять, не разбирать.

### 2.1 Пропуск на инсталляцию

```http
POST /api/login
Content-Type: application/json

{"password": "..."}
```

| Ответ | Когда |
|---|---|
| `2xx {"ok":true}` + `Set-Cookie: relay_pass=…; HttpOnly; SameSite=Lax` | пароль верный (или пароля нет вовсе). Nest отвечает 201 — проверяйте `2xx` |
| `401 {"error":"invalid password"}` | неверный |
| `429 {"error":"too many attempts"}` | `access.unlockAttempts` неудач с IP за 10 минут |
| `429 {"error":"too fast"}` | превышен `access.loginRatePerMinute` (по умолчанию выключено) |

Пароля нет (`SITE_PASSWORD` пуст и в панели не задан) — ворот нет, всё открыто.
`POST /api/logout` стирает куку.

Предъявлять пропуск можно тремя способами, сервер берёт первый непустой
(`extractToken` в [`auth/auth.ts`](../apps/api/src/auth/auth.ts)):

1. `auth.token` в рукопожатии Socket.io;
2. заголовок `Authorization: Bearer <token>` (REST, `/uploads`, рукопожатие);
3. кука `relay_pass`.

Браузер и десктоп-оболочки живут на куке. Нативному клиенту удобнее заголовок.

### 2.2 Личность на ключах

Человек — это Ed25519-ключ, рождённый на устройстве. Регистрации, пароля и
восстановления нет. Общие примитивы — [`shared/src/identity.ts`](../packages/shared/src/identity.ts).

- **Публичный ключ** — 32 байта, base64url без паддинга.
- **Отпечаток** — первые 8 байт SHA-256 от ключа, hex группами по 4:
  `a1b2-c3d4-e5f6-0718` (`fingerprint()`). Им человек адресуется везде в
  протоколе; внутренний id личности наружу не уходит.
- **Ник** — до 20 символов, буквы/цифры/`_`/`-` (`sanitizeNick()`), не уникален.

Вход — челлендж-ответ ([`identity.controller.ts`](../apps/api/src/identity/identity.controller.ts),
[`identity.service.ts`](../apps/api/src/identity/identity.service.ts)). Нужен уже
выданный `relay_pass`:

```
POST /api/identity/challenge {publicKey}                          → {nonce}          (нонс живёт 2 мин)
подписать строку  "relay-auth-v1:<nonce>"  приватным ключом
POST /api/identity/verify    {publicKey, nonce, signature, nick?, deviceName?}
                                                                  → {id, publicKey, fingerprint, nick,
                                                                     device: {id, name}, created}
                                                                    + Set-Cookie: relay_id=…
GET  /api/identity/me                                             → то же | 401 | 403
POST /api/identity/nick      {nick}                               → {nick} | 400 | 429 {retryInMs}
```

Незнакомый ключ на `verify` заводит новую личность (`created: true`), если
владелец не закрыл дверь (`access.identityCreation = closed` → `403 closed`).
Отозванное устройство — `403 revoked`. Остальные отказы — `401`
(`bad-key`, `bad-nonce`, `bad-signature`).

Где лежит приватный ключ, решает клиент. Веб — неизвлекаемый `CryptoKey` в
IndexedDB ([`lib/signer.ts`](../apps/web/lib/signer.ts)). Десктоп — системная
связка ключей в оболочке, подпись через мост событий
([`lib/signer-shell.ts`](../apps/web/lib/signer-shell.ts),
[`identity.rs`](../clients/desktop/src-tauri/src/identity.rs),
[`identity.js`](../clients/desktop-linux/src/identity.js)).

**Сокет узнаёт личность только по куке `relay_id` в заголовке рукопожатия**
(`Perimeter.recognize` → `IdentityService.fromCookie`). Нативный клиент должен
передать `Cookie: relay_id=…` в `extraHeaders`. Без неё сокет работает как
«безличный»: читает, но ЛС, звонки, личное состояние и админка ему недоступны.

### 2.3 Устройства и связка

Второе устройство присоединяется к существующей личности. Код показывает
**новое** устройство, подтверждает **старое** — подсмотренный код никого не
впускает ([`pairing.service.ts`](../apps/api/src/identity/pairing.service.ts),
[`devices.controller.ts`](../apps/api/src/identity/devices.controller.ts)).
Всё — за своей сессией `relay_id`.

```
новое:  POST /api/identity/pair/ask                    → {code, expiresIn}   6 цифр, живёт 3 мин
старое: GET  /api/identity/pair/:code                  → {publicKey, fingerprint, …}
старое: подписать "relay-device-v1:<identityId>:<publicKey нового>"
старое: POST /api/identity/pair/confirm {code, signature} → {ok, deviceId}
```

Новое устройство до связки уже прошло вход и получило свою пустую личность;
при подтверждении она удаляется, устройство переезжает к донору
(`has-history`, если пустая личность успела что-то написать). Код передаётся
ссылкой вида `https://host/#pair=123456` (`pairLink`/`readPairCode`).

`GET /api/identity/devices` — свои устройства, `POST /api/identity/devices/revoke {deviceId}` —
отозвать (не текущее: `409 current`). Живые сокеты отозванного рвутся сразу.

### 2.4 Владелец инсталляции

Ровно одна личность — владелец. Власть берётся одноразовой ссылкой, которую
печатает машина: `relay owner-link` или `node dist/owner-link.js` в контейнере api
([`owner-link.ts`](../apps/api/src/owner-link.ts)).

```
https://host/#owner=<43 символа base64url>
POST /api/identity/owner/claim {token}   → {ok} | 400 bad | 409 used | 410 expired
GET  /api/identity/owner                 → {owner: boolean}
```

Новый владелец вытесняет прежнего; права живых сокетов пересчитываются сразу
([`owner.service.ts`](../apps/api/src/identity/owner.service.ts)).

## 3. REST

Все маршруты, кроме `/api/login` и `/api/health`, за гейтом `authGate`
([`http-gate.ts`](../apps/api/src/http-gate.ts)): без пропуска — `401`, с
адреса из `access.blockedAddresses` — `403 {"error":"blocked"}` (владельца
маска не запирает).

| Метод и путь | Контроллер | Что |
|---|---|---|
| `POST /api/login`, `POST /api/logout` | [`auth.controller.ts`](../apps/api/src/auth/auth.controller.ts) | §2.1 |
| `POST /api/identity/challenge`, `/verify`, `GET /me`, `POST /nick` | [`identity.controller.ts`](../apps/api/src/identity/identity.controller.ts) | §2.2 |
| `GET /api/identity/devices`, `POST /devices/revoke`, `/pair/*` | [`devices.controller.ts`](../apps/api/src/identity/devices.controller.ts) | §2.3 |
| `GET /api/identity/owner`, `POST /owner/claim` | [`owner.controller.ts`](../apps/api/src/identity/owner.controller.ts) | §2.4 |
| `GET /api/config` | [`config.controller.ts`](../apps/api/src/config.controller.ts) | ICE и сводка, ниже |
| `POST /api/upload` | [`upload.controller.ts`](../apps/api/src/upload.controller.ts) | загрузка вложения, ниже |
| `GET /api/metrics` | [`metrics.controller.ts`](../apps/api/src/metrics.controller.ts) | нагрузка хоста, ниже |
| `GET /api/health` | [`health.controller.ts`](../apps/api/src/health.controller.ts) | `{ok:true}`, без пропуска — для healthcheck |

### GET /api/config

Тип — `ConfigResponse`. Гостю отвечает и по `Authorization: Bearer <гостевой токен>`,
иначе за строгим NAT он остался бы без TURN.

```json
{
  "iceServers": [
    { "urls": ["stun:host:3478", "stun:stun.l.google.com:19302"] },
    { "urls": ["turn:host:3478?transport=udp", "turns:host:5349?transport=tcp"],
      "username": "1755820800:9f3c1a2b", "credential": "…" }
  ],
  "iceExpiresAt": 1755820800,
  "sfu": { "available": true },
  "retentionDays": 14,
  "retentionMode": "days",
  "version": "2.0.1",
  "settings": { "…": "тот же снимок, что в событии settings" }
}
```

Откуда берутся ICE-серверы: `STUN_URLS`/`TURN_URLS`, если заданы; иначе свой
coturn на `SERVER_HOST` (если есть `TURN_SECRET` или статическая пара) плюс
публичный STUN Google. `iceExpiresAt` (секунды Unix) — когда TURN-пара
протухнет; после этого конфиг надо перезапросить.

### POST /api/upload

`multipart/form-data`, поле `file`. Ответ — `UploadResponse`:

```json
{ "id": "3f9a…c1.png", "url": "/uploads/3f9a…c1.png", "name": "photo.png",
  "size": 123456, "mime": "image/png", "kind": "image" }
```

`id` — одноразовый талон для `chat-message { uploadId }`: url и mime клиент не
задаёт, сервер подставляет свои. `kind` (`image` | `audio` | `file`) —
подсказка для рендера. Файл, который так и не прикрепили, удаляется через
`files.orphanSweepHours`.

| Отказ | Код |
|---|---|
| загрузки выключены (`files.uploadsEnabled`) | 403 |
| больше `files.maxUploadBytes` (жёсткий потолок 25 МБ, `MAX_UPLOAD_BYTES`) или дневная квота личности | 413 |
| вид не разрешён (`files.allowedKinds`) или исполняемый файл | 415 |
| бюджет байтов на IP (гард до записи на диск) | 429 |

Код — [`uploads.ts`](../apps/api/src/uploads.ts), [`upload.guard.ts`](../apps/api/src/upload.guard.ts).
Файлы отдаются с `/uploads/<id>`: картинки и mp3 инлайн, остальное —
`Content-Disposition: attachment`, всегда `nosniff`.

### GET /api/metrics

Нагрузка **хоста** (не контейнера): `MetricsResponse`
`{cpu: {cores, usage, load1}, mem: {total, used}, disk, uptimeSec}`.
`null` — «не измерено», рисовать прочерком, не нулём. Сервер снимает раз в 2 с,
чаще спрашивать незачем ([`metrics.ts`](../apps/api/src/metrics.ts)).

## 4. Socket.io: подключение

Гейтвей — [`signaling.gateway.ts`](../apps/api/src/gateway/signaling.gateway.ts).
Он только принимает сокет и раздаёт события обработчикам в `gateway/*.handlers.ts`.

### 4.1 Рукопожатие

Поле `auth` (web — [`lib/socket.ts`](../apps/web/lib/socket.ts)):

| Поле | Обязательно | Что |
|---|---|---|
| `protocol` | **да** | `PROTOCOL_VERSION` из shared, сейчас `1`. Поднимается только с мажором |
| `clientId` | нет | стабильный id устройства (web — localStorage). Нужен, чтобы сервер выгонял «призрака» — прошлый сокет того же устройства после перезагрузки — и считал, какие записи реестра «твои» |
| `token` | нет | `relay_pass`, если не кукой и не заголовком (§2.1) |
| `guest` | нет | гостевой токен — вместо пропуска (§10) |
| `unlock` | нет | массив пропусков на закрытые серверы (§5) |

Заголовки: `Cookie: relay_pass=…; relay_id=…` или `Authorization: Bearer …`.

### 4.2 Отказы

До `connect` сервер может отказать ошибкой рукопожатия. Клиент получает её в
`connect_error` с `err.message`:

| `message` | Что делать |
|---|---|
| `client-outdated` | клиент старше сервера или не прислал `protocol` — «обновите приложение» |
| `server-outdated` | сервер старше клиента |
| `banned` | личность забанена на всю инсталляцию |
| `blocked` | адрес попал под `access.blockedAddresses` |
| `maintenance` | режим обслуживания; `err.data.message` — текст владельца, если задан |

Нет валидного пропуска (и нет гостевого токена) — сокет принимается и сразу же
закрывается сервером (`disconnect` с `io server disconnect`). Для клиента это
значит «пропуск протух → на логин».

### 4.3 Что приходит сразу после входа

| Кому | События по порядку |
|---|---|
| участник | `settings` → `servers` → `channels` → `voice-presence` → `presence` (если есть личность) → `reads`, `prefs`, `mentions` (если есть личность) |
| гость по ссылке | `settings` → `voice-presence` (только своя комната) |

Все снимки полные: клиент замещает своё состояние, а не сливает.

### 4.4 Обрыв и восстановление

- Включён `connectionStateRecovery` на 20 с: короткий обрыв возвращает тот же
  `socket.id` и комнаты, пропущенные события доезжают.
- Уход из голосовой комнаты откладывается на 24 с (`VoiceSessions.LEAVE_GRACE_MS`),
  чтобы моргание сети не выкидывало из разговора.
- Если после реконнекта `socket.id` сменился — сессия не восстановилась: заново
  `join` / `chat-join` / `dm-join`.
- `socket.id` — id участника в голосовом сигналинге.

### 4.5 Общие правила

- **Ack.** Событие с колбэком отвечает объектом `{ ok: true, … }` либо
  `{ ok: false, error }`. События без колбэка отказывают молча или отдельным
  событием (`chat-refused`, `voice-refused`, `voice-locked`, `kicked`).
- **Лимитер.** Каждое событие, кроме `offer`/`answer`/`ice-candidate`, тратит
  токен из ведра сокета: 40 в запасе, 20/с (`RL_CAPACITY`, `RL_REFILL_PER_SEC` в
  [`perimeter.ts`](../apps/api/src/gateway/perimeter.ts)). Пустое ведро — событие
  молча отбрасывается. У реплик отдельное ведро (`moderation.messageBurst` /
  `moderation.messageRatePerMinute`), у `voice-diag` — своё.
- **Входные данные.** Всё, что прислал клиент, сервер считает `unknown`, режет по
  длине (`LIMIT` в [`gateway/protocol.ts`](../apps/api/src/gateway/protocol.ts)) и
  проверяет. Лишние поля игнорируются.

## 5. Серверы и каналы

«Сервер» — группа каналов (как в Discord). Реестр общий на инсталляцию, живёт в
Postgres и в памяти api ([`registry.service.ts`](../apps/api/src/gateway/registry.service.ts)),
видимость считается под каждый сокет ([`directory.ts`](../apps/api/src/gateway/directory.ts)).
Обработчики — [`registry.handlers.ts`](../apps/api/src/gateway/registry.handlers.ts).

**`Server`** `{ id, name, emoji?, removable, locked?, unlocked?, mine?, moderated? }`

- `locked` — сервер под паролем: виден в рейке, каналы приходят только после
  пароля; `unlocked` — этот сокет пароль уже предъявил;
- `mine` — этой записью управляешь ты: её создала твоя личность (или, у записей
  без личности, это устройство по `clientId`), либо у неё нет создателя вовсе.
  Кнопки «переименовать / удалить / сменить режим» рисовать по нему
  ([`ownership.ts`](../apps/api/src/gateway/ownership.ts), `ownedBy`);
- `moderated` — ты модератор этого сервера (§11). Не то же, что `mine`: у
  главного сервера создателя нет, управлять реестром там может каждый, а
  модерировать — только владелец инсталляции.

**`Channel`** `{ id, serverId, type: 'text'|'voice', name, slug, removable, mode?, mine?, lastTs? }`

- `slug` уникален на инсталляцию и служит именем комнаты: текстовый канал —
  комната `chat:<slug>`, голосовой — `<slug>`;
- `mode` — только у голосовых: `p2p` или `sfu` (§9);
- `lastTs` — время последней реплики текстового, для точки «непрочитано».

| Направление | Событие | Payload → ack | Примечание |
|---|---|---|---|
| S→C | `servers` | `Server[]` | снимок при входе и при каждом изменении |
| S→C | `channels` | `Channel[]` | только видимые этому сокету |
| C→S | `server-create` | `{id, name, emoji?, password?}` → `ServerCreateResult` | `id` генерирует клиент (UUID). С паролем в ack приезжает `token` — пропуск на этот сервер |
| C→S | `server-unlock` | `{id, password}` | ответ — событие ниже |
| S→C | `server-unlock-result` | `{id, ok, token?}` | при `ok` перед ним уже пришли свежие `channels` и `voice-presence` |
| C→S | `server-delete` | `{id}` → `ServerDeleteResult` | |
| C→S | `server-stats` | `{id}` → `{ok, channels, messages, occupants}` | «что пропадёт при удалении», только для `mine` |
| C→S | `channel-create` | `{serverId, type, name, mode?}` → `{ok, slug}` | в главном сервере нельзя |
| C→S | `channel-rename` | `{id, name}` → `ChannelRenameResult` | slug не меняется |
| C→S | `channel-delete` | `{id}` → `ChannelDeleteResult` | |
| C→S | `channel-stats` | `{id}` → `{ok, occupants, messages}` | |
| C→S | `channel-mode` | `{id, mode}` | без ack; сидящим в канале уходит `voice-mode` (§9) |

Отказы в ack: `not-found`, `forbidden` (закрыт паролем, неудаляемая запись,
запрещено настройкой), `not-owner` (создано другим устройством), `bad-name`,
`exists`, `occupied` + `occupants` (в голосовом сидят люди), `limit` + `scope`
(`person` | `server` | `install`) + `limit`.

**Пропуска на закрытые серверы.** Токен из `server-create`/`server-unlock-result`
клиент хранит (web — [`lib/unlock-tokens.ts`](../apps/web/lib/unlock-tokens.ts)) и
шлёт массивом в `auth.unlock` при каждом подключении — так перезагрузка не
спрашивает пароль снова. Битые и просроченные сервер молча пропускает. Перебор
пароля ограничен `access.unlockAttempts` / `access.unlockLockoutMinutes`
([`unlock.ts`](../apps/api/src/gateway/unlock.ts)).

## 6. Текстовые каналы

Хранилище — [`chat.service.ts`](../apps/api/src/gateway/chat.service.ts) (Postgres,
таблица `messages`), обработчики — [`chat.handlers.ts`](../apps/api/src/gateway/chat.handlers.ts),
кто в какой ленте — [`chat-sessions.ts`](../apps/api/src/gateway/chat-sessions.ts).
Сокет сидит максимум в одной ленте. Гостю по ссылке чат недоступен.

**`ChatMessage`**
`{ id?, name?, fingerprint?, text, ts, attachment?, system?, call?, reactions?, replyTo?, editedTs?, mentions?, pinned? }`

- `ts` — мс Unix, время сервера; `(ts, id)` — курсор ленты;
- `fingerprint` — автор; пусто у сообщений до 1.0 и у безличных клиентов;
- `system: true` — служебная строка, рисуется иначе;
- `call` — отметка о пропущенном звонке (§8.3);
- `reactions` — `{ emoji: {fingerprint?, nick}[] }`, набор эмодзи закрыт: `REACTION_EMOJIS`;
- `replyTo` — снимок цитаты на момент ответа `{id, name, text}`;
- `mentions` — `{fingerprint, nick}[]`, кого назвали.

| Направление | Событие | Payload → ack | Примечание |
|---|---|---|---|
| C→S | `chat-join` | `{room: slug, name?}` | войти в ленту; несуществующий канал → `chat-closed` |
| C→S | `chat-leave` | — | |
| S→C | `chat-history` | `ChatHistoryPage` `{slug, messages, more, pins?}` | первая страница (`CHAT_PAGE_SIZE` = 50) сразу после входа |
| C→S | `chat-history-more` | `{beforeTs, beforeId}` → `{ok, messages, more}` | страница вверх |
| C→S | `chat-history-after` | `{afterTs, afterId}` → `{ok, messages, more, moreAfter}` | страница вниз (после прыжка) |
| C→S | `chat-around` | `{id}` → то же | окно вокруг сообщения — открыть результат поиска |
| C→S | `chat-search` | `{query, scope: 'channel'\|'server', beforeTs?, beforeId?}` → `{ok, hits, more, terms}` | полнотекст по префиксам слов |
| S→C | `chat-roster` | `{nick, fingerprint?}[]` | кто сейчас в ленте |
| C→S | `chat-message` | `{text?, uploadId?, replyTo?, spoiler?, mentions?}` | `mentions` — отпечатки из пикера |
| S→C | `chat` | `ChatMessage` | новая реплика — всем в ленте, включая автора |
| C→S | `chat-edit` | `{id, text, mentions?}` | только своё |
| S→C | `chat-edited` | `{id, text, editedTs, mentions?}` | |
| C→S | `chat-delete` | `{id}` | своё или как модератор |
| S→C | `chat-deleted` | `{id}` | |
| C→S | `chat-react` | `{id, emoji}` | повторная отправка снимает |
| S→C | `chat-reaction` | `{id, reactions}` | новый набор целиком |
| C→S | `chat-typing` | — | имя сервер берёт с сокета |
| S→C | `chat-typing` | `{name}` | себе не приходит |
| C→S | `chat-pin` | `{id, on}` → `{ok, pinned, count}` | только модератор; `limit` сверх `messages.pinLimit` (50) |
| C→S | `chat-pins` | `{slug}` → `{ok, slug, pins}` | закреплённые текущей ленты |
| S→C | `chat-pinned` | `{id, pinned, count}` | |
| C→S | `mention-suggest` | `{prefix?}` → `{ok, people: {fingerprint, nick, online}[]}` | подсказки для `@` |
| S→C | `chat-activity` | `{slug, ts}` | «в канале написали» — всем, кому канал виден, без содержимого |
| S→C | `chat-refused` | `{reason: ChatRefusal}` | отказ; реплика не сохранена |
| S→C | `chat-closed` | `{slug, reason?, notice?}` | канал удалён или тебя забанили на сервере — закрой ленту |

`ChatRefusal`: `read-only`, `rate`, `banned-word`, `links-off`,
`attachments-off`, `edit-off`, `edit-window`, `delete-off`, `reactions-off`,
`search-off`, `too-new`, `spoiler-off` — каждая соответствует настройке группы
`moderation` / `messages` / `files` / `access`.

**Ретенция.** Сообщения старше `messages.retentionDays` (по умолчанию 14)
удаляются раз в час вместе с вложениями; закреплённые — нет
([`retention.service.ts`](../apps/api/src/db/retention.service.ts),
[`retention.policy.ts`](../apps/api/src/db/retention.policy.ts)).

## 7. Личные сообщения

Беседа двух личностей — это та же лента, только без сервера над ней и без
строки в реестре. Адрес — `dm-` + 24 hex от SHA-256 пары id
(`DmService.address` в [`dm.service.ts`](../apps/api/src/gateway/dm.service.ts));
клиент его не вычисляет, а получает. Реплики, история, реакции, правка, удаление
и поиск идут обычными `chat-*` событиями из §6. Закреплять в ЛС нельзя.

Нужна личность. Гостю и безличному сокету всё ниже отвечает `forbidden`.

| Направление | Событие | Payload → ack | Примечание |
|---|---|---|---|
| C→S | `dm-open` | `{fingerprint}` → `{ok, conversation}` | открыть или найти беседу. Отказы: `unknown`, `self`, `forbidden` |
| C→S | `dm-list` | → `{ok, conversations: DmConversation[]}` | мои беседы |
| C→S | `dm-join` | `{slug}` → `{ok}` | сесть в ленту беседы (вместо `chat-join`), следом `chat-history`. Отказы: `unknown`, `forbidden` |
| C→S | `dm-people` | `{query?}` → `{ok, people: {fingerprint, nick, lastSeenTs}[]}` | кому можно написать (до `DM_PEOPLE_LIMIT` = 30) |
| S→C | `dm-activity` | `DmActivityRelay` `{slug, ts, preview, previewMine, peer, call?}` | в беседе написали — только двоим участникам |

`DmConversation` `{slug, peer: {fingerprint, nick}, lastTs, preview, previewMine, call?}`.
`preview` обрезан до `messages.replyPreviewLength`. Если `call` заполнено, в
`preview` лежит непереведённая строка сервера — клиент рисует своё слово по полю
`call` (web — `callMarkLabel` в [`MissedCallMark.tsx`](../apps/web/components/call/MissedCallMark.tsx)).

Правила — группа настроек `direct`: `direct.enabled`, `direct.whoCanStart`,
`direct.firstMessagesPerHour`, `direct.blockFromBanned`,
`direct.attachmentsAllowed` ([`dm.handlers.ts`](../apps/api/src/gateway/dm.handlers.ts)).

Переписка хранится на сервере открытым текстом, как и каналы. Сквозного
шифрования нет.

## 8. Присутствие и дозвон

### 8.1 Присутствие личности

«Кто сейчас на связи» — на всю инсталляцию, по личностям, а не по сокетам
([`presence.ts`](../apps/api/src/gateway/presence.ts)). Не путать с
`voice-presence` (§9) — тот про состав комнат.

| Направление | Событие | Payload |
|---|---|---|
| S→C | `presence` | `PresenceEntry[]` — снимок при входе |
| S→C | `presence-update` | `PresenceEntry[]` — только изменившиеся, пачкой раз в 80 мс |

`PresenceEntry` `{fingerprint, state, since}`, `state`:
`online` (открыт хотя бы один клиент) · `in-voice` (сидит в голосовом с любого
устройства) · `recent` (ушёл меньше 2 минут назад) · `offline` (приходит только
дельтой — в снимке «нет записи» и значит offline).

### 8.2 Дозвон

Звонок человеку, а не вход в комнату. Логика — [`ring.ts`](../apps/api/src/gateway/ring.ts)
и [`ring.handlers.ts`](../apps/api/src/gateway/ring.handlers.ts); переходы
состояний — общая чистая машина [`shared/src/ring.ts`](../packages/shared/src/ring.ts),
по ней считают и сервер, и оба экрана клиента.

| Направление | Событие | Payload → ack | Кто |
|---|---|---|---|
| C→S | `call-start` | `{fingerprint, video?}` → `{ok, ringId}` | звонящий |
| C→S | `call-accept` | `{ringId}` → `{ok}` | вызываемый |
| C→S | `call-decline` | `{ringId}` → `{ok}` | вызываемый |
| C→S | `call-cancel` | `{ringId}` → `{ok}` | звонящий |
| S→C | `call-incoming` | `{ringId, from, at, video}` | всем устройствам вызываемого |
| S→C | `call-state` | `{ringId, state, peer, at, video, room?}` | `ringing` — устройствам звонящего; `accepted` — обоим, с `room` |
| S→C | `call-ended` | `{ringId, state, peer, at, missed}` | вызов кончился, не став разговором |
| S→C | `call-over` | `{room}` | разговор кончился: собеседник ушёл или не пришёл |

`from` / `peer` — `{fingerprint, nick}`, всегда «другая сторона» глазами
получателя.

Отказы `call-start` (`CallRefusal`): `disabled` (`calls.enabled`), `forbidden`
(`calls.whoCanCall`, звонок себе, гость, нет личности), `offline` (у собеседника
нет живых устройств), `busy` (он уже в вызове или, при `calls.busyWhenInVoice`,
в голосовом), `rate` (`calls.maxRingsPerHour`). `call-accept`/`-decline`/`-cancel`
отвечают `{ok:false, error:'unknown'}` на любой несуществующий или чужой вызов —
обычно это проигранная гонка.

Исходы `call-ended.state`: `declined`, `no-answer` (истёк `calls.ringTimeoutSeconds`),
`cancelled`, `failed` (у собеседника закрылось последнее устройство). `busy`
в типе есть, но сейчас не приходит — занятость отвечается отказом `call-start`.
Каждый вызов кончается ровно одним: `call-state{accepted}` или `call-ended`.

Правила: одна личность — не больше одного живого вызова; ответ с одного
устройства гасит входящий на остальных; видеозвонок при выключенном
`calls.videoAllowed` становится голосовым.

### 8.3 Разговор после ответа

`call-state{accepted}` приносит `room` = `voice:<адрес беседы>` (`callRoomOf`).
В комнату входит **то устройство, которое звонило или ответило**, обычным `join`
(§9). Сервер держит у такой комнаты четыре правила
([`voice-sessions.ts`](../apps/api/src/gateway/voice-sessions.ts), `openCallRoom`):

- войти могут только двое из вызова, остальным — `voice-refused{not-in-call}`;
- уход любого кончает разговор: второму приходит `call-over` (грейс тот же, 24 с);
- если второй не вошёл за 30 с (`CALL_ROOM_SEAT_MS`) — `call-over`;
- транспорт всегда `p2p`, `sfu-token` отвечает `not-sfu`.

Клиент, получивший `voice-refused{not-in-call}`, обязан завершить звонок у себя
и сказать человеку, что разговор не состоялся.

**Пропущенный звонок** (`no-answer`, `failed` при `calls.missedMarkEnabled`,
тогда `missed: true`) оставляет в беседе строку `ChatMessage` с
`system: true` и `call: {state, ms}` от имени звонившего; обоим уходит
`dm-activity`. Рисовать её плашкой «перезвонить», а не текстом.

Ограничение: входящий доходит, только пока у человека открыт клиент. Пушей нет.

## 9. Голосовые комнаты

Обработчики — [`voice.handlers.ts`](../apps/api/src/gateway/voice.handlers.ts),
состояние (комната, транспорт, мут, грейс, призраки) —
[`voice-sessions.ts`](../apps/api/src/gateway/voice-sessions.ts). Сокет сидит
максимум в одной комнате.

### 9.1 Вход и выбор транспорта

У голосового канала есть `mode`. Перед `join` клиент спрашивает пропуск:

```
C→S sfu-token {room, name?} → ack
     {ok:true, token, exp, url}   → канал sfu, медиасервер жив: подключиться к нему (media.md)
     {ok:false, error:'not-sfu'}  → канал p2p (или SFU не настроен вовсе): mesh
     {ok:false, error:'unavailable'} → канал sfu, медиасервер лежит: ждать и повторять
     {ok:false, error:'forbidden' | 'not-in-room'}
C→S join {room, name?, clientId?, transport: 'p2p'|'sfu'}
```

С 2.0.1 sfu-канал не откатывается на mesh: пока медиасервер недоступен, клиент
сидит в комнате без медиа и повторяет `sfu-token` с растущей паузой
(web — `requestRoute` / `enterRoom` в [`lib/voice.ts`](../apps/web/lib/voice.ts)).
Инсталляция без `SFU_URL`/`SFU_SECRET` отвечает `not-sfu` на любой канал.

`transport` в `join` — чем клиент реально звонит; сервер пишет его в
`voice-presence`, чтобы соседи видели, кто через что. Разные транспорты в одной
комнате друг друга не слышат — сервер логирует такое расщепление.

### 9.2 События

| Направление | Событие | Payload | Примечание |
|---|---|---|---|
| C→S | `join` | `JoinPayload` `{room, name?, clientId?, transport?}` | |
| S→C | `peers` | `VoicePeer[]` | кто уже в комнате — ответ на `join` |
| S→C | `peer-joined` | `{id, name?, fingerprint?, guest?, listen?}` | остальным |
| S→C | `peer-left` | `{id}` | |
| C→S | `leave` | — | |
| C→S / S→C | `offer`, `answer` | `{to, sdp}` / `{from, name?, sdp}` | только mesh; ретранслируется адресату в той же комнате |
| C→S / S→C | `ice-candidate` | `{to, candidate}` / `{from, candidate}` | то же |
| C→S | `media-update` | `{camOn, screenOn, micOn?, deafened?}` | слать после `join` и при каждом изменении |
| S→C | `media-update` | то же + `from` | соседям по комнате |
| S→C | `voice-presence` | `Record<room, VoicePeer[]>` | состав всех видимых комнат, при каждом изменении (раз в 80 мс) |
| S→C | `voice-mode` | `{room, mode}` | канал переключили на другой транспорт — перезайти |
| S→C | `voice-refused` | `{reason: VoiceRefusal}` | `video-off`, `screen-share-off`, `room-full`, `guests-full`, `not-in-call` |
| S→C | `voice-locked` | `{room}` | комната закрытого сервера, пароль не предъявлен |
| C→S | `voice-diag` | `{event, detail?}` | веха звонка в серверный лог; логики нет, своё ведро лимитера |

**`VoicePeer`** `{id, name?, fingerprint?, micOn?, deafened?, guest?, listen?, transport?}`.
Нет `micOn` — считать включённым. `id` — `socket.id`.

Сервер не заглядывает в SDP и ICE: `relay()` лишь проверяет, что адресат в
той же комнате. Правила переговоров (кто шлёт offer, кто уступает при коллизии,
восстановление) — в [media.md](media.md).

Ограничения из настроек: `spaces.maxVoiceOccupants` → `room-full`,
`voice.videoEnabled` / `voice.screenShareEnabled` → камера/экран вырезаются из
`media-update` с отказом.

## 10. Гости по приглашению

Ссылка в один голосовой канал без пароля инсталляции и без личности
([`guests.handlers.ts`](../apps/api/src/gateway/guests.handlers.ts)).

| Направление | Событие | Payload → ack | Примечание |
|---|---|---|---|
| C→S | `invite-create` | `{room}` → `{ok, token, exp, listen}` | ссылка `https://host/invite/<token>`. Отказы: `not-found`, `forbidden` (`invites.enabled`, `invites.whoCanInvite`) |
| C→S | `guest-kick` | `{id: socketId}` → `{ok}` | выгнать гостя из комнаты, где сидишь сам |
| S→C | `kicked` | `{room}` | гостя выгнали или приглашения выключены |

Гость подключается с `auth.guest = <token>` вместо пропуска. Он видит только
`settings` и `voice-presence` своей комнаты, может `join` только в неё, может
брать `sfu-token` и `GET /api/config` (по Bearer). Реестр, чат, ЛС, присутствие,
звонки — нет. `listen: true` — только слушать: ставится на каналы закрытых
серверов и при `invites.listenerByDefault`; медиасервер откажет такому в `produce`.
Лимит гостей на канал — `invites.maxGuestsPerChannel` → `guests-full`.

## 11. Модерация

Модератор сервера — личность, которая его создала, и владелец инсталляции
(`moderatedBy` в [`ownership.ts`](../apps/api/src/gateway/ownership.ts)). Модератор
удаляет чужие сообщения и закрепляет; банить создатель сервера может, пока
включено `moderation.serverOwnersCanBan`. Бан на всю инсталляцию — только владелец.
Код — [`moderation.handlers.ts`](../apps/api/src/gateway/moderation.handlers.ts),
[`moderation.ts`](../apps/api/src/gateway/moderation.ts),
[`roles.service.ts`](../apps/api/src/identity/roles.service.ts).

| Направление | Событие | Payload → ack | Примечание |
|---|---|---|---|
| C→S | `moderation-ban` | `{id: messageId, everywhere?}` → `ModerationResult` | забанить автора сообщения на этом сервере или (`everywhere`) везде |
| C→S | `moderation-unban` | `{fingerprint, server?}` → `ModerationResult` | без `server` — снять бан на инсталляцию |
| C→S | `moderation-bans` | `{server?}` → `{ok, bans: BanEntry[]}` | |
| S→C | `banned` | `{notice?}` \| — | тебя забанили на инсталляции; сокет следом рвётся |

Бан на сервере выводит человека из его лент (`chat-closed{reason:'banned'}`) и
комнат, сервер пропадает из `servers`. Удалять чужие сообщения модератор может
через обычный `chat-delete`.

## 12. Личное состояние: прочитанное, настройки, имя

Состояние, которое принадлежит человеку и синхронизируется между его
устройствами ([`personal.handlers.ts`](../apps/api/src/gateway/personal.handlers.ts),
[`reads.service.ts`](../apps/api/src/identity/reads.service.ts),
[`prefs.service.ts`](../apps/api/src/identity/prefs.service.ts),
[`mentions.ts`](../apps/api/src/gateway/mentions.ts)). Только с личностью.

| Направление | Событие | Payload | Примечание |
|---|---|---|---|
| C→S | `read-mark` | `{slug, ts}` | канал (или беседа) дочитан до `ts` серверного времени. Отметка только растёт |
| S→C | `reads` | `{marks: {slug: ts}, full?}` | `full` — полный снимок при входе; иначе дельта с другого устройства |
| C→S | `prefs-set` | `{key: 'sound'\|'volume', value}` | звук канала, громкость собеседника |
| S→C | `prefs` | `{values, full?}` | так же |
| S→C | `mentions` | `{counts: {slug: n}}` | сколько раз назвали после отметки чтения — снимок при входе |
| S→C | `mention` | `{slug, ts}` | тебя только что назвали |
| C→S | `rename` | `{name}` | см. ниже |
| S→C | `peer-renamed` | `{id, name}` | сосед по голосовой комнате сменил имя |
| S→C | `renamed` | `{name}` | ты сменил имя с другого устройства |

**Имя.** У личности ник меняется через `POST /api/identity/nick`, после чего
клиент шлёт `rename` — сервер перечитывает ник из базы (тело игнорирует) и
обновляет все сокеты личности: ростеры, presence, `renamed` остальным
устройствам. У безличного сокета `rename {name}` просто меняет подпись.

## 13. Настройки инсталляции и панель владельца

### 13.1 Снимок настроек

S→C `settings` — `SettingsSnapshot` `Record<key, value>`: при входе и при каждом
изменении, всем одинаково. В него попадают только параметры с флагом `client`
в каталоге ([`shared/src/settings.ts`](../packages/shared/src/settings.ts)), секретов
нет. Клиент берёт отсюда пределы (длина реплики, размер файла), умолчания звука,
битрейты, включённость функций.

Каталог — единый список параметров (`SETTINGS`, группы `SETTING_GROUPS`) с типом,
границами, умолчанием и тем, когда правка вступает в силу. По нему сервер
проверяет запись ([`settings.service.ts`](../apps/api/src/settings/settings.service.ts)),
а панель сама рисует поля.

### 13.2 Панель владельца

Все события — с ack и только для владельца; любому другому
`{ok:false, error:'forbidden'}`. Типы — [`shared/src/admin.ts`](../packages/shared/src/admin.ts),
обработчики — [`admin.handlers.ts`](../apps/api/src/gateway/admin.handlers.ts).

| Событие | Payload → ack | Что |
|---|---|---|
| `admin-state` | → `{ok, catalog, values, overview}` | каталог, текущие значения, сводка |
| `admin-set` | `{key, value, confirm?}` → `{ok, key, changed, value}` | записать один параметр |
| `admin-reset` | `{group, confirm: true}` → `{ok, group, changed, values}` | вернуть группу к умолчаниям |
| `admin-people` | `{query?, cursor?}` → `{ok, people, cursor?}` | люди, их устройства, баны |
| `admin-bans` | → `{ok, bans}` | баны на инсталляцию |
| `admin-audit` | `{cursor?}` → `{ok, entries, more}` | журнал изменений, свежие сверху |
| `admin-action` | `{action, target?, confirm?, values?}` → `AdminActionResult` | действия, ниже |
| `admin-password` | `{password, confirm: true}` → `{ok, set, changed, count}` | сменить или снять пароль инсталляции |
| `admin-changed` (S→C) | `{keys, values}` | параметры поменяли из другой сессии владельца |

`values` у секретов — `true`/`false` («задано / нет»), самого значения клиент не
получает никогда. Параметр с `danger: true` без `confirm: true` не пишется.
`readOnly` — живёт в `.env`, панель только показывает.

Отказы (`AdminRefusal`): `forbidden`, `needs-confirm`, `unknown-key`, `read-only`,
`wrong-type`, `out-of-range`, `not-an-option`, `too-long`, `bad-item`,
`secret-path` (пароль пишется только через `admin-password`), `not-found`,
`unsupported`.

`admin-action.action` (`AdminAction`):

| Действие | Что делает | В ответе |
|---|---|---|
| `owner-link` | новая ссылка владельца, прежняя умирает | `link: {token, expiresAt}` |
| `retention-run` | прогнать ретенцию сейчас | `count` удалённых |
| `files-sweep` | удалить осиротевшие вложения | `count` |
| `revoke-sessions` | обесценить все сессии `relay_id` (кроме сокета нажавшего) | `count` оборванных сокетов |
| `revoke-device` | отозвать устройство (`target` — id; не своё текущее) | `count` |
| `ban` / `unban` | бан на инсталляцию (`target` — отпечаток) | — |
| `export` | выгрузить настройки без секретов и `readOnly` | `settings` |
| `import` | применить `values` | `imported: {applied, rejected: {key, reason}[]}` |

`admin-password` со `password: ''` снимает пароль из панели — инсталляция
возвращается к `SITE_PASSWORD` из окружения (если он есть). Смена пароля отзывает
все `relay_pass`, гостевые ссылки и сессии и рвёт все сокеты, кроме своего.

## 14. Чек-лист нового клиента

1. `POST /api/login` → сохранить `relay_pass` (Keychain / Keystore).
2. Сгенерировать Ed25519-пару, хранить приватную половину в защищённом
   хранилище → `challenge` → подписать `relay-auth-v1:<nonce>` → `verify` →
   сохранить `relay_id`. На `401` от `/me` или после рестарта api — повторить молча.
3. Socket.io на `/socket.io` с `auth: {protocol: 1, clientId}` и заголовком
   `Cookie: relay_pass=…; relay_id=…`. Обработать `connect_error` (§4.2) и
   немедленный `disconnect` (пропуск протух → логин).
4. Принять снимки §4.3, нарисовать серверы/каналы.
5. Чат: `chat-join` → `chat-history` → `chat-message` / `chat-react`, подгрузка
   `chat-history-more`.
6. Звонок: `GET /api/config` → `sfu-token` → `join` с правильным `transport` →
   mesh по [media.md](media.md) (или SFU) → `media-update`.
7. После реконнекта со сменой `socket.id` — заново `join` / `chat-join`.
