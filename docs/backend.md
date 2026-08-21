# Бэкенд (apps/api)

NestJS 10 + Socket.io. HTTP-сервер — Express под капотом. Никакой БД: auth stateless, чат in-memory, файлы на диске.

## Модули

```
AppModule
├── AuthController       POST /api/login → выдача куки relay_pass
├── ConfigController     GET /api/config → ICE-серверы (STUN/TURN)
├── HealthController     GET /api/health → жив ли процесс (мимо authGate)
├── MetricsController    GET /api/metrics → нагрузка хоста
├── UploadController     POST /api/upload → мультипарт, возврат id вложения
├── UploadsService       реестр загруженных файлов (in-memory Map)
├── MetricsService       съём CPU/памяти/диска
├── ChatService          история текстовых каналов (in-memory Map)
├── RegistryService      серверы и каналы: список, дефолты, права
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

## Socket.io gateway (`gateway/`)

Один gateway — но уже не один файл. В `signaling.gateway.ts` остался только
сокет: кто спрашивает, что ему видно и куда уходит ответ. Всё, что объясняется
без сокета, лежит рядом:

| Файл | Что держит |
|---|---|
| `protocol.ts` | форма тел сообщений (всё, что прислал клиент, — `unknown` до первой проверки), потолки полей `LIMIT`, единственный способ эти тела читать (`str` / `trimmed` / `optional`) и подпись не назвавшегося `ANON_NAME` |
| `chat.service.ts` | история текстовых каналов: `CHAT_PREFIX`, `HISTORY_LIMIT`, вытеснение старых каналов, реакции. Ни один обработчик не трогает `Map` напрямую |
| `registry.service.ts` | сам реестр: `MAIN_SERVER_ID`, `DEFAULT_SERVERS`, `DEFAULT_CHANNELS`, потолки `MAX_SERVERS` / `MAX_CHANNELS`, видимость, право правки, запись на диск |
| `ownership.ts` | правило владения записями (`creatorId` = устройство) и их публичная форма |
| `registry.ts` | атомарное чтение/запись `registry.json` |
| `unlock.ts` | пароли закрытых серверов (scrypt) и счётчик неудачных попыток |

Границы не косметические: слой 1 плана 1.0 (Postgres вместо памяти) меняет
`chat.service.ts`, слой ролей — `registry.service.ts`, и ни тот, ни другой не
должны перебирать полторы тысячи строк правил о том, кому что видно.

Числа тоже лежат по одному разу. Тег участника — двадцать символов и в `join`,
и в `rename`, и в `chat-join`, потому что это один `LIMIT.tag`, а не три копии,
написанные в разные дни.

Два независимых типа «комнат»:

| Тип | Prefix | Назначение |
|---|---|---|
| Голосовой канал | _(нет)_ | WebRTC-сигналинг: offer/answer/ICE, состав участников |
| Текстовый канал | `chat:` | Сообщения, история, ростер |

### События: клиент → сервер

Тела разбираются читалками из `protocol.ts` — до этого им никто не верит.
Возвращаемое значение обработчика = ack socket.io.

#### Реестр серверов и каналов

| Событие | Данные | Описание |
|---|---|---|
| `server-create` | `{id, name, emoji?, password?}` | Создать сервер. `id` придумывает клиент, чтобы не ждать ответа; пароль → сервер закрытый, хранится только хэш |
| `server-unlock` | `{id, password}` | Предъявить пароль закрытого сервера |
| `server-delete` | `{id}` | Удалить свой сервер со всеми каналами. Ack: `not-found` / `forbidden` / `not-owner` / `occupied` |
| `server-stats` | `{id}` | Что пропадёт при удалении: каналы, сообщения, люди в эфире |
| `channel-create` | `{serverId, type, name, mode?}` | Создать канал. В главном сервере — нельзя: там фиксированная витрина |
| `channel-mode` | `{id, mode}` | Перевести голосовой канал на `p2p` или `sfu` |
| `channel-rename` | `{id, name}` | Сменить отображаемое имя; слаг остаётся прежним |
| `channel-delete` | `{id}` | Удалить канал. Голосовой с людьми внутри не удаляется (`occupied`) |
| `channel-stats` | `{id}` | Срез канала для диалога подтверждения |
| `invite-create` | `{room}` | Гостевая ссылка в голосовой канал: подписанный токен на сутки, на сервере не хранится |

#### Голосовой канал

| Событие | Данные | Описание |
|---|---|---|
| `join` | `{room, name, clientId?, transport?}` | Войти в эфир |
| `leave` | — | Покинуть эфир |
| `offer` | `{to, sdp}` | SDP offer конкретному peer |
| `answer` | `{to, sdp}` | SDP answer |
| `ice-candidate` | `{to, candidate}` | ICE candidate |
| `media-update` | `{camOn, screenOn, micOn, deafened}` | Камера и экран — соседям по комнате, мут и глушилка — ещё и в presence |
| `rename` | `{name}` | Сменить тег на лету: presence эфира и ростер чата |
| `sfu-token` | `{room, name}` | Пропуск в медиасервер. Ack: `{token, exp, url}` либо `unavailable` / `not-sfu` / `not-in-room` / `forbidden` |
| `voice-diag` | `{event, detail}` | Веха звонка от клиента — только в серверный лог, никакой логики |

#### Текстовый канал

| Событие | Данные | Описание |
|---|---|---|
| `chat-join` | `{room, name}` | Войти в текстовый канал |
| `chat-leave` | — | Покинуть текстовый канал |
| `chat-message` | `{text?, uploadId?, replyTo?, spoiler?}` | Отправить сообщение (текст и/или вложение) |
| `chat-edit` | `{id, text}` | Править свою реплику (автор — по тегу) |
| `chat-delete` | `{id}` | Удалить свою реплику |
| `chat-typing` | — | «Печатает…»: тег сервер берёт с сокета, тело не нужно |
| `chat-react` | `{id, emoji}` | Тогл реакции; набор эмодзи закрытый (`chat.service.ts`) |

### События: сервер → клиент

| Событие | Данные | Описание |
|---|---|---|
| `servers` | `PublicServer[]` | Реестр серверов: без хэшей паролей, с флагами `locked` и `mine` |
| `channels` | `PublicChannel[]` | Каналы, видимые этому сокету: закрытые серверы скрыты до пароля |
| `server-unlock-result` | `{id, ok}` | Подошёл ли пароль |
| `peers` | `{id, name?, guest?}[]` | Новичку: список уже подключённых — offer'ы шлёт им он |
| `peer-joined` | `{id, name, guest?}` | В канал зашёл новый участник |
| `peer-left` | `{id}` | Участник ушёл |
| `peer-renamed` | `{id, name}` | Участник сменил тег |
| `offer` / `answer` / `ice-candidate` | `{from, ...}` | Ретрансляция WebRTC-сигналинга |
| `media-update` | `{from, camOn, screenOn, micOn, deafened}` | Ретрансляция медиасостояния |
| `voice-mode` | `{room, mode}` | Канал переехал на другой транспорт — тем, кто прямо сейчас в нём |
| `voice-presence` | `Record<slug, VoicePresenceEntry[]>` | Состав голосовых каналов, видимых этому сокету (плюс своя комната) |
| `chat` | `ChatMessage` | Новое сообщение в текстовый канал |
| `chat-history` | `ChatMessage[]` | История канала при входе (`HISTORY_LIMIT` — 50 реплик) |
| `chat-roster` | `string[]` | Актуальный список участников текстового канала |
| `chat-typing` | `{name}` | Кто-то печатает (себе не шлём) |
| `chat-edited` | `{id, text, editedTs}` | Реплику поправили |
| `chat-deleted` | `{id}` | Реплику убрали |
| `chat-reaction` | `{id, reactions}` | Новый набор реакций сообщения |
| `chat-activity` | `{slug, ts}` | Пинг «в канале писали»: только слаг и время, без содержимого |
| `chat-closed` | `{slug}` | Канал удалён — читателей выписали из комнаты |

### Безопасность сигналинга

`relay()` пересылает signal только если `target.data.room === client.data.room`. Клиент не может послать offer участнику другой комнаты.

В `chat-message` вложение берётся из `UploadsService.get(uploadId)` — клиент не может задать произвольный url/mime.

Слаг канала закрытого сервера — такой же секрет, как и сам канал: по слагу в него заходят. Поэтому и `voice-presence`, и `chat-activity` уезжают только тем, кому канал виден, а не всем подряд.

Каждое событие, кроме негоциации (`offer` / `answer` / `ice-candidate`), списывает токен из бакета сокета: 40 в запасе, 20 в секунду. Негоциацию не трогаем — она бывает легитимно бурстовой и релеится 1:1.

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
    {"urls": ["turn:..."], "username": "1755820800:9f3c1a2b", "credential": "..."}
  ],
  "iceExpiresAt": 1755820800
}
```
Читает `STUN_URLS`, `TURN_URLS` и `TURN_SECRET`. Не заданы — возвращает STUN Google.

Пара для TURN выдаётся на каждый запрос своя и на сутки (`TURN_TTL_SECONDS`):
логин — это срок годности, пароль — HMAC-SHA1 от логина на `TURN_SECRET`, тот же
секрет проверяет coturn (`apps/api/src/turn.ts`, `infra/coturn-entrypoint.sh`).
`iceExpiresAt` — когда пара перестанет работать; по нему вкладка, открытая со
вчера, знает, что конфиг пора перечитать. Без `TURN_SECRET` отдаётся статическая
пара `TURN_USERNAME`/`TURN_CREDENTIAL` — так было до 1.0, и так остаётся для
чужого TURN-сервера с бессрочной парой.

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
    protocol.ts              формы тел сообщений, потолки полей (LIMIT), их читалки, ANON_NAME
    registry.ts              типы реестра + чтение/запись registry.json
    registry.service.ts      сам реестр: дефолты, потолки, видимость, право правки, persist
    ownership.ts             правило владения записями + их публичная форма
    chat.service.ts          история текстовых каналов (50 реплик, 200 каналов) + реакции
    unlock.ts                пароли закрытых серверов (scrypt) + счётчик попыток
    signaling.gateway.ts     сокет: обработчики событий, рассылки, присутствие
  sfu/
    sfu-health.ts            пинг медиасервера (жив ли он вообще)
    sfu-token.ts             выдача пропусков в медиасервер
```
