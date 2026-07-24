# relay desktop (Windows / Linux / macOS) — Tauri v2

Нативная оболочка над существующим web-клиентом: Rust-ядро + системный webview
(WebView2 на Windows, WebKitGTK на Linux, WKWebView на macOS). WebRTC и весь UI
приходят из webview бесплатно — десктоп-клиент не реализует протокол сам,
а добавляет то, чего нет у браузера:

- окно/трей, автозапуск при входе в систему, назначаемый глобальный хоткей
  push-to-talk;
- бейдж непрочитанного, нативные уведомления;
- автообновление (tauri-plugin-updater), установщики: MSI/NSIS (Windows),
  AppImage/deb/rpm (Linux), dmg (macOS); Arch Linux — через AUR
  ([packaging/arch](packaging/arch)).

## Архитектура

Окно грузит **URL инсталляции** (self-hosted, как site-specific browser):
`tauri.conf.json → app.windows[0].url = "https://<ваш-домен>"`. Кука `relay_pass`
живёт в webview, логин — та же страница `/login`. Фронт при этом не форкается:
любой деплой web = обновление UI десктопа.

IPC (Rust ↔ удалённая страница) — только для нативных фич и только через
**события Tauri** (не кастомные команды): включён `withGlobalTauri`, а удалённому
origin капабилити [`remote.json`](src-tauri/capabilities/remote.json) даёт ровно
`core:event`. Направления:

- Rust → webview: `ptt` (bool) — глобальный хоткей нажат/отпущен;
  `desktop-settings` — состояние настроек оболочки (см. ниже);
- webview → Rust: `voice-status` (`{in_call, muted}`) для трея,
  `desktop-settings-get` — запрос настроек, `set-ptt-shortcut` (комбинация или
  `null`) — смена хоткея, `set-autostart` (bool) — автозапуск,
  `switch-server` — возврат на экран выбора сервера.

> **Грабли: порт в `remote.urls`.** Список URL там матчится по `URLPattern`, где
> **пустой порт значит только порт по умолчанию**. Из-за этого `http://*/*` не
> покрывает ни `http://localhost:8080`, ни `https://relay.example.com:8443` —
> нужен явный `*`: `http://*:*/*`. Origin вне списка не получает `core:event`,
> и `listen`/`emit` отклоняются. Снаружи это выглядит обманчиво: `__TAURI__` в
> окне есть (его инжектит `withGlobalTauri`), `isDesktop` в web-UI = `true`,
> кнопки на месте — но события не ходят ни в одну сторону, нативные настройки не
> появляются, а «Проверить обновления» висит до сторожевого таймера. Мост теперь
> пишет причину в консоль webview вместо того, чтобы молча сдаться.

### Настройки оболочки

Хоткей и автозапуск живут в Rust — `settings.json` в `app_config_dir`
(`~/Library/Application Support/app.relay.desktop` и аналоги), см.
[`settings.rs`](src-tauri/src/settings.rs). Не в localStorage web-UI, потому что
localStorage привязан к origin (после «Сменить сервер» настройки бы потерялись),
а глобальный хоткей нужно поднять ещё до загрузки web-UI — который может не
загрузиться вовсе.

Протокол ровно один: web шлёт `desktop-settings-get` (при инициализации моста и
при открытии настроек), Rust отвечает `desktop-settings`. **Ответ — он же признак
поддержки**: клиенты до 0.4.0 промолчат, и web-UI просто не покажет эти блоки, а
не нарисует тумблеры, которые ничего не переключают.

- **PTT-хоткей.** Комбинации в формате веб-хоткеев (`Ctrl+Shift+KeyT` —
  `event.code`, раскладко-независимо, см. [lib/hotkeys.ts](../../apps/web/lib/hotkeys.ts));
  в акселератор Tauri их переводит `to_accelerator` (`Meta` → `Super`). Проверяет
  и регистрирует только Rust — лишь он знает, удалось ли занять клавишу в
  системе; неудача **откатывается** на прежнюю комбинацию и возвращается текстом
  в `pttError`. По умолчанию `F8`, `null` — пользователь выключил хоткей
  (отличать `null` от «поля нет» обязательно, иначе апгрейд с 0.3.x молча снял бы
  PTT всем).
- **Автозапуск.** Выключен по умолчанию, включается только тумблером. Запись
  регистрируется с аргументом `--hidden`: при входе в систему окно не
  открывается, relay садится в трей (достать — пункт «Открыть relay»). В
  dev-сборке регистрация запрещена — иначе в автозагрузку попал бы бинарь из
  `target/debug`. При старте запись сверяется с текущим путём приложения и
  перерегистрируется, если оно переехало (перенесённый AppImage, `.app` из
  Downloads в Applications). В UI показывается ФАКТИЧЕСКОЕ состояние
  (`is_enabled()`), а не сохранённое: автозапуск могли снять средствами системы.

При запуске с `--hidden` окно прячется в `setup()`; обычный запуск не трогаем
вовсе. Обратный вариант (`visible: false` в конфиге + показывать окно из
`setup()`) убрал бы кратковременную вспышку окна при входе в систему, но тогда
ЛЮБОЙ запуск зависел бы от этой строчки: не сработала — клиент без интерфейса.
Цена ошибки несимметрична, поэтому вспышку оставили осознанно — вернуться к
этому можно после живой проверки автозапуска на всех трёх ОС.

Web-сторона моста — [`apps/web/lib/desktop.ts`](../../apps/web/lib/desktop.ts)
(вне Tauri — no-op). `remote.urls` сейчас wildcard (адрес сервера вводит
пользователь); для конкретного деплоя сузить до своего origin.

Адрес сервера задаётся пользователем при первом запуске (маленький Rust-экран
или конфиг) — приложение не привязано к одному домену.

## Что в каталоге (каркас)

```
clients/desktop/
  src/                 локальный экран выбора сервера (единственная «своя» страница)
    index.html         карточка «адрес инсталляции» + недавние серверы
    main.js            автопереход на последний сервер, список недавних,
                       нормализация адреса → уводит webview на web-UI
  src-tauri/
    Cargo.toml         Tauri v2 + плагины (single-instance, global-shortcut,
                       notification, autostart)
    build.rs
    tauri.conf.json    productName relay, окно 1280×788 min 960×600, url=index.html
    src/main.rs        плагины + трей (статус звонка, «Открыть relay», «Сменить
                       сервер…», «Выйти») + глобальный PTT-хоткей → событие `ptt`,
                       приём `voice-status` / `desktop-settings-get` /
                       `set-ptt-shortcut` / `set-autostart` / `switch-server`
    src/settings.rs    настройки оболочки (PTT-хоткей, автозапуск) + их файл
    capabilities/default.json  права локального окна (server-picker)
    capabilities/remote.json   права удалённого web-UI: только core:event
    icons/           знак relay (mesh-триада): icon.svg + сгенерённый набор
  packaging/
    arch/            AUR PKGBUILD-ы (relay-desktop-bin / relay-desktop) +
                     release.sh (бамп версии/чек-сумм) — см. packaging/arch/README.md
```

> ✅ **Собирается на двух платформах.**
> - **macOS arm64** (Tauri 2.11): `cargo tauri build` → `relay.app` + `relay_0.1.0.dmg`,
>   приложение стартует и закрывается чисто.
> - **Linux arm64**: `cargo tauri build --bundles deb` в `rust:1-bookworm` (Docker)
>   → `relay_0.1.0_arm64.deb` (1.9 МБ), корректный пакет — `/usr/bin/relay-desktop`
>   (ELF aarch64), `.desktop`-лаунчер, hicolor-иконки, зависимости
>   `libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1`.
>
> Иконки закоммичены — CI/сборка работают без предварительных шагов.
> Windows-инсталляторы (MSI/NSIS) собираются только на Windows-раннере — из CI
> ([desktop.yml](../../.github/workflows/desktop.yml), job `windows-latest`).

## Запуск

```bash
# требования: Rust stable + системные deps
#   Windows: WebView2 (есть в Win11), MSVC Build Tools
#   Linux:   libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
#   macOS:   Xcode Command Line Tools
cargo install tauri-cli --version '^2.0'      # даёт `cargo tauri`
cd clients/desktop
cargo tauri dev                                # dev-окно с экраном выбора сервера
```

Полный бандл (`cargo tauri build`) собирает `.app`/`.dmg` (macOS),
`.msi`/NSIS (Windows), `.AppImage`/`.deb` (Linux) — иконки уже в репозитории.

## Arch Linux (AUR)

tauri-bundler не умеет в pacman-пакеты, а Arch-юзер ждёт `paru -S`, а не
скачивания тарбола из релиза. Поэтому клиент под Arch раздаётся идиоматично —
**PKGBUILD-ами в AUR**, каноном которых служат рецепты в
[`packaging/arch`](packaging/arch) (версионируются вместе с кодом, на релизе
копируются в AUR-репозитории). Два пакета по стандартной AUR-схеме:

- **`relay-desktop-bin`** — репак официального `relay_<ver>_amd64.deb` из релиза
  (ставится за секунды, Rust не нужен);
- **`relay-desktop`** — сборка из тега системным тулчейном (Node/pnpm не нужны:
  `frontendDist` статичен и впекается в бинарь, `cargo build` — и всё).

CI линтит оба рецепта в arch-контейнере (`namcap` + проверка, что `.SRCINFO`
парсится) — job `arch` в [`desktop.yml`](../../.github/workflows/desktop.yml).
Бамп версии/чек-сумм и публикация — `packaging/arch/release.sh` и
[packaging/arch/README.md](packaging/arch/README.md).

## Готово (нативная связка)

- ✅ **Проброс PTT-хоткея в UI.** Глобальный хоткей (дефолт `F8`) регистрируется
  в Rust; хендлер эмитит `ptt` → `lib/desktop.ts` слушает и открывает/закрывает
  микрофон через `desktopPtt` в `lib/voice.ts` (только в режиме Push-to-talk,
  общий флаг удержания с пробелом).
- ✅ **Хоткей назначается из настроек.** Строка «Push-to-talk (глобально)» во
  вкладке «Горячие клавиши» — тот же рекордер клавиш, что и у остальных
  действий. Занятую комбинацию оболочка не принимает и говорит почему; клавиша
  без модификатора помечается предупреждением (она перехватывается во всех
  программах). Крестик выключает хоткей совсем.
- ✅ **Автозапуск.** Тумблер во вкладке «Приложение» (по умолчанию выключен) —
  relay стартует свёрнутым в трей.
- ✅ **Трей-статусы.** Пункт статуса «не в эфире / в эфире / в эфире · микрофон
  выключен» + тултип, на macOS — компактный индикатор в строке меню (◉/◌).
  web-UI шлёт `voice-status` при смене канала/mute. Плюс «Открыть relay»
  (единственная дорога к окну после запуска из автозапуска), «Сменить сервер…»
  и «Выйти».
- ✅ **Клиент возвращается на свой сервер.** Пикер при старте сам уходит на
  последний адрес, показывая карточку «Возвращаемся на ваш сервер» с кнопкой
  «Отмена» на время проверки доступности; сервер не отвечает — остаёмся на
  экране выбора с причиной. Ниже — список недавних адресов (до пяти, крестик
  убирает; убрали последний — автопереход выключается). Свежая установка никуда
  сама не уходит: автопереход берёт только адрес, к которому уже подключались.
  Пункт трея «Сменить сервер…» открывает пикер с `#pick` и автопереход глушит —
  иначе экран уходил бы обратно, и адрес было бы не сменить.

## Обновления

Подключено (`tauri-plugin-updater`), но **без принудительного авто-рестарта** —
решение обновляться за пользователем (не Microsoft). При старте оболочка тихо
проверяет релизы и, если что-то вышло, показывает ненавязчивое системное
уведомление. Установка — только по кнопке **«Проверить обновления»** →
**«Установить и перезапустить»** в Настройках. Ходить на GitHub и качать руками
не нужно.

- **Канал** — стабильные релизы `desktop-v*` (endpoint
  `…/releases/latest/download/latest.json`; `nightly`-пре-релизы апдейтер
  игнорирует, `/releases/latest/` отдаёт только не-prerelease).
- **Логика** — целиком в Rust ([`main.rs`](src-tauri/src/main.rs),
  `check_updates` / `install_update`); удалённому web-UI JS-API апдейтера НЕ
  даём — обмен только событиями Tauri (`check-updates` / `install-update` →
  `update-status`), как PTT/трей. Web-сторона — кнопка в
  [`SettingsDialog.tsx`](../../apps/web/components/layout/SettingsDialog.tsx) +
  [`lib/desktop.ts`](../../apps/web/lib/desktop.ts) +
  [`stores/desktop.ts`](../../apps/web/stores/desktop.ts) (вне Tauri блок скрыт).
- **Ключи** — `plugins.updater.pubkey` в
  [`tauri.conf.json`](src-tauri/tauri.conf.json) уже прописан; приватный ключ
  подписи CI берёт из секрета.

### Единственный ручной шаг: секрет подписи в GitHub

Без приватного ключа CI соберёт установщики, но не подпишет `latest.json` — и
апдейтер их отвергнет. Добавь в **Settings → Secrets and variables → Actions**:

- `TAURI_SIGNING_PRIVATE_KEY` — содержимое приватного ключа (файл
  `relay-updater.key`, сгенерён `cargo tauri signer generate`);
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — пароль ключа (у текущего он пустой,
  секрет можно завести с пустым значением или не заводить).

Воркфлоу [`desktop.yml`](../../.github/workflows/desktop.yml) эти секреты уже
прокидывает в `tauri-action` — больше ничего менять не нужно.

### Как выкатить обновление

1. Подними версию в [`tauri.conf.json`](src-tauri/tauri.conf.json) (`version`) и
   в [`Cargo.toml`](src-tauri/Cargo.toml) — из неё формируется `latest.json`.
2. Тег `desktop-v<версия>` (напр. `desktop-v0.1.1`) → пуш. CI соберёт 4 ОС,
   подпишет и зальёт в стабильный релиз + `latest.json`.
3. Установленные клиенты подхватят апдейт при следующем запуске.

## Осталось доделать

1. **Живая проверка нативной связки** на реальном деплое: PTT-хоткей вне фокуса
   переключает микрофон в звонке, трей меняет статус. Локально проверены сборка
   (`cargo build`), старт без паники (трей + регистрация хоткея + слушатели) и
   типы/линт web-моста; полный путь событий требует задеплоенного web-UI и звонка.
2. **Живая проверка настроек оболочки** (после деплоя web-UI с этими блоками):
   - назначить PTT на свою комбинацию → она работает вне фокуса окна и остаётся
     после перезапуска; занять комбинацию, уже занятую системой → в настройках
     появляется причина, а прежний хоткей продолжает работать;
   - включить автозапуск → перелогиниться: relay поднялся свёрнутым, окно
     достаётся пунктом трея «Открыть relay», модалка обновления при этом не
     выпрыгивает (вместо неё системное уведомление); выключить автозапуск →
     запись из автозагрузки исчезла. Проверить на Windows и Linux отдельно:
     реализации автозапуска там разные (реестр / `~/.config/autostart`).
   - Экран выбора сервера прогнан на всех путях (автопереход, отмена, `#pick`,
     недавние, битые адреса, гонка «обогнали другой попыткой») в браузере; в
     живом webview проверен только удачный автопереход. Осталось руками:
     `#pick` из трея и отмена автоперехода внутри самой оболочки.

## Проверка

- **macOS arm64** — `cargo tauri build` → `relay.app` + `.dmg`, приложение
  стартует (окно с выбором сервера) и закрывается без ошибок.
- **Linux arm64** — воспроизводимо в Docker без локального тулчейна:

  ```bash
  docker run --rm -v "$PWD":/mono -w /mono/clients/desktop rust:1-bookworm bash -c '
    apt-get update -qq && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
      librsvg2-dev libxdo-dev build-essential curl ca-certificates >/dev/null
    curl -L --proto "=https" -sSf \
      https://raw.githubusercontent.com/cargo-bins/cargo-binstall/main/install-from-binstall-release.sh | bash
    cargo binstall -y tauri-cli
    cargo tauri build --bundles deb'
  # → src-tauri/target/release/bundle/deb/relay_0.1.0_arm64.deb (проверено dpkg-deb)
  ```

- **Windows** — MSI/NSIS собираются только на Windows; гоняются из CI
  ([desktop.yml](../../.github/workflows/desktop.yml)).
- **Смок 0.4.0 (macOS)** — `cargo tauri dev` с чужим `identifier` (чтобы не
  спорить с установленным клиентом за single-instance): в логе
  `start (hidden=false)` → `ptt registered: Some("F8")` → автопереход пикера на
  сохранённый сервер → `check-updates` от УЖЕ задеплоенного (старого) web-UI
  отработал как раньше, `check() ok` — т.е. мост и автообновление совместимы со
  старым фронтом, а `desktop-settings` он не запрашивает, и блоки настроек
  просто не появляются.
- **Мост** — `apps/web/lib/desktop.test.ts` (vitest): имена событий и форма
  payload'ов, включая `null` как «выключить хоткей» и молчание вне Tauri.
  Формат комбинаций и разбор `settings.json` — юнит-тесты в `settings.rs`.

Web-часть покрыта e2e монорепо. Десктоп-специфику (хоткей, трей) — руками на
каждой платформе перед релизом; смок «окно открылось и залогинилось» можно
гонять tauri-driver'ом (WebDriver) позже.
