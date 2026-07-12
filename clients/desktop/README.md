# relay desktop (Windows / Linux / macOS) — Tauri v2

Нативная оболочка над существующим web-клиентом: Rust-ядро + системный webview
(WebView2 на Windows, WebKitGTK на Linux, WKWebView на macOS). WebRTC и весь UI
приходят из webview бесплатно — десктоп-клиент не реализует протокол сам,
а добавляет то, чего нет у браузера:

- окно/трей/автостарт, глобальный хоткей push-to-talk / mute;
- бейдж непрочитанного, нативные уведомления;
- автообновление (tauri-plugin-updater), установщики: MSI/NSIS (Windows),
  AppImage/deb/rpm (Linux), dmg (macOS).

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
- webview → Rust: `voice-status` (`{in_call, muted}`) для трея,
  `set-ptt-shortcut` (строка-акселератор) для смены хоткея.

Web-сторона моста — [`apps/web/lib/desktop.ts`](../../apps/web/lib/desktop.ts)
(вне Tauri — no-op). `remote.urls` сейчас wildcard (адрес сервера вводит
пользователь); для конкретного деплоя сузить до своего origin.

Адрес сервера задаётся пользователем при первом запуске (маленький Rust-экран
или конфиг) — приложение не привязано к одному домену.

## Что в каталоге (каркас)

```
clients/desktop/
  src/                 локальный экран выбора сервера (единственная «своя» страница)
    index.html         карточка «адрес инсталляции» в токенах relay
    main.js            запоминает origin → уводит webview на web-UI
  src-tauri/
    Cargo.toml         Tauri v2 + плагины (single-instance, global-shortcut,
                       notification, autostart)
    build.rs
    tauri.conf.json    productName relay, окно 1280×788 min 960×600, url=index.html
    src/main.rs        плагины + трей (статус звонка + «Выйти») + глобальный
                       PTT-хоткей → событие `ptt`, приём `voice-status`/`set-ptt-shortcut`
    capabilities/default.json  права локального окна (server-picker)
    capabilities/remote.json   права удалённого web-UI: только core:event
    icons/           знак relay (mesh-триада): icon.svg + сгенерённый набор
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

## Готово (нативная связка)

- ✅ **Проброс PTT-хоткея в UI.** Глобальный хоткей (дефолт `F8`) регистрируется
  в Rust; хендлер эмитит `ptt` → `lib/desktop.ts` слушает и открывает/закрывает
  микрофон через `desktopPtt` в `lib/voice.ts` (только в режиме Push-to-talk,
  общий флаг удержания с пробелом). Смена хоткея — событие `set-ptt-shortcut`.
- ✅ **Трей-статусы.** Пункт статуса «не в эфире / в эфире / в эфире · микрофон
  выключен» + тултип, на macOS — компактный индикатор в строке меню (◉/◌).
  web-UI шлёт `voice-status` при смене канала/mute. Пункт «Выйти» на месте.

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

Web-часть покрыта e2e монорепо. Десктоп-специфику (хоткей, трей) — руками на
каждой платформе перед релизом; смок «окно открылось и залогинилось» можно
гонять tauri-driver'ом (WebDriver) позже.
