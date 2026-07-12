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
use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Listener, Manager, Wry,
};
use serde_json::json;
use tauri_plugin_autostart::MacosLauncher;
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
}

/// Статус звонка, приходящий из web-UI событием `voice-status`.
#[derive(serde::Deserialize)]
struct VoiceStatus {
    in_call: bool,
    muted: bool,
}

fn main() {
    // WebKitGTK на Linux по умолчанию рендерит через DMABUF, и этот путь стабильно
    // тормозит/мигает/чернит экран на свежем графстеке (NVIDIA, новая Mesa) — по
    // этому больно бьёт AppImage на rolling-дистрибутивах вроде Arch. Софтверный
    // путь без DMABUF заметно плавнее. Ставим до инициализации webview и только
    // если пользователь не задал переменную сам.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
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
        // Обновления. Плагин даёт UpdaterExt; ничего не ставится само —
        // проверка и установка идут только по запросу из web-настроек (события
        // `check-updates` / `install-update`, см. .setup()). Не Microsoft: без
        // принудительного авто-рестарта, решение ставить — за пользователем.
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

            Ok(())
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

/// Проверить релизы и доложить статус. НИЧЕГО не ставит — установка только по
/// явному `install-update`. Канал — стабильные `desktop-v*` (endpoint/pubkey в
/// tauri.conf.json → `plugins.updater`); nightly-пре-релизы сюда не попадают.
async fn check_updates(app: AppHandle, notify: bool) {
    emit_update_status(&app, json!({ "state": "checking" }));
    let result = match app.updater() {
        Ok(u) => u.check().await,
        Err(e) => Err(e),
    };
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
        Err(e) => emit_update_status(&app, json!({ "state": "error", "message": e.to_string() })),
    }
}

/// Скачать и установить свежий релиз, затем перезапуститься. Приходит только по
/// кнопке «Установить и перезапустить» — явное согласие пользователя.
async fn install_update(app: AppHandle) {
    let result = match app.updater() {
        Ok(u) => u.check().await,
        Err(e) => Err(e),
    };
    match result {
        Ok(Some(update)) => {
            emit_update_status(&app, json!({ "state": "installing", "version": update.version }));
            if let Err(e) = update.download_and_install(|_chunk, _total| {}, || {}).await {
                emit_update_status(&app, json!({ "state": "error", "message": e.to_string() }));
                return;
            }
            // На всех платформах перезапуск применяет свежую версию сразу.
            app.restart();
        }
        Ok(None) => emit_update_status(&app, json!({ "state": "up-to-date" })),
        Err(e) => emit_update_status(&app, json!({ "state": "error", "message": e.to_string() })),
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

/// Меню трея: статус (неактивный пункт) + разделитель + выход.
fn build_menu(app: &AppHandle, in_call: bool, muted: bool) -> tauri::Result<Menu<Wry>> {
    let status = MenuItem::with_id(
        app,
        "status",
        status_text(in_call, muted),
        false,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Выйти из relay", true, None::<&str>)?;
    Menu::with_items(app, &[&status, &PredefinedMenuItem::separator(app)?, &quit])
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
        .on_menu_event(|app, event| {
            if event.id.as_ref() == "quit" {
                app.exit(0);
            }
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
