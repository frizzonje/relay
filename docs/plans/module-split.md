# Разрез больших модулей — план

> Отдельный план от [code-audit.md](code-audit.md): там ищем дерьмо внутри
> файлов, здесь — режем файлы, которые держат несколько ответственностей.
> Два модуля режутся своими фазами
> [architecture-cleanup.md](architecture-cleanup.md) и здесь только
> упоминаются: `signaling.gateway.ts` (фаза 2) и `lib/voice.ts` (фаза 3).

## Что считаем большим

Строки без комментариев, а не `wc -l` (`pnpm size:report`): код тут
комментирован плотно, и `voice-sessions.ts` на 723 строки — это 304 строки кода. Порог — **300 строк
кода**: выше него файлов 28 из 297 (замер 2026-10-07). Длина сама по себе не
приговор: каталог настроек или таблица иконок законно длинные. Режем, когда в
файле **больше одной причины меняться**. Признаки: разделы с собственным
состоянием, функции, которые не зовут друг друга, импорты, нужные только
половине файла.

## Правила разреза

1. **Чистый перенос отдельным коммитом.** Сначала код переезжает без единой
   правки поведения (`git diff --color-moved` показывает только перенос), и
   только следующим коммитом — улучшения. Иначе ревьюер не отличит
   перемещённое от изменённого.
2. **Публичный путь не меняется.** Бывший файл становится каталогом с
   `index.ts`, реэкспортирующим прежние имена, — импортёры не трогаются в том
   же коммите. Переводить их на точные пути — отдельный шаг, по желанию.
3. **Тесты не трогаются при переносе** и зелёные до и после. Тест, который
   пришлось поправить при чистом переносе, — признак, что перенос не чистый.
4. **Один модуль — один PR-шаг**: перенос, проверка (`turbo typecheck test
   build`, lint, e2e для голоса и сигналинга), коммит. Не режем два соседних
   модуля одним коммитом.
5. **Новые файлы ≤ 300 строк кода** — иначе разрез не закончен.
6. **Состояние не размазывается.** Если у куска своё состояние в памяти, он
   уезжает вместе с ним целиком; два файла, которые пишут в один `Map`, — это
   не разрез, а ещё одна гонка.

## Очередь

Порядок — по выгоде на час работы: сначала то, что режется чистым переносом
и мешает больше всего.

### Волна A — контракт и каталоги (чистый перенос, риск минимальный)

| Модуль | Код / всего | Разрез |
| ------ | ----------- | ------ |
| ✅ `packages/shared/src/index.ts` | 771 / 1849 | Разрезан чистым переносом (декларации дословно, импорты посчитаны по дереву разбора): `common.ts` (версия протокола, пределы, `Person`), `chat.ts`, `dm.ts`, `call.ts`, `presence.ts`, `registry.ts`, `voice.ts` (сигналинг mesh, гости, отказы), `http.ts` (ICE-конфиг, метрики, вход, загрузка), `events.ts` — только две карты событий; `BannedRelay` — к модерации. `index.ts` — реэкспорты соседних модулей и `export *` доменов. Самый большой домен — `chat.ts`, 387 строк вместе с комментариями. |
| ✅ `packages/shared/src/settings.ts` | 1149 / 1574 | Разрезан чистым переносом: 13 групп каталога — `settings/catalog/<группа>.ts` (105 ключей в прежнем порядке, тексты дословно), типы — `settings/spec.ts`, единицы и потолки ввода — `settings/limits.ts`, разбор адресов и масок — `net.ts`, сборка `SETTINGS` и `validateSetting` — `settings/index.ts`. Самый большой файл — `catalog/voice.ts`, 145 строк. |
| `apps/api/src/db/entities.ts` | 297 / 717 | По сущности на файл в `db/entities/` — принятая в TypeORM раскладка; `ENTITIES` в `index.ts`. Низкий приоритет: файл однородный, одна причина меняться. |
| `apps/web/components/ui/icon.tsx` | 361 / 406 | Не режем: это таблица глифов. Исключение записывается в настройку `max-lines`. |

### Волна B — сервер (состояние в памяти, нужны тесты на границы)

| Модуль | Код / всего | Разрез |
| ------ | ----------- | ------ |
| `api/gateway/chat.service.ts` | 572 / 1011 | Лента (history/older/newer/around, курсор) остаётся; `chat-search.ts` (`searchTerms`, `tsquery`, `search`); `pins.service.ts` (pin/unpin/pinCount/pinned); `mentions.service.ts` (`mentionedIn`, `peopleByFingerprint`, `mentionCandidates`, `mentionCounts`); реакции (`knownReaction`, `toggleReaction`) — чистые функции в `reactions.ts`. |
| `api/gateway/chat.handlers.ts` | 444 / 782 | По тем же швам: обработчики поиска, пинов и упоминаний переезжают к своим сервисам; в `chat.handlers` остаются join/message/edit/remove/typing/react. Совпадает с целевой раскладкой фазы 2. |
| `api/gateway/perimeter.ts` | 272 / 620 | Четыре независимых куска с собственным состоянием: лимитер (`allow*`, `spend`, токен-бакеты), замки серверов (`markUnlocked` … `noteUnlockSuccess`, кэш проверок пароля), гостевая дверь (`admit`, `isGuest`, `banGuest`, `guestBanned`), устройства (`deviceOf`, `rememberDevice`, `claimDevice`). `Perimeter` остаётся фасадом на время фазы 2. |
| `api/gateway/voice-sessions.ts` | 304 / 723 | Комнаты звонков 1:1 (`openCallRoom`, `mayEnterCallRoom`, `resumeCall`, `endCall`) → `call-rooms.ts`; проекция присутствия (`presence`, `presenceFor`, `snapshotFor`, `broadcast`) → `voice-presence.ts`. Места и удержание — ядро, остаются. |
| `api/gateway/registry.handlers.ts` | 362 / 569 | Серверы и каналы — две сущности с разными правилами прав: `servers.handlers.ts`, `channels.handlers.ts`. |
| `api/gateway/signaling.gateway.ts` | 782 / 1153 | **Фаза 2** — гейтвей на модулях Nest. |
| `sfu/gateway/sfu.gateway.ts` | 417 / 604 | Жизненный цикл сессии (connection, resume, парковка, release) → `sessions.ts`; медиа-обработчики остаются в гейтвее. Режется после починки гонок из code-audit (этап 1), не до. |

### Волна C — клиент: логика

| Модуль | Код / всего | Разрез |
| ------ | ----------- | ------ |
| `web/components/providers/SocketProvider.tsx` | 432 / 783 | Сейчас это **один `useEffect` на ~700 строк** с 32 подписками. Разрез — по доменам: `lib/socket/bind-chat.ts`, `bind-voice.ts`, `bind-registry.ts`, `bind-dm.ts` (звонки и ЛС), `bind-admin.ts`. Каждый — `(socket) => unsubscribe`; провайдер собирает их и снимает при размонтировании. Тестировать их можно без React. |
| `web/stores/admin.ts` | 380 / 610 | Помощник ack уходит в общий `request` (code-audit, этап 1); стор режется на срезы по вкладкам панели (настройки, люди, журнал, обслуживание). |
| `web/lib/voice/mic.ts`, `camera.ts` | 363 / 602, 384 / 573 | Оба держат свой `readPref`/`writePref`/`chosen` поверх `localStorage` — в общий `lib/prefs.ts` (он уже есть). `camera.ts`: трансляция экрана (профили, режим, `retuneScreen`, предупреждения о потолке движка) → `screen.ts`, камера остаётся. `mic.ts`: шумовой гейт и метр → `mic-gate.ts`. |
| `web/lib/voice/sfu/index.ts` | 376 / 588 | Одна функция `createSfuTransport` на ~500 строк. Режется вместе с фазой 3, когда у транспорта появится явная машина состояний; до неё — только вынос `ask` в общий `request`. |
| `web/lib/voice.ts` | 665 / 1156 | **Фаза 3** — машина состояний голосовой сессии. |

### Волна D — клиент: компоненты

| Модуль | Код / всего | Разрез |
| ------ | ----------- | ------ |
| `stage/VideoTile.tsx` | 857 / 1093 | Подкомпоненты уже отдельные функции — переносом в `stage/tile/`: `VolumeSlider`, `SignalBars` + таблицы `NET_*`, `AmbientWash`, `StreamCover`, `SendBadge`, полноэкранный режим (`Fs*`, `leaveImmersive`) → хук `useImmersive`. В самой плитке 9 эффектов — каждый в именованный хук по его заботе. |
| `chat/ChatPanel.tsx` | 757 / 957 | `PendingAttachments` + перетаскивание файлов → `useUploads`; прокрутка, «прыжок к сообщению» и подгрузка → `useFeedScroll`; ответ, правка, удаление, пин — `useMessageActions`. Панель остаётся раскладкой. |
| `layout/SettingsDialog.tsx` | 671 / 784 | По вкладке на файл в `layout/settings/` (`av`, `stream`, `appearance`, `hotkeys`, `app`, `account`, `about`); общие поля (`SelectField`, `Toggle`, `KeybindRow`) — в `settings/fields.tsx`. Диалог — только вкладки и роутинг. |
| `layout/Sidebar.tsx` | 664 / 832 | `ChannelRow`, `Category`, пинги и метки каналов → `layout/sidebar/`. |
| `chat/Message.tsx` | 647 / 788 | `ReactionBar` + `AddReaction`, капсула действий (`CapsuleMenu`, `MoreMenu`, `ActionBtn`), `EditBox`, `ReplyQuote` → `chat/message/`. |
| `admin/SettingField.tsx` | 473 / 592 | Контрол на вид поля (`SecretControl`, `SelectControl`, `ListControl`, `NumberControl`, `TextControl`) → `admin/controls/`. |
| `layout/Controls.tsx` | 419 / 482 | Меню устройств и порог микрофона → `layout/controls/`. |
| `stage/ServerStats.tsx`, `layout/ServerRail.tsx`, `layout/MobileNav.tsx`, `lib/voice/sfu/subscribe.ts`, `lib/voice/mesh/index.ts`, `api/gateway/registry.service.ts` | 300–355 | Проходят чек-лист code-audit; режутся, только если там найдётся вторая ответственность. |

## Готово, когда

- Файлов больше 300 строк кода — только законные исключения (каталоги,
  таблицы, фазы 2–3 до их завершения), и каждое записано в настройку
  `max-lines`.
- Функций длиннее 150 строк кода нет (`max-lines-per-function` переходит из
  предупреждения в ошибку).
- Каждый перенос — отдельный коммит с пустым поведенческим диффом;
  `turbo typecheck test build`, lint и e2e зелёные после каждого.
