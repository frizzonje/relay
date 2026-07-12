# Протокол relay (спецификация для клиентов)

Языконезависимое описание протокола сервер↔клиент. Источник правды по типам —
[`packages/shared/src/index.ts`](../packages/shared/src/index.ts) (TypeScript);
этот документ — его перевод для нативных клиентов (Swift, Kotlin, …), которые
не могут импортировать TS-пакет. **При изменении контракта обновлять оба файла.**

Все клиенты (web, iOS, desktop) — равноправные потребители одного API.
Сервер ничего не знает о платформе клиента.

## 1. Транспорты

Всё ходит через один origin (Caddy, TLS):

| Канал | Путь | Назначение |
|---|---|---|
| REST | `/api/*` | логин, ICE-конфиг, загрузка файлов |
| Socket.io v4 | `/socket.io` | сигналинг WebRTC, чат, реестры, presence |
| Статика | `/uploads/*` | отдача загруженных вложений |
| WebRTC | P2P (mesh) | медиа: аудио/видео/экран, напрямую между клиентами |

Socket.io — не «чистый» WebSocket: нужен socket.io-клиент
(iOS — `socket.io-client-swift`, Android — `socket.io-client-java`, поддерживать
версию протокола Engine.IO 4 / Socket.IO 4).

## 2. Аутентификация

Один общий пароль на инсталляцию (`SITE_PASSWORD`). Пустой пароль на сервере =
авторизация выключена, все запросы проходят без куки.

### 2.1 Логин

```
POST /api/login
Content-Type: application/json
{ "password": "..." }
```

- `200 {"ok":true}` + заголовок `Set-Cookie: relay_pass=<token>; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000; Path=/`
  (web-фронт получает 201 от Nest — проверять `2xx`, не точный код);
- `401 {"error":"invalid password"}` — неверный пароль;
- `429 {"error":"too many attempts"}` — rate-limit: 8 неудач с одного IP за 10 минут.

### 2.2 Токен

`<exp>.<sig>`, где `exp` — миллисекунды Unix-времени истечения (now + 30 дней),
`sig` — `base64url(HMAC-SHA256(key, строка exp))` без паддинга,
`key = "relay-auth-v1:" + SITE_PASSWORD`. Смена пароля на сервере мгновенно
инвалидирует все выданные токены. Клиенту токен непрозрачен — разбирать его
не нужно, только хранить и предъявлять.

### 2.3 Предъявление

Сервер принимает токен из трёх источников; проверяются **в этом порядке**
(первый непустой выигрывает):

1. **`auth`-поле socket.io-handshake** — `{ token }` (только для сокета);
2. **`Authorization: Bearer <token>`** — REST, `/uploads/*` и socket.io-handshake;
3. **кука `relay_pass`** — REST, `/uploads/*` и socket.io-handshake.

Web-фронт и Tauri (грузит web-UI) полагаются на куку — браузер шлёт её сам.
Нативным клиентам удобнее заголовок/`auth`-поле, чем эмулировать cookie-jar:

- REST и `/uploads/*` — `Authorization: Bearer <token>` (либо `Cookie`, если
  URLSession/OkHttp ведут cookie-jar сами);
- Socket.io handshake — `auth`-поле (предпочтительно) или заголовок. Примеры:
  - `socket.io-client` (JS/Tauri-обёртки) — `auth`-поле:
    `io(url, { auth: { token } })`;
  - `socket.io-client-swift` — заголовок (его `connectParams` уходят в query,
    а не в `auth`):
    `SocketManager(socketURL: url, config: [.extraHeaders(["Authorization": "Bearer \(token)"])])`.
  - Невалидный/отсутствующий токен → сервер молча делает `disconnect` сразу
    после подключения.

## 3. REST

### GET /api/config

ICE-серверы для RTCPeerConnection. Запрашивать перед первым звонком; ответ можно
кэшировать на сессию.

```json
{ "iceServers": [ { "urls": ["stun:..."], "username": "...", "credential": "..." } ] }
```

`username`/`credential` присутствуют только у TURN.

### POST /api/upload

`multipart/form-data`, поле `file`, максимум **25 МБ** (иначе 4xx).

```json
{ "id": "…", "url": "/uploads/ab12….png", "name": "исходное-имя.png",
  "size": 12345, "mime": "image/png", "kind": "image" }
```

`kind`: `image` | `audio` | `file` — подсказка для рендера.
`id` — одноразовый талон: отправить в `chat-message { uploadId }`, чтобы
прикрепить файл к сообщению. `url` — относительный, отдаётся `/uploads/*`
(нужна та же кука).

## 4. Socket.io: подключение

- Немедленно после успешного handshake сервер шлёт три события:
  `servers`, `channels`, `voice-presence` (полные снапшоты).
- Включён connection-state-recovery: при коротком обрыве сессия
  восстанавливается с тем же `socket.id`; сервер даёт **24 с грейса** до
  оповещения остальных об уходе из комнат. Клиенту при `reconnect` со сменой id
  нужно заново `join`/`chat-join` (web-клиент так и делает).
- `socket.id` — идентификатор участника везде в протоколе (peer id).

## 5. Реестры серверов и каналов

Реестр общий на инсталляцию, персистится на сервере. Снапшоты приходят целиком
при каждом изменении — клиент просто замещает своё состояние.

**Server** `{ id, name, emoji?, removable, locked? }` — «гильдия».
**Channel** `{ id, serverId, type: "text"|"voice", name, slug, removable }` —
`slug` уникален глобально и служит именем socket.io-комнаты.

| Направление | Событие | Payload | Примечание |
|---|---|---|---|
| S→C | `servers` | `Server[]` | без хэшей паролей, только флаг `locked` |
| S→C | `channels` | `Channel[]` | каналы закрытых серверов скрыты до unlock |
| C→S | `server-create` | `{ id, name, emoji?, password? }` | `id` генерирует клиент (UUID) |
| C→S | `server-delete` | `{ id }` | главный сервер неудаляем |
| C→S | `server-unlock` | `{ id, password }` | доступ к закрытому серверу |
| S→C | `server-unlock-result` | `{ id, ok }` | при `ok` следом приходит `channels` |
| C→S | `channel-create` | `{ serverId, type, name }` | сервер сам делает id/slug; лимит 50 каналов |
| C→S | `channel-delete` | `{ id }` | |

## 6. Текстовые каналы

| Направление | Событие | Payload |
|---|---|---|
| C→S | `chat-join` | `{ room: slug, name? }` |
| C→S | `chat-leave` | — |
| C→S | `chat-message` | `{ text? }` или `{ uploadId? }` (талон из /api/upload) |
| C→S | `chat-react` | `{ id: messageId, emoji }` — повторная отправка снимает реакцию |
| S→C | `chat-history` | `ChatMessage[]` — последние ≤50, сразу после join |
| S→C | `chat` | `ChatMessage` — новое сообщение (включая системные вход/выход) |
| S→C | `chat-roster` | `string[]` — имена присутствующих в канале |
| S→C | `chat-reaction` | `{ id, reactions: { emoji: name[] } }` |

**ChatMessage** `{ id?, name?, text, ts, attachment?, system?, reactions? }` —
`ts` в мс Unix; `system: true` — сервисное сообщение, рисовать иначе.
Реакции валидируются по списку: `👍 👎 ❤️ 😂 🔥 🫡 🤡 😭`.
Лимиты: текст ≤500 символов, имя ≤20, slug ≤32 (сервер усечёт сам).

## 7. Голос (mesh-WebRTC)

Топология — full mesh: каждый с каждым, отдельный RTCPeerConnection на пару.
Практический потолок ~6–7 участников (для большего — план SFU,
[sfu-plan.md](sfu-plan.md)).

### 7.1 Вход/выход и сигналинг

| Направление | Событие | Payload |
|---|---|---|
| C→S | `join` | `{ room: slug, name? }` — одна голосовая комната на сокет |
| C→S | `leave` | — |
| S→C | `peers` | `VoicePeer[]` — кто уже в комнате (ответ на join) |
| S→C | `peer-joined` | `{ id, name? }` |
| S→C | `peer-left` | `{ id }` |
| C→S | `offer` / `answer` | `{ to: peerId, sdp: { type, sdp } }` |
| S→C | `offer` / `answer` | `{ from: peerId, name?, sdp }` |
| C→S | `ice-candidate` | `{ to, candidate: { candidate, sdpMid, sdpMLineIndex, usernameFragment } }` |
| S→C | `ice-candidate` | `{ from, candidate }` |

Сервер только пересылает SDP/ICE адресату (`to` → `from`), не заглядывая внутрь.

### 7.2 Правила соединения (perfect negotiation)

1. **Новичок инициирует**: получив `peers`, шлёт offer каждому из списка.
   Существующие участники не делают ничего, пока не получат offer.
2. Роли glare-разрешения детерминированы: для пары (A, B)
   **polite тот, чей `socket.id` лексикографически меньше** id собеседника.
   Невежливая сторона при коллизии (одновременные offer) игнорирует входящий
   offer, вежливая — откатывается (`rollback`) и принимает.
3. ICE-кандидаты, пришедшие до `setRemoteDescription`, буферизуются и
   применяются после.
4. Реконнект медиа: при `connectionState == "disconnected"` дольше ~8 с —
   `restartIce()`; при `failed` — пересоздание соединения.

### 7.3 Состояние медиа и presence

| Направление | Событие | Payload |
|---|---|---|
| C→S | `media-update` | `{ camOn, screenOn, micOn?, deafened? }` — слать сразу после join и при каждом изменении |
| S→C | `media-update` | то же + `from: peerId` |
| C→S | `rename` | `{ name }` — смена имени на лету |
| S→C | `peer-renamed` | `{ id, name }` |
| S→C | `voice-presence` | `{ [roomSlug]: VoicePeer[] }` — глобальная карта «кто где», рассылается всем при каждом изменении |

**VoicePeer** `{ id, name?, micOn?, deafened? }`; отсутствующий `micOn`
трактовать как «включён».

Медиа-треки: аудио всегда, видео/экран добавляются через
`replaceTrack`/renegotiation (см. `apps/web/lib/voice.ts` как референс-реализацию;
битрейт видео капится ~900 кбит/с).

## 8. Устаревшее — в новых клиентах не реализовывать

- событие `track` и связанное поле `oko` в `ChatMessage` — legacy из ранней
  версии протокола, полностью удалены;
- localStorage-ключ web-клиента `relay-tag` — деталь web-реализации, не часть
  протокола.

## 9. Чек-лист нового клиента

1. `POST /api/login` → взять токен из `Set-Cookie: relay_pass=…` и сохранить
   (Keychain/защищённое хранилище).
2. Socket.io-подключение с токеном в `auth`-поле (или `Authorization`-заголовке,
   §2.3) → принять `servers`/`channels`/`voice-presence`.
3. Чат: `chat-join` → история/roster → `chat-message`/`chat-react`.
4. Звонок: `GET /api/config` → `join` → offer'ы всем из `peers` по правилам 7.2
   → `media-update` → рендер треков.
5. Обработать: `disconnect` сразу после connect (= кука протухла → релогин),
   `server-unlock-result`, реконнект с повторным `join`.
