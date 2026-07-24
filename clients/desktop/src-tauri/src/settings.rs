//! Настройки самой оболочки: глобальный PTT-хоткей и автозапуск.
//!
//! Живут в Rust, а не в localStorage web-UI, по двум причинам:
//!   • localStorage привязан к origin — после «Сменить сервер» настройки бы
//!     потерялись, хотя это настройки приложения, а не инсталляции;
//!   • хоткей нужно зарегистрировать ДО того, как web-UI загрузится (а он может
//!     не загрузиться вовсе — сервер лежит, сети нет).
//!
//! Файл — `settings.json` в конфиг-каталоге приложения (`app_config_dir`):
//! `~/Library/Application Support/app.relay.desktop` (macOS),
//! `%APPDATA%\app.relay.desktop` (Windows), `~/.config/app.relay.desktop` (Linux).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Дефолтный PTT-хоткей. Глобальный (ловится вне фокуса окна), поэтому берём
/// клавишу, которую редко занимают глобально. Формат — тот же, что у веб-хоткеев
/// (`stores/hotkeys.ts`): `Ctrl+Alt+Shift+Meta+<event.code>`; для одиночной
/// функциональной клавиши он совпадает с акселератором Tauri.
pub const DEFAULT_PTT: &str = "F8";

fn default_ptt() -> Option<String> {
    Some(DEFAULT_PTT.to_string())
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Settings {
    /// Комбинация глобального push-to-talk. `null` в файле — пользователь
    /// хоткей ВЫКЛЮЧИЛ; поля нет вовсе (файл от старой версии или первый
    /// запуск) — берём [`DEFAULT_PTT`]. Различать эти два случая обязательно:
    /// иначе апгрейд с 0.3.x молча отключил бы PTT всем.
    #[serde(default = "default_ptt")]
    pub ptt: Option<String>,
    /// Запускать при входе в систему. Всегда false, пока пользователь сам не
    /// включит тумблер в настройках — сюда ничего не попадает «само».
    #[serde(default)]
    pub autostart: bool,
    /// Путь, под которым автозапуск был зарегистрирован. Нужен, чтобы поймать
    /// переезд приложения (перемещённый AppImage, .app из Downloads в
    /// Applications): запись в автозапуске осталась бы указывать в пустоту.
    #[serde(default)]
    pub autostart_path: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            ptt: default_ptt(),
            autostart: false,
            autostart_path: None,
        }
    }
}

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("нет конфиг-каталога: {e}"))?;
    Ok(dir.join("settings.json"))
}

impl Settings {
    /// Прочитать настройки. Любая беда (нет файла, битый JSON, нет прав) — это
    /// дефолты, а не отказ стартовать: без настроек клиент обязан работать.
    /// Причину пишем в лог вызывающей стороны через возвращаемый текст.
    pub fn load(app: &AppHandle) -> (Self, Option<String>) {
        let file = match path(app) {
            Ok(p) => p,
            Err(e) => return (Self::default(), Some(e)),
        };
        let raw = match std::fs::read_to_string(&file) {
            Ok(s) => s,
            // Файла нет — обычный первый запуск, не ошибка.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (Self::default(), None),
            Err(e) => {
                return (
                    Self::default(),
                    Some(format!("чтение {}: {e}", file.display())),
                )
            }
        };
        match serde_json::from_str::<Self>(&raw) {
            Ok(s) => (s, None),
            Err(e) => (
                Self::default(),
                Some(format!("битый {}: {e}", file.display())),
            ),
        }
    }

    /// Записать настройки атомарно: сначала во временный файл, потом rename.
    /// Обрыв на середине не оставит обрезанный JSON, из-за которого при
    /// следующем старте слетели бы и хоткей, и автозапуск.
    pub fn save(&self, app: &AppHandle) -> Result<(), String> {
        let file = path(app)?;
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("создание {}: {e}", dir.display()))?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        let tmp = file.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| format!("запись {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, &file).map_err(|e| format!("замена {}: {e}", file.display()))?;
        Ok(())
    }
}

/// Комбинация web-формата → акселератор Tauri. Форматы совпадают (`event.code`
/// вроде `KeyM`/`F8`/`Space` парсер global-hotkey понимает как есть), кроме
/// модификатора: web зовёт его `Meta`, парсер ждёт `Super`.
pub fn to_accelerator(combo: &str) -> String {
    combo
        .split('+')
        .map(|t| {
            if t.trim().eq_ignore_ascii_case("meta") {
                "Super"
            } else {
                t.trim()
            }
        })
        .collect::<Vec<_>>()
        .join("+")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meta_becomes_super() {
        assert_eq!(to_accelerator("Ctrl+Shift+KeyM"), "Ctrl+Shift+KeyM");
        assert_eq!(to_accelerator("Meta+KeyK"), "Super+KeyK");
        assert_eq!(to_accelerator("F8"), "F8");
    }

    #[test]
    fn missing_ptt_field_falls_back_to_default() {
        // Файл от версии без настроек PTT: хоткей обязан остаться дефолтным.
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(s.ptt.as_deref(), Some(DEFAULT_PTT));
        assert!(!s.autostart);
        // Явный null — пользователь выключил хоткей, дефолт возвращать нельзя.
        let off: Settings = serde_json::from_str(r#"{"ptt":null}"#).unwrap();
        assert_eq!(off.ptt, None);
    }
}
