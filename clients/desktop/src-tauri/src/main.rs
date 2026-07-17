// Не открывать лишнее консольное окно на Windows в release. Не удалять.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Собирается на Tauri 2.11 (`cargo tauri build` → .app/.dmg проверено на macOS
// arm64). Нативные фичи поверх web-UI, обмен — через события Tauri (капабилити
// удалённого UI даёт только `core:event`, без кастомных команд):
//   • Rust → webview: событие `ptt` (bool) от глобального хоткея (см. lib/desktop.ts);
//   • webview → Rust: `voice-status` ({in_call, muted}) обновляет трей,
//     `set-ptt-shortcut` (строка-акселератор) переназначает хоткей.

mod screen_audio;

use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Listener, Manager, Wry,
};
use serde_json::json;
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

/// Дефолтный PTT-хоткей. Глобальный (ловится вне фокуса окна), поэтому берём
/// клавишу, которую редко занимают глобально; фронт может сменить событием
/// `set-ptt-shortcut`. Формат — акселератор Tauri (`F8`, `CommandOrControl+Shift+K`).
const DEFAULT_PTT: &str = "F8";

/// Разделяемое состояние: текущий зарегистрированный PTT-хоткей (чтобы отличать
/// его в общем хендлере и уметь переназначить) и последний статус звонка.
#[derive(Default)]
struct AppState {
    ptt: Mutex<Option<Shortcut>>,
    /// Идёт ли уже web-проверка обновлений (события `check-updates`). Гасит
    /// дубли: мост шлёт notify=true на каждый (пере)запуск фронта, и они
    /// накладывались на ручную проверку/стартовый нативный поток — несколько
    /// `updater.check()` в одну секунду засоряли канал `update-status` и роняли
    /// события. Пока флаг взведён — новый `check-updates` просто игнорируем.
    checking: AtomicBool,
}

/// Статус звонка, приходящий из web-UI событием `voice-status`.
#[derive(serde::Deserialize)]
struct VoiceStatus {
    in_call: bool,
    muted: bool,
}

fn main() {
    // DMABUF-рендер WebKitGTK ломался на проприетарном NVIDIA до 2.46 (белое/
    // чёрное окно) — там его надо гасить. С 2.46 upstream сам отключает DMABUF
    // на проблемных драйверах, а принудительный запрет на свежих версиях (Arch
    // и прочие rolling с 2.48+) сам по себе даёт глюки софтверного пути. Поэтому
    // флаг ставим только на старом webkit и только если пользователь не задал
    // переменную сам. Версию берём из libwebkit2gtk ДО инициализации GTK —
    // webkit_get_*_version() это простые геттеры, init не требуют.
    #[cfg(target_os = "linux")]
    {
        let (maj, min) = unsafe {
            (
                webkit2gtk_sys::webkit_get_major_version(),
                webkit2gtk_sys::webkit_get_minor_version(),
            )
        };
        let forced = if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some() {
            "user"
        } else if (maj, min) < (2, 46) {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            "yes(old webkit)"
        } else {
            "no"
        };
        // Слепок окружения в лог: по нему видно, какой graphics-путь у машины
        // пользователя, когда «не работает» без единой ошибки на экране.
        let env = |k: &str| std::env::var(k).unwrap_or_else(|_| "-".into());
        ulog(&format!(
            "linux env: webkit {maj}.{min}, dmabuf-disable={forced}, session={}, wayland={}, gdk-backend={}",
            env("XDG_SESSION_TYPE"),
            env("WAYLAND_DISPLAY"),
            env("GDK_BACKEND"),
        ));
    }

    tauri::Builder::default()
        .manage(AppState::default())
        // Второй запуск не плодит процесс/окно — показываем и фокусируем текущее.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        // Обновления. Проверка идёт ДВУМЯ путями: (1) нативно из Rust при старте
        // и по пункту трея «Проверить обновления» — надёжно, без веб-моста;
        // (2) best-effort из web-настроек (события `check-updates`/`install-update`).
        // Ничего не ставится само: находим апдейт → нативный диалог «Обновить?».
        // Не Microsoft — решение и момент установки за пользователем.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        // Глобальный push-to-talk. Хоткей регистрируется в `.setup()` (дефолт) и
        // может быть переназначен фронтом. Общий хендлер отсеивает чужие
        // регистрации по сохранённому шорткату и эмитит в webview `ptt` c булевым
        // payload (true — зажат, false — отпущен). Дальше событие ловит
        // lib/desktop.ts и открывает/закрывает микрофон.
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    let is_ptt =
                        app.state::<AppState>().ptt.lock().unwrap().as_ref() == Some(shortcut);
                    if !is_ptt {
                        return;
                    }
                    let pressed = matches!(event.state(), ShortcutState::Pressed);
                    let _ = app.emit("ptt", pressed);
                })
                .build(),
        )
        .setup(|app| {
            let handle = app.handle().clone();
            build_tray(&handle)?;

            // Linux: WebKitGTK на необработанный `permission-request` отвечает
            // отказом, а wry (0.55) на webkitgtk обработчик не вешает вовсе
            // (в отличие от своих же Windows/macOS/Android-бэкендов) — из-за
            // этого getUserMedia ВСЕГДА падал с NotAllowedError («нет доступа
            // к микрофону»). Разрешаем запросы медиа-устройств сами: webview
            // показывает только сервер, который пользователь выбрал в пикере,
            // так что доступ к микрофону — его осознанный выбор (как в любом
            // десктоп-мессенджере). Прочие типы запросов не трогаем — false
            // отдаёт их дефолтному обработчику (отказ). Заодно включаем
            // enable-webrtc: RTCPeerConnection в WebKitGTK по умолчанию
            // выключен (флаг появился в 2.38), без него звонок упал бы сразу
            // после выдачи микрофона.
            #[cfg(target_os = "linux")]
            if let Some(win) = handle.get_webview_window("main") {
                let _ = win.with_webview(|webview| {
                    use webkit2gtk::glib::prelude::*;
                    use webkit2gtk::{
                        DeviceInfoPermissionRequest, PermissionRequestExt, SettingsExt,
                        UserMediaPermissionRequest, WebViewExt,
                    };
                    let wv = webview.inner();
                    if let Some(s) = WebViewExt::settings(&wv) {
                        s.set_enable_media_stream(true);
                        s.set_enable_webrtc(true);
                    }
                    wv.connect_permission_request(|_, req| {
                        let media = req.is::<UserMediaPermissionRequest>()
                            || req.is::<DeviceInfoPermissionRequest>();
                        ulog(&format!(
                            "webview permission-request {}: {}",
                            req.type_(),
                            if media { "allow" } else { "default(deny)" }
                        ));
                        if media {
                            req.allow();
                        }
                        media
                    });
                    ulog("linux webview: media permission handler installed");
                });
            }

            // Дефолтный PTT-хоткей. Если система его уже держит — молча пропускаем:
            // фронт сможет задать свой событием `set-ptt-shortcut`.
            if let Ok(sc) = Shortcut::from_str(DEFAULT_PTT) {
                if handle.global_shortcut().register(sc).is_ok() {
                    *handle.state::<AppState>().ptt.lock().unwrap() = Some(sc);
                }
            }

            // web-UI сообщает состояние звонка → перерисовываем трей.
            let h = handle.clone();
            handle.listen("voice-status", move |event| {
                if let Ok(s) = serde_json::from_str::<VoiceStatus>(event.payload()) {
                    update_tray(&h, s.in_call, s.muted);
                }
            });

            // web-UI переназначает PTT-хоткей (payload — JSON-строка акселератора).
            let h = handle.clone();
            handle.listen("set-ptt-shortcut", move |event| {
                if let Ok(acc) = serde_json::from_str::<String>(event.payload()) {
                    let _ = reassign_ptt(&h, &acc);
                }
            });

            // Демонстрация экрана: нативный захват системного звука БЕЗ голосов
            // самого relay (WASAPI process-loopback exclude на Windows; вне неё —
            // no-op). Web-UI шлёт start/stop, Rust отдаёт PCM-кадры событиями.
            let h = handle.clone();
            handle.listen("screen-audio-start", move |_event| {
                screen_audio::start(&h);
            });
            handle.listen("screen-audio-stop", move |_event| {
                screen_audio::stop();
            });

            // Обновления по запросу из web-настроек. `check-updates` ({notify})
            // только проверяет и докладывает статус (мост зовёт тихо при старте с
            // notify=true → системная подсказка, если что-то вышло). `install-update`
            // ставит и перезапускает — приходит лишь по кнопке «Установить». Так
            // пользователь сам решает, когда обновляться (см. lib/desktop.ts).
            let h = handle.clone();
            handle.listen("check-updates", move |event| {
                let notify = serde_json::from_str::<CheckArgs>(event.payload())
                    .map(|a| a.notify)
                    .unwrap_or(false);
                let app = h.clone();
                tauri::async_runtime::spawn(async move { check_updates(app, notify).await });
            });
            let h = handle.clone();
            handle.listen("install-update", move |_event| {
                let app = h.clone();
                tauri::async_runtime::spawn(async move { install_update(app).await });
            });

            // Нативная проверка обновлений при старте — НЕ зависит от web→Rust
            // моста (на удалённом origin он ненадёжен). Ждём прогрузку окна,
            // тихо проверяем; есть апдейт → нативный диалог с выбором. Если всё
            // актуально или сеть недоступна — молчим, не мешаем.
            let h = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(4)).await;
                native_update_flow(h, false).await;
            });

            Ok(())
        })
        // След навигаций webview в тот же диагностический лог: когда у
        // пользователя «сервер не грузится» молча, по паре started/finished
        // видно, дошла ли навигация до сети и чем кончилась.
        .on_page_load(|_, payload| {
            let phase = match payload.event() {
                tauri::webview::PageLoadEvent::Started => "started",
                tauri::webview::PageLoadEvent::Finished => "finished",
            };
            ulog(&format!("page load {phase}: {}", payload.url()));
        })
        .run(tauri::generate_context!())
        .expect("failed to run relay desktop");
}

/// Payload события `check-updates`: `notify=true` (тихая проверка от моста при
/// старте) разрешает системную подсказку о найденном апдейте; кнопка в настройках
/// шлёт `false` — там результат и так виден в UI.
#[derive(serde::Deserialize)]
struct CheckArgs {
    #[serde(default)]
    notify: bool,
}

/// Доложить web-UI статус обновления событием `update-status`. `state` —
/// checking | up-to-date | available | installing | error (+ version/message).
fn emit_update_status(app: &AppHandle, value: serde_json::Value) {
    let _ = app.emit("update-status", value);
}

/// Диагностический лог: строка в stderr + append в `$HOME/relay-update.log`.
/// Начинался как лог апдейтера, теперь туда же пишем окружение Linux и след
/// навигаций webview — чтобы по одному файлу с машины пользователя видеть,
/// на каком шаге всё встало (файл не переименовываем, его уже знают).
fn ulog(msg: &str) {
    eprintln!("[relay-update] {msg}");
    if let Ok(home) = std::env::var("HOME") {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(format!("{home}/relay-update.log"))
        {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let _ = writeln!(f, "{ts} {msg}");
        }
    }
}

/// Одна попытка проверки релизов с ЖЁСТКИМ таймаутом. Плагинный `.timeout()` при
/// некоторых зависаниях (IPv6-stall и т.п.) не отменяет запрос — оборачиваем
/// будущее в `tokio::time::timeout`, который гарантированно бросает его: вместо
/// вечного «Проверяю...» получаем ошибку. Возвращаем найденный `Update` (нужен
/// для загрузки) либо человекочитаемую строку ошибки.
async fn check_once(app: &AppHandle, secs: u64) -> Result<Option<tauri_plugin_updater::Update>, String> {
    let updater = match app.updater_builder().timeout(Duration::from_secs(secs)).build() {
        Ok(u) => u,
        Err(e) => {
            ulog(&format!("updater build failed: {e}"));
            return Err(e.to_string());
        }
    };
    ulog(&format!("check() start (hard timeout {secs}s)"));
    match tokio::time::timeout(Duration::from_secs(secs), updater.check()).await {
        Ok(Ok(opt)) => {
            ulog(&format!("check() ok -> {:?}", opt.as_ref().map(|u| u.version.clone())));
            Ok(opt)
        }
        Ok(Err(e)) => {
            ulog(&format!("check() error: {e}"));
            Err(e.to_string())
        }
        Err(_elapsed) => {
            ulog(&format!("check() HARD TIMEOUT after {secs}s"));
            Err(format!("нет ответа от GitHub за {secs}с (таймаут)"))
        }
    }
}

/// Проверка релизов с АВТО-РЕТРАЕМ. Раньше проверка «работала через раз, помогал
/// только перезапуск»: причина — happy-eyeballs/IPv6-stall на первом соединении,
/// а свежий процесс просто вытягивал удачный маршрут. Жёсткий таймаут превращал
/// зависание в ошибку, но НЕ давал успеха — отсюда «раз через раз». Одна повторная
/// попытка после короткой паузы (новое соединение/DNS) убирает большинство
/// осечек, не заставляя пользователя перезапускаться. Успех сразу возвращаем;
/// повторяем только транзиентную ошибку/таймаут.
async fn run_check(app: &AppHandle, secs: u64) -> Result<Option<tauri_plugin_updater::Update>, String> {
    const ATTEMPTS: u32 = 2;
    let mut last_err = String::new();
    for attempt in 1..=ATTEMPTS {
        match check_once(app, secs).await {
            Ok(opt) => return Ok(opt),
            Err(e) => {
                last_err = e;
                if attempt < ATTEMPTS {
                    ulog(&format!("check() retry {attempt}/{ATTEMPTS} after error: {last_err}"));
                    tokio::time::sleep(Duration::from_millis(1500)).await;
                }
            }
        }
    }
    Err(last_err)
}

/// Проверить релизы и доложить статус. НИЧЕГО не ставит — установка только по
/// явному `install-update`. Канал — стабильные `desktop-v*` (endpoint/pubkey в
/// tauri.conf.json → `plugins.updater`); nightly-пре-релизы сюда не попадают.
async fn check_updates(app: AppHandle, notify: bool) {
    ulog(&format!("check-updates received (notify={notify})"));
    // Коалесинг конкурентных проверок: пока одна идёт, следующий `check-updates`
    // просто пропускаем — иначе несколько `updater.check()` в одну секунду
    // засоряют канал `update-status`, а запоздавшие события роняют/перекрывают
    // друг друга. Флаг снимаем сразу после проверки (до эмита статуса).
    if app
        .state::<AppState>()
        .checking
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        ulog("check-updates skipped (already in flight)");
        return;
    }
    // ВАЖНО: фоновая/авто проверка НЕ шлёт `checking` в UI — «Проверяю…» ставит
    // только кнопка настроек локально (см. checkForUpdates в lib/desktop.ts).
    // Иначе запоздавший фоновый `checking` перекрывал уже показанный результат и
    // кнопка залипала на «Проверяю…».
    let result = run_check(&app, 20).await;
    app.state::<AppState>()
        .checking
        .store(false, Ordering::Release);
    match result {
        Ok(Some(update)) => {
            emit_update_status(&app, json!({ "state": "available", "version": update.version }));
            if notify {
                // Ненавязчиво: подсказка, а не принудительная установка.
                let _ = app
                    .notification()
                    .builder()
                    .title("Доступно обновление relay")
                    .body(format!(
                        "Версия {} — откройте Настройки, чтобы установить.",
                        update.version
                    ))
                    .show();
            }
        }
        Ok(None) => emit_update_status(&app, json!({ "state": "up-to-date" })),
        Err(msg) => emit_update_status(&app, json!({ "state": "error", "message": msg })),
    }
}

/// Скачать и установить свежий релиз, затем перезапуститься. Приходит только по
/// кнопке «Установить и перезапустить» — явное согласие пользователя.
async fn install_update(app: AppHandle) {
    ulog("install-update received");
    // Тут же качается ~3 МБ .app.tar.gz — таймаут щедрее под медленные сети.
    match run_check(&app, 120).await {
        Ok(Some(update)) => {
            emit_update_status(&app, json!({ "state": "installing", "version": update.version }));
            ulog(&format!("downloading {}", update.version));
            if let Err(e) = update.download_and_install(|_chunk, _total| {}, || {}).await {
                ulog(&format!("install failed: {e}"));
                emit_update_status(&app, json!({ "state": "error", "message": e.to_string() }));
                return;
            }
            ulog("installed, restarting");
            // На всех платформах перезапуск применяет свежую версию сразу.
            app.restart();
        }
        Ok(None) => emit_update_status(&app, json!({ "state": "up-to-date" })),
        Err(msg) => emit_update_status(&app, json!({ "state": "error", "message": msg })),
    }
}

/// Нативный сценарий обновления: проверить релизы из Rust (без web-моста) и,
/// если апдейт есть, спросить нативным диалогом «Обновить сейчас?». Согласие →
/// загрузка+установка+перезапуск (переиспользуем `install_update`). `announce`:
/// при ручном вызове (трей) сообщаем результат даже когда всё актуально или
/// проверка не удалась; при тихой стартовой проверке — молчим.
async fn native_update_flow(app: AppHandle, announce: bool) {
    ulog(&format!("native flow start (announce={announce})"));
    match run_check(&app, 30).await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            ulog(&format!("native flow: {version} available, asking user"));
            let confirmed = app
                .dialog()
                .message(format!(
                    "Доступна новая версия relay — {version}.\nУстановить сейчас? Приложение перезапустится."
                ))
                .title("Обновление relay")
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Обновить".to_string(),
                    "Позже".to_string(),
                ))
                .blocking_show();
            if confirmed {
                ulog("native flow: user confirmed → install");
                install_update(app).await;
            } else {
                ulog("native flow: user postponed");
            }
        }
        Ok(None) => {
            ulog("native flow: up-to-date");
            if announce {
                let _ = app
                    .dialog()
                    .message("У вас последняя версия relay.")
                    .title("Обновление relay")
                    .blocking_show();
            }
        }
        Err(e) => {
            ulog(&format!("native flow: check failed: {e}"));
            if announce {
                let _ = app
                    .dialog()
                    .message(format!("Не удалось проверить обновления:\n{e}"))
                    .title("Обновление relay")
                    .kind(MessageDialogKind::Error)
                    .blocking_show();
            }
        }
    }
}

/// Снять прежний PTT-хоткей и зарегистрировать новый (по акселератору из UI).
fn reassign_ptt(app: &AppHandle, accelerator: &str) -> Result<(), String> {
    let sc = Shortcut::from_str(accelerator).map_err(|e| e.to_string())?;
    let gs = app.global_shortcut();
    let state = app.state::<AppState>();
    let mut cur = state.ptt.lock().unwrap();
    if let Some(prev) = cur.take() {
        let _ = gs.unregister(prev);
    }
    gs.register(sc).map_err(|e| e.to_string())?;
    *cur = Some(sc);
    Ok(())
}

/// Человекочитаемый статус для трея.
fn status_text(in_call: bool, muted: bool) -> &'static str {
    match (in_call, muted) {
        (false, _) => "не в эфире",
        (true, true) => "в эфире · микрофон выключен",
        (true, false) => "в эфире",
    }
}

/// Меню трея: версия + статус (неактивные пункты) + разделитель + выход.
/// Версия берётся из Cargo.toml на этапе компиляции (`CARGO_PKG_VERSION`), поэтому
/// после авто-обновления в трее сразу виден новый номер — наглядная проверка, что
/// апдейт применился, без правок фронта.
fn build_menu(app: &AppHandle, in_call: bool, muted: bool) -> tauri::Result<Menu<Wry>> {
    let version = MenuItem::with_id(
        app,
        "version",
        format!("relay {}", env!("CARGO_PKG_VERSION")),
        false,
        None::<&str>,
    )?;
    let status = MenuItem::with_id(
        app,
        "status",
        status_text(in_call, muted),
        false,
        None::<&str>,
    )?;
    let check = MenuItem::with_id(app, "check-updates", "Проверить обновления", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выйти из relay", true, None::<&str>)?;
    Menu::with_items(
        app,
        &[
            &version,
            &status,
            &PredefinedMenuItem::separator(app)?,
            &check,
            &quit,
        ],
    )
}

/// Монохромный силуэт-триада для menu bar (template image). В отличие от
/// app-иконки с плашкой, здесь только чёрный знак + альфа, а macOS сам красит
/// его под тему панели (белым на тёмной, чёрным на светлой) — как у Docker и
/// прочих «прозрачных» иконок в строке меню.
const TRAY_ICON: &[u8] = include_bytes!("../icons/tray.png");

// Трей: статус звонка + выход. Иконка — template-силуэт без плашки.
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app, false, false)?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip(format!("relay — {}", status_text(false, false)))
        .icon_as_template(true)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "check-updates" => {
                // Ручная проверка из трея — нативный путь, всегда рабочий.
                // announce=true: сообщаем результат даже когда всё актуально.
                let app = app.clone();
                tauri::async_runtime::spawn(async move { native_update_flow(app, true).await });
            }
            _ => {}
        });

    if let Ok(icon) = tauri::image::Image::from_bytes(TRAY_ICON) {
        // template mode задан выше через icon_as_template(true)
        tray = tray.icon(icon);
    } else if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }

    tray.build(app)?;
    Ok(())
}

/// Перерисовать трей под новый статус: тултип, меню и (на macOS) компактный
/// индикатор в строке меню — ◉ в эфире, ◌ без звука, пусто вне звонка.
fn update_tray(app: &AppHandle, in_call: bool, muted: bool) {
    let Some(tray) = app.tray_by_id("main") else {
        return;
    };
    let _ = tray.set_tooltip(Some(format!("relay — {}", status_text(in_call, muted))));
    if let Ok(menu) = build_menu(app, in_call, muted) {
        let _ = tray.set_menu(Some(menu));
    }
    #[cfg(target_os = "macos")]
    {
        let title = match (in_call, muted) {
            (false, _) => "",
            (true, true) => "◌",
            (true, false) => "◉",
        };
        let _ = tray.set_title(Some(title));
    }
}
