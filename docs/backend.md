# Бэкенд: apps/api и apps/sfu

NestJS 11 на Express, Socket.io 4, TypeORM + Postgres. Один процесс api на
инсталляцию. Контракт с клиентами — [protocol.md](protocol.md); здесь — как
код устроен внутри и куда смотреть, когда что-то меняешь.

## Старт процесса

[`main.ts`](../apps/api/src/main.ts):

1. Открыть Postgres (`DATABASE_URL`) с повторами — [`db/data-source.ts`](../apps/api/src/db/data-source.ts).
2. Применить миграции. Упала миграция — процесс выходит с понятным текстом, а
   не уходит в рестарт-луп.
3. Собрать `AppModule.withDatabase(db)` ([`app.module.ts`](../apps/api/src/app.module.ts)) —
   база приходит в модуль уже готовой, до первого провайдера.
4. Повесить `authGate` и отдачу `/uploads` ([`http-gate.ts`](../apps/api/src/http-gate.ts)).
5. Слушать `PORT` (3000). `SIGTERM` — дождаться фоновой работы, закрыть базу.

Контейнер стартует от root только чтобы выставить права на том загрузок, и
сразу понижается до `node` ([`infra/api-entrypoint.sh`](../infra/api-entrypoint.sh)).

## Раскладка

```
apps/api/src/
  main.ts, app.module.ts        старт, сборка модуля
  http-gate.ts                  authGate: пропуск, маска адреса, /uploads
  auth/                         пароль инсталляции, relay_pass, гостевые токены
  identity/                     личности, устройства, связка, владелец, роли, личное
  gateway/                      Socket.io: периметр, владельцы состояния, обработчики
  settings/                     каталог настроек, журнал, сводка панели
  db/                           entities, миграции, ретенция
  sfu/                          пропуски в медиасервер и его health-чек
  config.controller.ts          GET /api/config (ICE)
  turn.ts                       временные TURN-учётки
  upload.controller.ts, upload.guard.ts, uploads.ts, uploads.policy.ts   вложения
  metrics.controller.ts, metrics.ts                                     нагрузка хоста
  owner-link.ts                 CLI: выпустить ссылку владельца
  version.ts                    версия образа (build-arg)
```

## HTTP

| Контроллер | Маршруты |
|---|---|
| [`auth/auth.controller.ts`](../apps/api/src/auth/auth.controller.ts) | `POST /api/login`, `/api/logout` |
| [`identity/identity.controller.ts`](../apps/api/src/identity/identity.controller.ts) | `/api/identity/challenge`, `verify`, `me`, `nick` |
| [`identity/devices.controller.ts`](../apps/api/src/identity/devices.controller.ts) | `/api/identity/devices`, `devices/revoke`, `pair/*` |
| [`identity/owner.controller.ts`](../apps/api/src/identity/owner.controller.ts) | `/api/identity/owner`, `owner/claim` |
| [`config.controller.ts`](../apps/api/src/config.controller.ts) | `GET /api/config` |
| [`upload.controller.ts`](../apps/api/src/upload.controller.ts) | `POST /api/upload` |
| [`metrics.controller.ts`](../apps/api/src/metrics.controller.ts) | `GET /api/metrics` |
| [`health.controller.ts`](../apps/api/src/health.controller.ts) | `GET /api/health` |

Все, кроме `login` и `health`, закрыты `authGate`. Маршрутам `/api/identity/*`
кроме того нужна сессия личности — [`identity/session-guard.ts`](../apps/api/src/identity/session-guard.ts)
(`requireIdentity`).

## Socket.io-гейтвей

[`gateway/signaling.gateway.ts`](../apps/api/src/gateway/signaling.gateway.ts) —
точка входа и маршрутизатор, логики в нём нет. Он собирает три слоя:

```
SignalingGateway
 ├─ Perimeter       кто это и что ему можно
 ├─ владельцы состояния
 │   Directory · ChatSessions · VoiceSessions · Presence · Rings · Mentions · Moderation
 └─ обработчики
     Registry · Chat · Dm · Ring · Voice · Guest · Personal · Moderation · Admin
```

Порядок полей в классе и есть порядок инициализации: владельцы объявлены
раньше обработчиков, которые их используют.

### Периметр

[`gateway/perimeter.ts`](../apps/api/src/gateway/perimeter.ts) — единственное
место, которое отвечает «кто этот сокет и что ему можно»:

- `recognize` — в middleware Socket.io, до первого события: личность по куке
  `relay_id`, владение, баны; отказ `banned` / `blocked` / `maintenance`;
- гость (`admit`, `isGuest`, `guestRoom`, `isListener`);
- закрытые серверы (`isOpenTo`, `canSee`, `mayEnter`, `unlock*`);
- лимитер (`allow`, `allowMessage`, `allowDiag`) — три ведра токенов на сокет;
- `httpDoor` — та же маска адресов для `authGate`.

Проверка версии протокола — тоже в middleware, в `afterInit` гейтвея.

### Владельцы состояния

| Класс | Файл | Держит |
|---|---|---|
| `Directory` | [`directory.ts`](../apps/api/src/gateway/directory.ts) | видимость реестра под сокет; рассылка `servers`/`channels` пачкой раз в 80 мс |
| `ChatSessions` | [`chat-sessions.ts`](../apps/api/src/gateway/chat-sessions.ts) | кто в какой ленте, ростеры, `chat-closed` |
| `VoiceSessions` | [`voice-sessions.ts`](../apps/api/src/gateway/voice-sessions.ts) | голосовая комната сокета, транспорт, пропуск SFU, мут, грейс 24 с, выгон «призраков», комнаты бесед |
| `Presence` | [`presence.ts`](../apps/api/src/gateway/presence.ts) | присутствие личностей на инсталляции |
| `Rings` | [`ring.ts`](../apps/api/src/gateway/ring.ts) | живые вызовы, таймауты, исходы; переходы — [`ring-machine.ts`](../apps/api/src/gateway/ring-machine.ts) |
| `Mentions` | [`mentions.ts`](../apps/api/src/gateway/mentions.ts) | разбор `@` и счётчики упоминаний |
| `Moderation` | [`moderation.ts`](../apps/api/src/gateway/moderation.ts) | кто модерирует, как вывести забаненного |

`client.data` (поля сокета, [`socket-data.ts`](../apps/api/src/gateway/socket-data.ts))
пишут только владельцы. Обработчик не трогает его напрямую — так «выйти из
комнаты» записано в одном месте, а не в четырнадцати.

### Обработчики

Каждый — обычный класс без DI, получает владельцев в конструкторе.

| Файл | События |
|---|---|
| [`registry.handlers.ts`](../apps/api/src/gateway/registry.handlers.ts) | `server-*`, `channel-*` |
| [`chat.handlers.ts`](../apps/api/src/gateway/chat.handlers.ts) | `chat-*`, `mention-suggest`, отметки пропущенных звонков |
| [`dm.handlers.ts`](../apps/api/src/gateway/dm.handlers.ts) | `dm-*` |
| [`ring.handlers.ts`](../apps/api/src/gateway/ring.handlers.ts) | `call-*` |
| [`voice.handlers.ts`](../apps/api/src/gateway/voice.handlers.ts) | `join`, `leave`, `offer`, `answer`, `ice-candidate`, `media-update`, `sfu-token`, `voice-diag` |
| [`guests.handlers.ts`](../apps/api/src/gateway/guests.handlers.ts) | `invite-create`, `guest-kick` |
| [`personal.handlers.ts`](../apps/api/src/gateway/personal.handlers.ts) | `read-mark`, `prefs-set`, `rename`; снимки `reads`/`prefs`/`mentions` на входе |
| [`moderation.handlers.ts`](../apps/api/src/gateway/moderation.handlers.ts) | `moderation-*` |
| [`admin.handlers.ts`](../apps/api/src/gateway/admin.handlers.ts) | `admin-*` |

Тела событий читаются только через `str` / `trimmed` / `optional` и режутся по
`LIMIT` из [`gateway/protocol.ts`](../apps/api/src/gateway/protocol.ts). Там же —
копии типов ответов из `@relay/shared` (см. [architecture.md](architecture.md#контракт-и-его-копии)).

### Как добавить событие

1. Тип payload и ответа — в [`packages/shared/src/index.ts`](../packages/shared/src/index.ts)
   (`ClientToServerEvents` / `ServerToClientEvents`), копию ответа — в
   `gateway/protocol.ts`.
2. Логику — в подходящий `*.handlers.ts`; состояние сокета — через владельца.
3. `@SubscribeMessage` в гейтвее — одна строка, передающая управление обработчику.
4. Первой строкой обработчика — `perimeter.allow(client)` (кроме негоциации) и
   отсечение гостя, если событие не для него.
5. Тест рядом (`*.test.ts`, стенд — [`gateway.testkit.ts`](../apps/api/src/gateway/gateway.testkit.ts)).
6. Описать в [protocol.md](protocol.md) — `pnpm docs:check` проверит, что событие упомянуто.

## Сервисы (Nest-провайдеры)

| Сервис | Файл | Что |
|---|---|---|
| `RegistryService` | [`gateway/registry.service.ts`](../apps/api/src/gateway/registry.service.ts) | серверы и каналы: память + Postgres, сиды главного сервера, одноразовый импорт `registry.json` из 0.x |
| `ChatService` | [`gateway/chat.service.ts`](../apps/api/src/gateway/chat.service.ts) | сообщения, курсоры ленты, поиск (`to_tsvector('simple')` + префиксы), реакции, закрепы |
| `DmService` | [`gateway/dm.service.ts`](../apps/api/src/gateway/dm.service.ts) | беседы 1:1, адрес беседы, список переписок |
| `IdentityService` | [`identity/identity.service.ts`](../apps/api/src/identity/identity.service.ts) | челлендж, вход, ник, устройства |
| `PairingService` | [`identity/pairing.service.ts`](../apps/api/src/identity/pairing.service.ts) | связка устройств по коду (в памяти, 3 мин) |
| `OwnerService` | [`identity/owner.service.ts`](../apps/api/src/identity/owner.service.ts) | владелец инсталляции, ссылки-приглашения |
| `RolesService` | [`identity/roles.service.ts`](../apps/api/src/identity/roles.service.ts) | баны: на сервер и на инсталляцию |
| `ReadsService`, `PrefsService` | [`reads.service.ts`](../apps/api/src/identity/reads.service.ts), [`prefs.service.ts`](../apps/api/src/identity/prefs.service.ts) | отметки чтения (только растут), личные настройки |
| `PruneService` | [`identity/prune.service.ts`](../apps/api/src/identity/prune.service.ts) | удаление давно неактивных личностей (`people.pruneInactiveDays`, по умолчанию выключено) |
| `RetentionService` | [`db/retention.service.ts`](../apps/api/src/db/retention.service.ts) | удаление старых сообщений и их файлов |
| `UploadsService` | [`uploads.ts`](../apps/api/src/uploads.ts) | приём файла, квоты, определение вида, уборка сирот |
| `SettingsService` | [`settings/settings.service.ts`](../apps/api/src/settings/settings.service.ts) | значения настроек, проверка по каталогу, подписка на изменения |
| `AuditService` | [`settings/audit.service.ts`](../apps/api/src/settings/audit.service.ts) | журнал действий владельца и системы |
| `OverviewService` | [`settings/overview.service.ts`](../apps/api/src/settings/overview.service.ts) | сводка и список людей для панели |
| `MetricsService` | [`metrics.ts`](../apps/api/src/metrics.ts) | CPU/память/диск хоста из `/proc` |

## База данных

Схема — [`db/entities.ts`](../apps/api/src/db/entities.ts), миграции —
[`db/migrations/`](../apps/api/src/db/migrations/), список для TypeORM —
[`migrations/index.ts`](../apps/api/src/db/migrations/index.ts).

| Таблица | Что |
|---|---|
| `servers`, `channels` | реестр |
| `messages` | реплики каналов и бесед; GIN-индексы для поиска и упоминаний |
| `attachments` | метаданные файлов из тома `uploads` |
| `pins` | закреплённые сообщения |
| `identities`, `devices` | личности и их ключи; `devices.certificate` — подпись донора при связке |
| `roles` | баны (на сервер и на инсталляцию) |
| `owner_claims` | ссылки владельца и кто их забрал |
| `conversations` | беседы ЛС (`a`, `b` — пара личностей) |
| `reads`, `prefs` | личное состояние |
| `settings`, `audit` | настройки инсталляции и журнал |

Новая миграция: файл `<timestamp>-Name.ts` в `db/migrations/` + строка в
`migrations/index.ts`. Миграции идут вперёд; откат инсталляции —
`relay restore` из бэкапа.

## Фоновые задачи

| Что | Период | Где |
|---|---|---|
| ретенция сообщений | раз в час (раз в минуту в режиме `ephemeral`) | `RetentionService` |
| уборка неприкреплённых файлов | раз в час, порог `files.orphanSweepHours` | `UploadsService` |
| уборка неактивных личностей | раз в час, если `people.pruneInactiveDays > 0` | `PruneService` |

Работа, которую гейтвей запускает без ожидания (узнавание личности, запись
отметки о звонке), идёт через [`gateway/background.ts`](../apps/api/src/gateway/background.ts):
на остановке процесса она дожидается, а ошибки попадают в лог.

## Настройки инсталляции

Каталог — [`settings/catalog.ts`](../apps/api/src/settings/catalog.ts) (копия
[`shared/src/settings.ts`](../packages/shared/src/settings.ts)). У каждого
параметра: ключ `группа.имя`, тип, границы, умолчание, `applies` (когда
действует), флаги `client` (уезжает клиентам в `settings`), `secret`, `danger`,
`readOnly` + `env` (живёт в `.env`, панель только показывает).

- Код читает значение через `settings.get<T>('group.key')` в момент
  использования, не кэширует.
- Таблица `settings` хранит только то, что владелец менял. `.env` засевает её
  один раз, на первом старте, и только для `SEEDED_FROM_ENV`
  (`RETENTION_DAYS`, квота загрузок).
- Добавили параметр — его должен кто-то читать, иначе упадёт
  [`consumers.test.ts`](../packages/shared/src/consumers.test.ts).

## Медиасервер (apps/sfu)

Отдельный NestJS-процесс без базы: [`main.ts`](../apps/sfu/src/main.ts),
[`sfu.gateway.ts`](../apps/sfu/src/gateway/sfu.gateway.ts) (Socket.io на `/sfu/`),
[`rooms.service.ts`](../apps/sfu/src/media/rooms.service.ts) (комната = роутер),
[`workers.service.ts`](../apps/sfu/src/media/workers.service.ts) (воркеры mediasoup),
[`media.config.ts`](../apps/sfu/src/media/media.config.ts) (кодеки, порты),
[`token.ts`](../apps/sfu/src/token.ts) (проверка пропуска),
[`health.controller.ts`](../apps/sfu/src/health.controller.ts) (`GET /health` для api).
Протокол — [media.md](media.md#протокол-медиасервера).

## Логи

- api пишет в stdout через Nest `Logger`: `relay logs api`.
- Звонки логируются вехами: вход в комнату с транспортом и User-Agent,
  расщепление комнаты по транспортам, выдача пропусков SFU и клиентские вехи
  `voice-diag` (`diag <имя> (<socket>): <событие>`). Этого обычно хватает, чтобы
  разобрать «у меня не слышно» без доступа к клиенту.
- На старте api говорит словами, что происходит с историей (ретенция).

## Тесты

Vitest, файлы `*.test.ts` рядом с кодом. Тесты api работают с **настоящим
Postgres** ([`db/testing.ts`](../apps/api/src/db/testing.ts)) — без
`TEST_DATABASE_URL` они не запускаются, а не пропускаются. Socket.io подменён
фейком, который записывает, кому что ушло ([`gateway/testkit.ts`](../apps/api/src/gateway/testkit.ts)).
Как поднять базу и прогнать — [CONTRIBUTING.md](../CONTRIBUTING.md).
