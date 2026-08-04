# Бэкенд (apps/api)

NestJS 10 + Socket.io. HTTP-сервер — Express под капотом. Никакой БД: auth stateless, чат in-memory, файлы на диске.

## Модули

```
AppModule
├── AuthController       POST /api/login → выдача куки relay_pass
├── ConfigController     GET /api/config → ICE-серверы (STUN/TURN)
├── UploadController     POST /api/upload → мультипарт, возврат id вложения
├── UploadsService       реестр загруженных файлов (in-memory Map)
└── SignalingGateway     WebSocket: голосовой сигналинг + текстовый чат
```

Статика `UPLOAD_DIR` (`/app/uploads`) отдаётся Express за auth-гейтом по префиксу `/uploads`.

---

## Авторизация

`apps/api/src/auth/auth.ts` — функции `issueToken`, `verifyToken`, `passwordMatches`, `parseCookies`. Тот же файл шарится в `packages/shared/src/auth.ts` (common source of truth).

- Пароль сравнивается через SHA-256 + `timingSafeEqual` (без timing-атак).
- Токен: `{exp}.{HMAC-SHA256(exp, SITE_PASSWORD)}` → кука `relay_pass`, TTL 30 дней.
- Смена пароля → все куки невалидны мгновенно (подпись от пароля).

`authGate` (Express middleware в `main.ts`) пропускает только `POST /api/login` без куки. Socket.io идёт мимо Express-middleware → проверка в `handleConnection` напрямую.

---

## Socket.io gateway (`signaling.gateway.ts`)

Один gateway, два независимых типа «комнат»:

| Тип | Prefix | Назначение |
|---|---|---|
| Голосовой канал | _(нет)_ | WebRTC-сигналинг: offer/answer/ICE, состав участников |
| Текстовый канал | `chat:` | Сообщения, история, ростер |

### События: клиент → сервер

| Событие | Данные | Описание |
|---|---|---|
| `join` | `{room, name}` | Войти в голосовой канал |
| `leave` | — | Покинуть голосовой канал |
| `offer` | `{to, sdp}` | SDP offer конкретному peer |
| `answer` | `{to, sdp}` | SDP answer |
| `ice-candidate` | `{to, candidate}` | ICE candidate |
| `media-update` | `{camOn, screenOn}` | Уведомить участников о смене видеостатуса |
| `chat-join` | `{room, name}` | Войти в текстовый канал |
| `chat-leave` | — | Покинуть текстовый канал |
| `chat-message` | `{text?, uploadId?}` | Отправить сообщение (текст и/или вложение) |

### События: сервер → клиент

| Событие | Данные | Описание |
|---|---|---|
| `peers` | `VoicePeer[]` | Новичку: список уже подключённых (они шлют ему offer'ы) |
| `peer-joined` | `{id, name}` | В канал зашёл новый участник |
| `peer-left` | `{id}` | Участник ушёл |
| `offer` / `answer` / `ice-candidate` | `{from, ...}` | Ретрансляция WebRTC-сигналинга |
| `voice-presence` | `VoicePresence` | Полный состав всех голосовых каналов (при каждом изменении) |
| `chat` | `ChatMessage` | Новое сообщение в текстовый канал |
| `chat-history` | `ChatMessage[]` | История (до 50 сообщений) при входе в канал |
| `chat-roster` | `string[]` | Актуальный список участников текстового канала |
| `media-update` | `{from, camOn, screenOn}` | Ретрансляция смены видеостатуса |

### Безопасность сигналинга

`relay()` пересылает signal только если `target.data.room === client.data.room`. Клиент не может послать offer участнику другой комнаты.

В `chat-message` вложение берётся из `UploadsService.get(uploadId)` — клиент не может задать произвольный url/mime.

---

## REST API

### `POST /api/login`
```json
// body
{"password": "..."}

// success 200
{"ok": true}
// + Set-Cookie: relay_pass=...; HttpOnly; SameSite=Strict; Max-Age=...

// fail 401
{"error": "invalid password"}
```

### `GET /api/config`
```json
{
  "iceServers": [
    {"urls": ["stun:..."]},
    {"urls": ["turn:..."], "username": "...", "credential": "..."}
  ]
}
```
Читает переменные `STUN_URLS`, `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`. Если не заданы — возвращает STUN Google.

### `POST /api/upload`

Multipart, поле `file`. Ограничения:

- **25 МБ на файл** (`MAX_UPLOAD_BYTES`), сверх — 413.
- **бюджет байтов на адрес**: всплеск 300 МиБ, дальше 100 МиБ/мин. Сверх — 429,
  причём отказ приходит до записи тела на диск (гард стоит раньше multer).
  Списывается настоящий размер файла после записи, а не `Content-Length`:
  заголовок пишет клиент, и бюджет, который ему верит, обходится одной строкой.
- **потолок на весь каталог** — `UPLOAD_MAX_TOTAL_BYTES` (`2G`, `512M` или
  байты; по умолчанию 2 ГиБ). За потолком вытесняются самые старые файлы, и об
  этом пишется в лог: отказ вместо вытеснения означал бы, что один человек,
  забивший каталог, останавливает вложения всем до прихода администратора.

Возвращает:
```json
{
  "id": "uuid-filename",
  "url": "/uploads/uuid-filename",
  "name": "original.jpg",
  "size": 123456,
  "mime": "image/jpeg",
  "kind": "image"   // "image" | "audio" | "file"
}
```
`id` передаётся в `chat-message.uploadId`. Сервер сам подставляет метаданные — клиент не трогает url/mime.

---

## Файловая структура

```
apps/api/src/
  main.ts                    bootstrap, authGate, staticAssets
  app.module.ts              регистрация всех контроллеров и провайдеров
  auth/
    auth.ts                  issueToken, verifyToken, passwordMatches
    auth.controller.ts       POST /api/login
  config.controller.ts       GET /api/config
  health.controller.ts       GET /api/health (публичный, мимо authGate)
  metrics.controller.ts      GET /api/metrics
  metrics.ts                 съём CPU/памяти/диска хоста
  upload.controller.ts       POST /api/upload
  upload.guard.ts            бюджет байтов на адрес (429 до записи на диск)
  uploads.ts                 UploadsService (реестр + квота + detectKind + sanitizeName)
  gateway/
    registry.ts              типы реестра + чтение/запись registry.json
    ownership.ts             правило владения записями + их публичная форма
    unlock.ts                пароли закрытых серверов (scrypt) + счётчик попыток
    signaling.gateway.ts     всё WebSocket
  sfu/
    sfu-health.ts            пинг медиасервера (жив ли он вообще)
    sfu-token.ts             выдача пропусков в медиасервер
```
