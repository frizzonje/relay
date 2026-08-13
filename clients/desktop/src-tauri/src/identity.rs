//! Ключ личности десктопа: рождается, живёт и подписывает в Rust.
//!
//! В браузере ключ — `CryptoKey` с `extractable: false` в IndexedDB: движок
//! хранит его сам и наружу не отдаёт. В оболочке этот путь закрыт — проба
//! этапа 0 показала, что `put` записи с `CryptoKey` вешает процесс хранилища
//! WKWebView намертво, — поэтому пара живёт здесь, а webview только просит
//! подписать. Из трёх выходов (нативный ключ, сырые байты в IndexedDB,
//! Developer ID) выбран этот: байты в IndexedDB достаёт любой скрипт страницы
//! — ровно то свойство, ради которого всё затевалось; подпись приложения — это
//! $99 в год, гипотеза и ни одного вылеченного Linux.
//!
//! ## Ключ на каждый сервер, а не на приложение
//!
//! Оболочка умеет «сменить сервер», и один ключ на всё приложение означал бы,
//! что сервер A может попросить подписать нонс, взятый у сервера B, — и войти
//! под нами туда, где нас не звали. Ключ у каждого origin свой: браузер даёт
//! то же самое (IndexedDB привязана к origin), а личность в relay и так живёт
//! внутри одной инсталляции, общей её половины нет. Значит, худшее, чего
//! добьётся недобрый сервер, — подпись своим же ключом на своей же территории.
//!
//! Origin берётся у самого webview (`win.url()`), а не из тела события: то,
//! что прислала страница, — это её слова о себе.
//!
//! ## Где лежит секрет
//!
//! Системный keychain (macOS Keychain, Windows Credential Manager), а если он
//! недоступен — файл `0600` в конфиг-каталоге приложения. На Linux файл и есть
//! обычный путь: тянуть ради secret-service libdbus в AppImage и в AUR ради
//! того, что там всё равно упрётся в незапущенный демон, дороже пользы —
//! `~/.ssh/id_ed25519` лежит там ровно так же. От webview файл закрыт в любом
//! случае: страница не видит ни его, ни keychain, только ответ на «подпиши».

use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signer as _, SigningKey, SECRET_KEY_LENGTH};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tauri::{AppHandle, Emitter, Listener, Manager};

use crate::ulog;

/// Запрос web-UI и ответ ему. Пара событий вместо кастомной команды: удалённому
/// origin мы даём только `core:event` (см. capabilities/remote.json), а
/// `invoke` потребовал бы выдать ему права на команды приложения.
const REQUEST_EVENT: &str = "identity-request";
const REPLY_EVENT: &str = "identity-reply";

/// Служба в системном keychain; учётная запись внутри неё — origin сервера.
const SERVICE: &str = "app.relay.desktop identity";

/// Каталог с ключами, когда keychain недоступен (внутри `app_config_dir`).
const KEYS_DIR: &str = "identity";

#[derive(Deserialize)]
struct Request {
    /// Номер запроса; возвращаем его в ответе — по нему web-UI находит свой.
    id: String,
    /// `key` — публичная половина, `sign` — подпись `message`.
    op: String,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Reply {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    public_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    signature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Failure>,
}

/// Отказ в машинном виде: `kind` выбирает экран в web-UI, `detail` едет в лог.
/// Виды: `store` — ключ негде держать, `origin` — просит не страница сервера,
/// `engine` — подписать не вышло, `bad-request` — мост говорит не на том языке.
#[derive(Serialize, Clone, Debug)]
struct Failure {
    kind: &'static str,
    detail: String,
}

fn fail(kind: &'static str, detail: impl Into<String>) -> Failure {
    Failure {
        kind,
        detail: detail.into(),
    }
}

/// Навесить мост. Зовётся один раз из `setup()`.
pub fn wire(app: &AppHandle) {
    let handle = app.clone();
    app.listen(REQUEST_EVENT, move |event| {
        let Ok(req) = serde_json::from_str::<Request>(event.payload()) else {
            ulog("identity: непонятный запрос от web-UI");
            return;
        };
        // В отдельном потоке: keychain на macOS вправе показать модальный запрос
        // «пустить relay к ключу», и ждать его в потоке событий — это повесить
        // окно вместе с ним. Ответ уедет событием, когда бы он ни получился.
        let app = handle.clone();
        std::thread::spawn(move || {
            let reply = answer(&app, req);
            if let Some(err) = &reply.error {
                ulog(&format!("identity {}: {}", err.kind, err.detail));
            }
            let _ = app.emit(REPLY_EVENT, reply);
        });
    });
}

fn answer(app: &AppHandle, req: Request) -> Reply {
    let id = req.id.clone();
    let done = |public_key: Option<String>, signature: Option<String>| Reply {
        id: id.clone(),
        public_key,
        signature,
        error: None,
    };
    let refused = |e: Failure| Reply {
        id: id.clone(),
        public_key: None,
        signature: None,
        error: Some(e),
    };

    let origin = match origin_of(app) {
        Ok(o) => o,
        Err(e) => return refused(e),
    };
    let key = match key_for(app, &origin) {
        Ok(k) => k,
        Err(e) => return refused(e),
    };

    match req.op.as_str() {
        "key" => done(Some(public_key_of(&key)), None),
        "sign" => match req.message {
            Some(message) => done(None, Some(sign(&key, &message))),
            None => refused(fail("bad-request", "запрос подписи без сообщения")),
        },
        other => refused(fail(
            "bad-request",
            format!("неизвестная операция «{other}»"),
        )),
    }
}

/// Origin страницы, которая просит. Спрашиваем окно, а не событие: payload
/// пишет сама страница, а `url()` — движок.
fn origin_of(app: &AppHandle) -> Result<String, Failure> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| fail("origin", "окна main нет"))?;
    let url = win
        .url()
        .map_err(|e| fail("origin", format!("адрес окна не читается: {e}")))?;
    match url.origin() {
        url::Origin::Tuple(..) => Ok(url.origin().ascii_serialization()),
        // Экран выбора сервера (`tauri://localhost`) — не инсталляция, личности
        // у него нет и быть не может.
        url::Origin::Opaque(_) => Err(fail("origin", format!("непрозрачный origin: {url}"))),
    }
}

// ── Ключ ─────────────────────────────────────────────────────────────────────

fn public_key_of(key: &SigningKey) -> String {
    URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes())
}

fn sign(key: &SigningKey, message: &str) -> String {
    URL_SAFE_NO_PAD.encode(key.sign(message.as_bytes()).to_bytes())
}

fn encode_secret(key: &SigningKey) -> String {
    URL_SAFE_NO_PAD.encode(key.to_bytes())
}

fn decode_secret(raw: &str) -> Option<SigningKey> {
    let bytes = URL_SAFE_NO_PAD.decode(raw.trim()).ok()?;
    let seed: [u8; SECRET_KEY_LENGTH] = bytes.try_into().ok()?;
    Some(SigningKey::from_bytes(&seed))
}

fn generate() -> Result<SigningKey, Failure> {
    let mut seed = [0u8; SECRET_KEY_LENGTH];
    getrandom::fill(&mut seed).map_err(|e| fail("store", format!("нет случайности: {e}")))?;
    Ok(SigningKey::from_bytes(&seed))
}

/// Ключ этого устройства для этого сервера: поднять сохранённый или родить.
///
/// Железное правило порядка: новый ключ рождается ТОЛЬКО когда хранилище
/// внятно ответило «такого нет». Отказ (keychain занят, доступ не дали,
/// каталог не читается) — это отказ, а не пустота: сгенерировать на нём ключ
/// значит молча сделать человека другим человеком — с чужой лентой, чужим
/// именем и без единого способа вернуться в себя.
///
/// Кэша нет намеренно: за вход клиент спрашивает дважды (ключ и подпись), и
/// два обращения к связке дешевле, чем секрет, который лежит в памяти процесса
/// всё время работы приложения.
fn key_for(app: &AppHandle, origin: &str) -> Result<SigningKey, Failure> {
    match keychain_load(origin) {
        Ok(Some(raw)) => match decode_secret(&raw) {
            Some(key) => return Ok(key),
            // В нашей записи лежит не ключ. Той личности уже нет ни у кого —
            // остаётся честно завести новую, громко сказав об этом в лог.
            None => ulog("identity: в keychain лежит не ключ — завожу новый"),
        },
        Ok(None) => {}
        Err(e) => return Err(fail("store", format!("keychain отказал: {e}"))),
    }

    let dir = keys_dir(app).ok_or_else(|| fail("store", "нет конфиг-каталога"))?;
    match file_load(&dir, origin) {
        Ok(Some(raw)) => match decode_secret(&raw) {
            Some(key) => return Ok(key),
            None => ulog("identity: файл ключа испорчен — завожу новый"),
        },
        Ok(None) => {}
        Err(e) => return Err(fail("store", format!("файл ключа не читается: {e}"))),
    }

    let key = generate()?;
    let secret = encode_secret(&key);
    if let Err(e) = keychain_save(origin, &secret) {
        ulog(&format!("identity: keychain не взял ключ ({e}) — кладу в файл"));
        file_save(&dir, origin, &secret).map_err(|e| fail("store", e))?;
    }
    Ok(key)
}

fn keys_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(KEYS_DIR))
}

// ── Системный keychain ───────────────────────────────────────────────────────

#[cfg(any(target_os = "macos", windows))]
fn keychain_load(origin: &str) -> Result<Option<String>, String> {
    match keyring::Entry::new(SERVICE, origin)
        .map_err(|e| e.to_string())?
        .get_password()
    {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(any(target_os = "macos", windows))]
fn keychain_save(origin: &str, secret: &str) -> Result<(), String> {
    keyring::Entry::new(SERVICE, origin)
        .map_err(|e| e.to_string())?
        .set_password(secret)
        .map_err(|e| e.to_string())
}

/// Linux: системного хранилища не спрашиваем вовсе — см. заголовок модуля.
#[cfg(not(any(target_os = "macos", windows)))]
fn keychain_load(_origin: &str) -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn keychain_save(_origin: &str, _secret: &str) -> Result<(), String> {
    Err("на этой платформе ключ хранится файлом".into())
}

// ── Файл ─────────────────────────────────────────────────────────────────────

/// Имя файла — начало SHA-256 от origin. Не для секретности (каталог и так
/// виден), а чтобы адрес сервера, куда ходит человек, не был написан именем
/// файла в его домашнем каталоге.
fn file_path(dir: &Path, origin: &str) -> PathBuf {
    let digest = Sha256::digest(origin.as_bytes());
    let name: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    dir.join(format!("{name}.key"))
}

fn file_load(dir: &Path, origin: &str) -> Result<Option<String>, String> {
    match std::fs::read_to_string(file_path(dir, origin)) {
        Ok(raw) => Ok(Some(raw)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn file_save(dir: &Path, origin: &str, secret: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("создание {}: {e}", dir.display()))?;
    let file = file_path(dir, origin);
    // Права ставим ДО записи: файл, побывший читаемым для всех хоть мгновение,
    // уже не станет секретом обратно.
    #[cfg(unix)]
    {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt as _;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&file)
            .map_err(|e| format!("запись {}: {e}", file.display()))?;
        f.write_all(secret.as_bytes())
            .map_err(|e| format!("запись {}: {e}", file.display()))?;
    }
    #[cfg(not(unix))]
    std::fs::write(&file, secret).map_err(|e| format!("запись {}: {e}", file.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Verifier as _, VerifyingKey};

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("relay-identity-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn secret_survives_a_round_trip() {
        let key = generate().unwrap();
        let restored = decode_secret(&encode_secret(&key)).unwrap();
        assert_eq!(key.to_bytes(), restored.to_bytes());
        assert_eq!(public_key_of(&key), public_key_of(&restored));
    }

    #[test]
    fn garbage_is_not_a_key() {
        assert!(decode_secret("").is_none());
        assert!(decode_secret("не base64url").is_none());
        // Правильная кодировка, но не 32 байта — тоже не ключ.
        assert!(decode_secret(&URL_SAFE_NO_PAD.encode([7u8; 16])).is_none());
    }

    /// Подпись обязана сойтись у того, кто знает только публичную половину, —
    /// именно это и делает сервер (`apps/api/src/identity/crypto.ts`).
    #[test]
    fn signature_verifies_by_public_key_alone() {
        let key = generate().unwrap();
        let message = "relay-auth-v1:abc";

        let public = URL_SAFE_NO_PAD.decode(public_key_of(&key)).unwrap();
        let raw = URL_SAFE_NO_PAD.decode(sign(&key, message)).unwrap();
        assert_eq!(public.len(), 32, "публичный ключ Ed25519 — 32 байта");
        assert_eq!(raw.len(), 64, "подпись Ed25519 — 64 байта");

        let public = VerifyingKey::from_bytes(&public.try_into().unwrap()).unwrap();
        let signature = Signature::from_bytes(&raw.try_into().unwrap());
        assert!(public.verify(message.as_bytes(), &signature).is_ok());
        assert!(public.verify(b"relay-auth-v1:abd", &signature).is_err());
    }

    #[test]
    fn each_origin_gets_its_own_file() {
        let dir = tmp("names");
        let a = file_path(&dir, "https://relay.example.com");
        let b = file_path(&dir, "https://other.example.com");
        assert_ne!(a, b);
        assert_eq!(a, file_path(&dir, "https://relay.example.com"));
        // Адреса в имени файла нет.
        assert!(!a.to_string_lossy().contains("example"));
    }

    #[test]
    fn file_store_keeps_the_secret_to_itself() {
        let dir = tmp("file");
        let origin = "https://relay.example.com";
        assert!(file_load(&dir, origin).unwrap().is_none());

        let key = generate().unwrap();
        file_save(&dir, origin, &encode_secret(&key)).unwrap();

        let raw = file_load(&dir, origin).unwrap().unwrap();
        assert_eq!(decode_secret(&raw).unwrap().to_bytes(), key.to_bytes());
        // Сосед по origin остаётся без ключа — файлы не пересеклись.
        assert!(file_load(&dir, "https://other.example.com")
            .unwrap()
            .is_none());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(file_path(&dir, origin))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "ключ читается только владельцем");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
