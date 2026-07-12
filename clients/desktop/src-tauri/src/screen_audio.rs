// Нативный захват звука демонстрации экрана БЕЗ голосов самого relay (Windows).
//
// Проблема: getDisplayMedia в WebView2 отдаёт системный микс, куда попадают
// голоса собеседников, играющие из динамиков ведущего. Ведущий шлёт их обратно —
// и каждый слышит сам себя. Discord этого лишён, потому что снимает звук через
// WASAPI process-loopback: захватывает системный вывод, ИСКЛЮЧАЯ своё дерево
// процессов. Делаем так же — режим PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE.
//
// ВАЖНО (в этом и была бага «слышу сам себя» даже с exclude): звук relay играет
// НЕ в процессе-хосте Tauri (relay-desktop.exe), а в аудио-процессе WebView2
// (msedgewebview2.exe). EXCLUDE_TARGET_PROCESS_TREE исключает лишь целевой PID и
// его ПОТОМКОВ. Браузер-процесс WebView2 при общем Evergreen-рантайме может быть
// НЕ потомком хоста → отдельное дерево → не исключается → его звук (голоса
// собеседников) остаётся в захвате → эхо. Поэтому исключаем дерево именно
// БРАУЗЕР-процесса WebView2 (см. find_webview_exclusion_pid), а не хоста.
//
// PCM (i16 моно, 48 кГц) уезжает в web-UI событиями Tauri:
//   • `screen-audio-format` — один раз ({ sampleRate });
//   • `screen-audio-frame`  — кадры ~20 мс, base64 от i16 LE.
// Обратно web шлёт `screen-audio-start` / `screen-audio-stop` (см. main.rs).
// Web-приёмник — apps/web/lib/desktop-screen-audio.ts.
//
// Диагностика пишется в `%TEMP%\relay-screen-audio.log` (пере­создаётся при
// старте захвата): дерево процессов WebView2, результат активации и пик уровня
// захвата — чтобы при остаточных проблемах чинить прицельно, а не вслепую.
//
// ВНИМАНИЕ: код Windows-специфичен и НЕ компилировался в CI-песочнице (нет
// Rust-тулчейна). Собирать/чинить на Windows-машине. Версионно-хрупкие места
// (windows-rs 0.58) помечены `// NOTE(win):`.

#[cfg(target_os = "windows")]
mod imp {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;

    use base64::Engine;
    use tauri::{AppHandle, Emitter};

    // Interface — для `.cast::<T>()` и доступа к `IAudioClient::IID`.
    use windows::core::{implement, Interface, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, BOOL, HANDLE, WAIT_OBJECT_0};
    use windows::Win32::Media::Audio::{
        ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
        IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
        IAudioCaptureClient, IAudioClient, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
        AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
        AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
        PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        WAVEFORMATEX,
    };
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject, INFINITE};

    // Частота и формат захвата. Process-loopback-клиент инициализируется ЗАДАННЫМ
    // форматом (GetMixFormat для него не годится) — берём 48 кГц stereo f32 и сами
    // сводим в моно i16. 48 кГц совпадёт с частотой AudioContext на приёме.
    const SAMPLE_RATE: u32 = 48_000;
    const SRC_CHANNELS: usize = 2;
    // Кадр отправки ~20 мс моно: 48000 * 0.02 = 960 сэмплов.
    const FRAME_SAMPLES: usize = (SAMPLE_RATE as usize) / 50;
    // WAVE_FORMAT_IEEE_FLOAT (mmreg.h). Константа не всегда экспортится — берём литерал.
    const WAVE_FORMAT_IEEE_FLOAT: u16 = 0x0003;
    // AUDCLNT_BUFFERFLAGS_SILENT (audioclient.h) — литералом, тип флага в
    // windows-rs версионно нестабилен (i32/newtype), а сравниваем с u32.
    const BUFFERFLAGS_SILENT: u32 = 0x2;
    // 100-нс единицы: 20 мс буфер устройства.
    const HNS_BUFFER: i64 = 200_000;

    /// Дописать строку в лог захвата (`%TEMP%\relay-screen-audio.log`). Ошибки
    /// игнорируем — диагностика не должна ронять захват.
    fn log(msg: &str) {
        use std::io::Write;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let path = std::env::temp_dir().join("relay-screen-audio.log");
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "[{ts}] {msg}");
        }
        eprintln!("[screen-audio] {msg}");
    }

    /// Очистить лог в начале сеанса — чтобы читать только текущий запуск.
    fn log_reset() {
        let path = std::env::temp_dir().join("relay-screen-audio.log");
        let _ = std::fs::write(&path, b"");
    }

    /// Живой сеанс захвата: флаг остановки + поток. Один на приложение.
    struct Session {
        stop: Arc<AtomicBool>,
        handle: JoinHandle<()>,
    }

    static SESSION: Mutex<Option<Session>> = Mutex::new(None);

    /// Обработчик завершения ActivateAudioInterfaceAsync: сигналит Win32-событие,
    /// которого ждёт поток захвата. Держит event-HANDLE (владение — у потока).
    #[implement(IActivateAudioInterfaceCompletionHandler)]
    struct CompletionHandler {
        event: HANDLE,
    }

    impl IActivateAudioInterfaceCompletionHandler_Impl for CompletionHandler_Impl {
        // windows-rs 0.58 генерирует аргумент как `Option<&T>`.
        fn ActivateCompleted(
            &self,
            _operation: Option<&IActivateAudioInterfaceAsyncOperation>,
        ) -> windows::core::Result<()> {
            unsafe {
                let _ = SetEvent(self.event);
            }
            Ok(())
        }
    }

    /// Байт-совместимый аналог PROPVARIANT с полезной нагрузкой BLOB. Собираем
    /// сами и передаём как `*const PROPVARIANT` — так обходим версионную возню с
    /// внутренним представлением PROPVARIANT в windows-rs. Раскладка x64:
    /// vt(2)+3×reserved(6) = 8, затем cbSize(4)+pad(4)+pBlobData(8).
    #[repr(C)]
    struct PropVariantBlob {
        vt: u16,
        w_reserved1: u16,
        w_reserved2: u16,
        w_reserved3: u16,
        cb_size: u32,
        _pad: u32,
        p_blob_data: *mut u8,
    }
    const VT_BLOB: u16 = 65; // wtypes.h

    /// Снимок процессов: (pid, parent_pid, имя_exe_в_нижнем_регистре).
    fn enumerate_processes() -> Vec<(u32, u32, String)> {
        let mut out = Vec::new();
        unsafe {
            let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
                Ok(h) => h,
                Err(_) => return out,
            };
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            if Process32FirstW(snapshot, &mut entry).is_ok() {
                loop {
                    let len = entry
                        .szExeFile
                        .iter()
                        .position(|&c| c == 0)
                        .unwrap_or(entry.szExeFile.len());
                    let name = String::from_utf16_lossy(&entry.szExeFile[..len]).to_lowercase();
                    out.push((entry.th32ProcessID, entry.th32ParentProcessID, name));
                    if Process32NextW(snapshot, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snapshot);
        }
        out
    }

    /// Найти PID, чьё ДЕРЕВО процессов надо исключить из захвата. Правильная цель —
    /// браузер-процесс WebView2 (в нём/его потомках играет звук relay), а НЕ хост
    /// Tauri: при общем Evergreen-рантайме браузер-процесс может быть не потомком
    /// хоста, и exclude(хост) его не заденет → эхо. Логика:
    ///   1) собираем все msedgewebview2.exe;
    ///   2) берём тот, что реально относится к нам (потомок нашего PID), иначе —
    ///      первый попавшийся;
    ///   3) поднимаемся до ВЕРХНЕГО webview2-предка (это и есть браузер-процесс)
    ///      и исключаем его дерево.
    /// Фолбэк — наш собственный PID, если WebView2 не нашёлся.
    fn find_webview_exclusion_pid(our_pid: u32) -> u32 {
        let procs = enumerate_processes();
        let parent_of = |pid: u32| -> Option<u32> {
            procs.iter().find(|(p, _, _)| *p == pid).map(|(_, pp, _)| *pp)
        };
        let name_of = |pid: u32| -> String {
            procs
                .iter()
                .find(|(p, _, _)| *p == pid)
                .map(|(_, _, n)| n.clone())
                .unwrap_or_default()
        };
        let is_webview = |pid: u32| -> bool { name_of(pid) == "msedgewebview2.exe" };
        let is_descendant_of = |mut pid: u32, ancestor: u32| -> bool {
            for _ in 0..64 {
                match parent_of(pid) {
                    Some(pp) if pp == ancestor => return true,
                    Some(pp) if pp == 0 || pp == pid => return false,
                    Some(pp) => pid = pp,
                    None => return false,
                }
            }
            false
        };

        let webview: Vec<u32> = procs
            .iter()
            .filter(|(_, _, name)| name == "msedgewebview2.exe")
            .map(|(pid, _, _)| *pid)
            .collect();

        log(&format!(
            "processes total={}, msedgewebview2.exe count={}",
            procs.len(),
            webview.len()
        ));
        for pid in &webview {
            let pp = parent_of(*pid).unwrap_or(0);
            log(&format!(
                "  webview2 pid={pid} parent_pid={pp} parent_name={} ours={}",
                name_of(pp),
                is_descendant_of(*pid, our_pid)
            ));
        }

        if webview.is_empty() {
            log(&format!(
                "no msedgewebview2.exe found — falling back to our own pid={our_pid}"
            ));
            return our_pid;
        }

        // Предпочитаем webview-процесс, который является нашим потомком.
        let seed = webview
            .iter()
            .copied()
            .find(|p| is_descendant_of(*p, our_pid))
            .unwrap_or(webview[0]);

        // Поднимаемся до верхнего webview2-предка — это браузер-процесс.
        let mut root = seed;
        for _ in 0..64 {
            match parent_of(root) {
                Some(pp) if is_webview(pp) => root = pp,
                _ => break,
            }
        }
        log(&format!(
            "excluding WebView2 browser tree: root_pid={root} (seed={seed}, our_pid={our_pid})"
        ));
        root
    }

    /// Запустить захват (идемпотентно: второй вызов игнорируется).
    pub fn start(app: &AppHandle) {
        let mut guard = SESSION.lock().unwrap();
        if guard.is_some() {
            return;
        }
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        let app = app.clone();
        let handle = std::thread::spawn(move || {
            if let Err(e) = capture_loop(&app, &stop_thread) {
                log(&format!("capture failed: {e:?}"));
            }
        });
        *guard = Some(Session { stop, handle });
    }

    /// Остановить захват и дождаться завершения потока.
    pub fn stop() {
        let session = SESSION.lock().unwrap().take();
        if let Some(s) = session {
            s.stop.store(true, Ordering::SeqCst);
            let _ = s.handle.join();
        }
    }

    /// Активировать IAudioClient в режиме process-loopback c ИСКЛЮЧЕНИЕМ дерева
    /// процессов по PID (передаём браузер-процесс WebView2 — см. выше).
    unsafe fn activate_loopback_client(pid: u32) -> windows::core::Result<IAudioClient> {
        let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: pid,
                    ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
                },
            },
        };

        let prop = PropVariantBlob {
            vt: VT_BLOB,
            w_reserved1: 0,
            w_reserved2: 0,
            w_reserved3: 0,
            cb_size: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
            _pad: 0,
            p_blob_data: &mut params as *mut _ as *mut u8,
        };

        // Событие завершения асинхронной активации (manual-reset, unsignaled).
        let event = CreateEventW(None, BOOL(1), BOOL(0), PCWSTR::null())?;
        let handler: IActivateAudioInterfaceCompletionHandler = CompletionHandler { event }.into();

        // NOTE(win): 3-й аргумент — `Option<*const PROPVARIANT>`; кастим свой blob.
        let op: IActivateAudioInterfaceAsyncOperation = ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&prop as *const _ as *const _),
            &handler,
        )?;

        // Ждём коллбэка и забираем результат.
        if WaitForSingleObject(event, INFINITE) != WAIT_OBJECT_0 {
            let _ = CloseHandle(event);
            return Err(windows::core::Error::from_win32());
        }
        let _ = CloseHandle(event);

        let mut activate_hr = windows::core::HRESULT(0);
        let mut unknown = None;
        op.GetActivateResult(&mut activate_hr, &mut unknown)?;
        log(&format!("GetActivateResult hr=0x{:08x}", activate_hr.0));
        activate_hr.ok()?;
        let unknown = unknown.ok_or_else(windows::core::Error::from_win32)?;
        unknown.cast::<IAudioClient>()
    }

    fn capture_loop(app: &AppHandle, stop: &AtomicBool) -> windows::core::Result<()> {
        unsafe {
            // COM в MTA (коллбэк активации приходит на потоке пула). S_FALSE (уже
            // инициализировано) — не ошибка.
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

            log_reset();
            let our_pid = std::process::id();
            log(&format!("capture_loop start, our_pid={our_pid}"));

            let exclude_pid = find_webview_exclusion_pid(our_pid);
            let audio_client = match activate_loopback_client(exclude_pid) {
                Ok(c) => c,
                Err(e) => {
                    log(&format!("activation FAILED: {e:?}"));
                    return Err(e);
                }
            };
            log("activation OK — got IAudioClient");

            // Формат захвата — задаём явно (48 кГц, stereo, f32).
            let wfx = WAVEFORMATEX {
                wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
                nChannels: SRC_CHANNELS as u16,
                nSamplesPerSec: SAMPLE_RATE,
                nAvgBytesPerSec: SAMPLE_RATE * (SRC_CHANNELS as u32) * 4,
                nBlockAlign: (SRC_CHANNELS as u16) * 4,
                wBitsPerSample: 32,
                cbSize: 0,
            };

            audio_client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK,
                HNS_BUFFER,
                0,
                &wfx,
                None,
            )?;

            let capture: IAudioCaptureClient = audio_client.GetService()?;
            audio_client.Start()?;
            log("capture started");

            // Сообщаем web-UI частоту дискретизации → он строит граф под неё.
            let _ = app.emit(
                "screen-audio-format",
                serde_json::json!({ "sampleRate": SAMPLE_RATE }),
            );

            let mut mono: Vec<i16> = Vec::with_capacity(FRAME_SAMPLES * 2);
            // Диагностика уровня: сколько кадров отдали и пик за интервал. Пик ≈ 0
            // при говорящих собеседниках = relay корректно исключён (эха нет);
            // высокий пик, когда играет только relay = всё ещё ловим себя.
            let mut emitted: u64 = 0;
            let mut interval_peak: u16 = 0;

            while !stop.load(Ordering::SeqCst) {
                let mut packet = capture.GetNextPacketSize()?;
                if packet == 0 {
                    // Тишины/данных пока нет — спим, чтобы не крутить CPU.
                    std::thread::sleep(std::time::Duration::from_millis(5));
                    continue;
                }
                while packet != 0 {
                    let mut data: *mut u8 = std::ptr::null_mut();
                    let mut frames: u32 = 0;
                    let mut flags: u32 = 0;
                    capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;

                    let n = frames as usize;
                    let silent = (flags & BUFFERFLAGS_SILENT) != 0;
                    if silent || data.is_null() {
                        // Пакет тишины: буфер могут не заполнять — гоним нули.
                        for _ in 0..n {
                            mono.push(0);
                        }
                    } else {
                        let samples =
                            std::slice::from_raw_parts(data as *const f32, n * SRC_CHANNELS);
                        for f in 0..n {
                            let l = samples[f * SRC_CHANNELS];
                            let r = samples[f * SRC_CHANNELS + 1];
                            let m = ((l + r) * 0.5).clamp(-1.0, 1.0);
                            mono.push((m * 32767.0) as i16);
                        }
                    }
                    capture.ReleaseBuffer(frames)?;

                    // Флашим накопленное кадрами ~20 мс.
                    while mono.len() >= FRAME_SAMPLES {
                        let chunk: Vec<i16> = mono.drain(..FRAME_SAMPLES).collect();
                        let peak = chunk.iter().map(|s| s.unsigned_abs()).max().unwrap_or(0);
                        if peak > interval_peak {
                            interval_peak = peak;
                        }
                        emitted += 1;
                        // ~250 кадров ≈ 5 с: сообщаем, что звук течёт и его уровень.
                        if emitted % 250 == 0 {
                            log(&format!(
                                "emitted={emitted} frames, interval_peak(i16)={interval_peak}"
                            ));
                            interval_peak = 0;
                        }
                        emit_frame(app, &chunk);
                    }

                    packet = capture.GetNextPacketSize()?;
                }
            }

            let _ = audio_client.Stop();
            log(&format!("capture stopped, total_emitted={emitted}"));
        }
        Ok(())
    }

    /// i16 → little-endian bytes → base64 → событие `screen-audio-frame`.
    fn emit_frame(app: &AppHandle, samples: &[i16]) {
        let mut bytes = Vec::with_capacity(samples.len() * 2);
        for s in samples {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let _ = app.emit("screen-audio-frame", b64);
    }
}

// На не-Windows нативного process-loopback нет — заглушки, чтобы сборка
// (в т.ч. macOS) оставалась зелёной. macOS-путь (ScreenCaptureKit) — отдельная
// задача; там демонстрация звука пока идёт через web/getDisplayMedia.
#[cfg(not(target_os = "windows"))]
mod imp {
    use tauri::AppHandle;
    pub fn start(_app: &AppHandle) {}
    pub fn stop() {}
}

pub use imp::{start, stop};
