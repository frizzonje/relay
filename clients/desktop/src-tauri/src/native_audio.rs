// Нативный захват микрофона на Linux (PulseAudio/PipeWire через cpal) и его
// передача в web-UI для WebRTC.
//
// Проблема: системный WebKitGTK на Linux собирается без аудио-поддержки WebRTC —
// getUserMedia({audio:true}) либо падает, либо возвращает немую дорожку. Поэтому
// на Linux захват микрофона делаем нативно, а в webview подменяем getUserMedia на
// нашу реализацию (через инжектированный JS-шим — см. native_audio_shim.rs).
//
// Архитектура — та же, что у screen_audio.rs:
//   • PCM-кадры (i16 моно, 48 кГц) → base64 → событие Tauri `native-audio-frame`
//   • web-UI принимает их в AudioWorklet, гонит через MediaStreamAudioDestinationNode
//     → получается настоящий MediaStreamTrack, который дальше идёт в WebRTC
//     (RTCPeerConnection.addTrack) — в точности как в lib/desktop-screen-audio.ts
//   • `native-audio-format` ({ sampleRate }) — один раз при старте захвата
//   • `native-audio-devices` — ответ на запрос `native-audio-devices-get` от шима
//
// Управление:
//   • web → Rust: `native-audio-start`  ({ device? }) — начать захват
//   • web → Rust: `native-audio-stop`   — остановить захват
//   • web → Rust: `native-audio-devices-get` — запрос списка устройств

#[cfg(target_os = "linux")]
mod imp {
    use std::sync::mpsc;
    use std::sync::Mutex;

    use base64::Engine;
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use serde::Serialize;
    use tauri::{AppHandle, Emitter};

    /// Информация об аудиоустройстве — wire-формат для события `native-audio-devices`.
    #[derive(Serialize, Clone)]
    struct AudioDeviceInfo {
        #[serde(rename = "deviceId")]
        device_id: String,
        label: String,
        kind: String,
    }

    /// Канал остановки текущего сеанса. cpal::Stream не Send/Sync, поэтому держим его
    /// в отдельном потоке, а снаружи управляем через mpsc.
    static STOP_TX: Mutex<Option<mpsc::Sender<()>>> = Mutex::new(None);

    /// Перебрать звуковые устройства ввода и отдать их шиму.
    pub fn enumerate(app: &AppHandle) {
        let host = cpal::default_host();
        let devices: Vec<AudioDeviceInfo> = match host.input_devices() {
            Ok(iter) => iter
                .filter_map(|d| {
                    let name = d.name().unwrap_or_else(|_| "Unknown device".into());
                    Some(AudioDeviceInfo {
                        device_id: name.clone(),
                        label: name,
                        kind: "audioinput".into(),
                    })
                })
                .collect(),
            Err(_) => vec![],
        };
        let _ = app.emit("native-audio-devices", &devices);
    }

    /// Остановить текущий захват (если идёт).
    fn stop_inner() {
        if let Some(tx) = STOP_TX.lock().unwrap().take() {
            let _ = tx.send(());
        }
    }

    /// Запустить захват микрофона. `device_name` — имя устройства cpal (None = по умолчанию).
    pub fn start(app: &AppHandle, device_name: Option<String>) {
        stop_inner();

        let host = cpal::default_host();
        let device = match &device_name {
            Some(name) => host
                .input_devices()
                .ok()
                .and_then(|mut iter| iter.find(|d| d.name().ok().as_ref() == Some(name))),
            None => host.default_input_device(),
        };

        let device = match device {
            Some(d) => d,
            None => {
                let msg = "микрофон не найден";
                eprintln!("[native-audio] {msg}");
                let _ = app.emit("native-audio-format", serde_json::json!({ "error": msg }));
                return;
            }
        };

        let dev_config = match device.default_input_config() {
            Ok(c) => c,
            Err(e) => {
                let msg = format!("конфиг устройства: {e}");
                eprintln!("[native-audio] {msg}");
                let _ = app.emit("native-audio-format", serde_json::json!({ "error": msg }));
                return;
            }
        };

        let device_label = device_name
            .clone()
            .unwrap_or_else(|| device.name().unwrap_or_else(|_| "default".into()));
        let channels = dev_config.channels() as usize;
        let sample_rate = dev_config.sample_rate().0;
        eprintln!(
            "[native-audio] захват: device={device_label}, rate={sample_rate}, ch={channels}"
        );

        // Сообщаем JS фактическую частоту дискретизации — он построит AudioContext под неё.
        let _ = app.emit(
            "native-audio-format",
            serde_json::json!({ "sampleRate": sample_rate }),
        );

        let (tx, rx) = mpsc::channel();
        *STOP_TX.lock().unwrap() = Some(tx);

        let app = app.clone();

        let stream_config = dev_config.config();

        // Перечислим все доступные устройства в лог — для диагностики «почему микрофон не работает».
        if let Ok(devs) = host.input_devices() {
            for d in devs {
                let name = d.name().unwrap_or_else(|_| "?".into());
                let cfg = d.default_input_config().map(|c| format!("{c:?}")).unwrap_or_else(|e| e.to_string());
                eprintln!("[native-audio] found device: {name} → {cfg}");
            }
        }

        // cpal::Stream не Send — строим и держим его в выделенном потоке.
        let app_err = app.clone();
        std::thread::spawn(move || {
            // Используем i16 (S16_LE) — родной формат ALSA, не требует
            // преобразования каналов (pcm_route), которое ломается на многих картах.
            let stream = match device.build_input_stream(
                &stream_config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    let mono: Vec<i16> = if channels == 1 {
                        data.to_vec()
                    } else {
                        data.chunks(channels)
                            .map(|chunk| {
                                let sum: i32 = chunk.iter().map(|&s| s as i32).sum::<i32>();
                                (sum / chunk.len() as i32) as i16
                            })
                            .collect()
                    };
                    let bytes: Vec<u8> = mono.iter().flat_map(|s| s.to_le_bytes()).collect();
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    let _ = app.emit("native-audio-frame", b64);
                },
                move |err| {
                    eprintln!("[native-audio] ошибка захвата: {err}");
                },
                None,
            ) {
                Ok(s) => s,
                Err(e) => {
                    let msg = format!("не удалось открыть поток: {e}");
                    eprintln!("[native-audio] {msg}");
                    let _ = app_err.emit("native-audio-format", serde_json::json!({ "error": msg }));
                    return;
                }
            };

            if let Err(e) = stream.play() {
                let msg = format!("не удалось запустить поток: {e}");
                eprintln!("[native-audio] {msg}");
                let _ = app_err.emit("native-audio-format", serde_json::json!({ "error": msg }));
                return;
            }

            // Блокируемся до сигнала остановки.
            let _ = rx.recv();
            // stream дропнется здесь — захват остановится.
        });
    }

    /// Остановить захват (публичная точка входа).
    pub fn stop() {
        stop_inner();
    }
}

// На не-Linux — заглушки, чтобы сборка на macOS/Windows оставалась зелёной.
#[cfg(not(target_os = "linux"))]
mod imp {
    use tauri::AppHandle;
    pub fn enumerate(_app: &AppHandle) {}
    pub fn start(_app: &AppHandle, _device_name: Option<String>) {}
    pub fn stop() {}
}

pub use imp::{enumerate, start, stop};
