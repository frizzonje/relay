// JS-шим, вставляемый в webview на Linux при старте. Подменяет getUserMedia и
// enumerateDevices для аудио: вместо браузерного WebRTC (который в WebKitGTK без
// звука) микрофон захватывается нативно (PulseAudio/PipeWire → cpal в Rust) и
// подаётся в webview через AudioWorklet.
//
// Код делится на две части:
//   1. PROCESSOR_CODE — код AudioWorklet-процессора (кольцевой буфер PCM-сэмплов)
//   2. SHIM_CODE — код главного потока (подмена API, IPC с Rust, построение графа)
//
// Исполняется ДО скриптов страницы (UserScriptInjectionTime::Start), поэтому
// перехватывает getUserMedia/enumerateDevices раньше, чем их вызовет web-UI.

/// Код AudioWorklet-процессора: принимает PCM (Float32Array) через port.postMessage,
/// складывает в кольцевой буфер и выдаёт в process(). Полный аналог
/// public/screen-audio-worklet.js, но для микрофона (моно).
#[cfg(target_os = "linux")]
pub const PROCESSOR_CODE: &str = r##"
class NativeMicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = 48000;
    this.buffer = new Float32Array(this.capacity);
    this.read = 0;
    this.write = 0;
    this.size = 0;
    this.port.onmessage = (e) => {
      const chunk = e.data;
      if (!(chunk instanceof Float32Array)) return;
      this.push(chunk);
    };
  }

  push(chunk) {
    for (let i = 0; i < chunk.length; i++) {
      if (this.size === this.capacity) {
        this.read = (this.read + 1) % this.capacity;
        this.size--;
      }
      this.buffer[this.write] = chunk[i];
      this.write = (this.write + 1) % this.capacity;
      this.size++;
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const frames = output[0]?.length ?? 128;
    for (let i = 0; i < frames; i++) {
      const sample = this.size > 0 ? this.buffer[this.read] : 0;
      if (this.size > 0) {
        this.read = (this.read + 1) % this.capacity;
        this.size--;
      }
      for (let ch = 0; ch < output.length; ch++) output[ch][i] = sample;
    }
    return true;
  }
}
registerProcessor('native-mic-processor', NativeMicProcessor);
"##;

/// JS-шим главного потока. Вставляется в top-level frame ДО скриптов страницы.
#[cfg(target_os = "linux")]
pub const SHIM_CODE: &str = r##"
(function() {
  if (typeof window === 'undefined') return;
  // Не внедряемся дважды
  if (window.__nativeAudioShim) return;
  window.__nativeAudioShim = true;

  // Ждём Tauri-мост — он появляется чуть позже (не на UserScriptInjectionTime::Start).
  // Но нам нужен __TAURI__ для событий. Без моста — просто не трогаем API.
  function tauri() {
    var t = window.__TAURI__;
    return t ? t.event : null;
  }

  // Живой сеанс захвата
  var micCtx = null;
  var micWorklet = null;
  var micDest = null;
  var micDeviceId = null;
  var micUnlisten = [];
  var micActive = false;
  var micCurrentStream = null; // поток, которому принадлежит ТЕКУЩАЯ дорожка микрофона

  // Кеш устройств (от Rust)
  var nativeDevices = null;

  // При уходе со страницы — глушим захват (иначе микрофон висит открытым)
  window.addEventListener('beforeunload', function() {
    if (micActive) stopCapture();
  });

  // base64(i16 LE моно) → Float32Array в диапазоне [-1, 1]
  function decodeFrame(b64) {
    var bin = atob(b64);
    var len = bin.length;
    var out = new Float32Array(len >> 1);
    for (var i = 0, j = 0; i + 1 < len; i += 2, j++) {
      var lo = bin.charCodeAt(i);
      var hi = bin.charCodeAt(i + 1);
      var s = (hi << 8) | lo;
      if (s >= 0x8000) s -= 0x10000;
      out[j] = s / 32768;
    }
    return out;
  }

  // Построить или перестроить граф захвата (AudioContext + AudioWorklet)
  function buildGraph(sampleRate, resolve, reject) {
    try { teardownGraph(); } catch(e) {}
    try {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      micCtx = new Ctor({ sampleRate: sampleRate });

      // Worklet-код уже вставлен Rust'ом отдельным скриптом или будет загружен ниже.
      // Но здесь мы не можем await addModule через blob URL — AudioContext ещё не
      // прикручен к DOM. Используем тот же подход, что и screen-audio: загружаем модуль
      // по blob URL.
      var blob = new Blob([window.__nativeMicProcessorCode || ''], { type: 'application/javascript' });
      var url = URL.createObjectURL(blob);
      micCtx.audioWorklet.addModule(url).then(function() {
        URL.revokeObjectURL(url);
        micWorklet = new AudioWorkletNode(micCtx, 'native-mic-processor');
        micDest = micCtx.createMediaStreamDestination();
        micWorklet.connect(micDest);
        if (micCtx.state === 'suspended') micCtx.resume();
        resolve(micDest.stream);
      }).catch(function(err) {
        console.warn('[native-audio] AudioWorklet load failed:', err);
        teardownGraph();
        reject(err);
      });
    } catch(err) {
      teardownGraph();
      reject(err);
    }
  }

  function teardownGraph() {
    try { micWorklet && micWorklet.disconnect(); } catch(e) {}
    try { micDest && micDest.disconnect(); } catch(e) {}
    try { micCtx && micCtx.state !== 'closed' && micCtx.close(); } catch(e) {}
    micWorklet = null;
    micDest = null;
    micCtx = null;
  }

  // Отписаться от событий Rust
  function unlistenAll() {
    for (var i = 0; i < micUnlisten.length; i++) {
      try { micUnlisten[i](); } catch(e) {}
    }
    micUnlisten = [];
  }

  // Остановить нативный захват
  function stopCapture() {
    var ev = tauri();
    micActive = false;
    micCurrentStream = null;
    if (ev) { ev.emit('native-audio-stop').catch(function(){}); }
    unlistenAll();
    teardownGraph();
  }

  // Запустить нативный захват → возвращает Promise<MediaStream>
  function startCapture(deviceId) {
    var ev = tauri();
    if (!ev) return Promise.reject(new Error('no tauri bridge'));

    stopCapture();
    micDeviceId = deviceId || null;

    return new Promise(function(resolve, reject) {
      var settled = false;

      var onFormat = function(e) {
        if (settled || micCtx) return;
        // Rust мог ответить ошибкой — микрофон не найден / занят / нет прав.
        if (e.payload && e.payload.error) {
          reject(new Error(e.payload.error));
          return;
        }
        var sr = e.payload && e.payload.sampleRate ? e.payload.sampleRate : 48000;

        // Проверим, что код процессора есть (Rust вставил его перед шимом)
        if (!window.__nativeMicProcessorCode) {
          reject(new Error('no processor code injected'));
          return;
        }

        buildGraph(sr, function(stream) {
          if (settled) return;
          settled = true;
          micActive = true;
          resolve(stream);
        }, function(err) {
          if (settled) return;
          settled = true;
          stopCapture();
          reject(err);
        });
      };

      var onFrame = function(e) {
        if (!micWorklet || typeof e.payload !== 'string') return;
        var pcm = decodeFrame(e.payload);
        micWorklet.port.postMessage(pcm, [pcm.buffer]);
      };

      // Регистрируем слушателей ДО отправки команды Rust'у — иначе
      // listen() асинхронный и ответ может прийти раньше регистрации.
      Promise.all([
        ev.listen('native-audio-format', onFormat),
        ev.listen('native-audio-frame', onFrame)
      ]).then(function(results) {
        micUnlisten = [results[0], results[1]];
        // Просим Rust начать захват — теперь слушатели гарантированно на месте.
        ev.emit('native-audio-start', { device: micDeviceId }).catch(reject);
      }).catch(reject);

      // Таймаут 5 с — если Rust не ответил форматом, микрофон не поднялся
      setTimeout(function() {
        if (!settled) {
          settled = true;
          stopCapture();
          reject(new Error('native audio format timeout'));
        }
      }, 5000);
    });
  }

  // Запросить список устройств у Rust (кешируем)
  function refreshDevices() {
    var ev = tauri();
    if (!ev) return Promise.resolve(null);
    return new Promise(function(resolve) {
      var unlisten = null;
      var settled = false;
      var timer = setTimeout(function() {
        if (!settled) { settled = true; if (unlisten) unlisten(); resolve(null); }
      }, 3000);

      ev.listen('native-audio-devices', function(e) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (unlisten) unlisten();
        nativeDevices = Array.isArray(e.payload) ? e.payload : null;
        resolve(nativeDevices);
      }).then(function(u) {
        unlisten = function() { u(); };
        if (settled) unlisten();
      });

      ev.emit('native-audio-devices-get');
    });
  }

  // ─── Подмена getUserMedia ──────────────────────────────────────────
  var origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = function(constraints) {
    // Только в Tauri и только для аудио-запросов без видео
    if (!tauri()) return origGetUserMedia(constraints);
    var hasAudio = !!(constraints && constraints.audio);
    var hasVideo = !!(constraints && constraints.video);
    if (!hasAudio || hasVideo) {
      // Видео (или без аудио) — родной getUserMedia
      return origGetUserMedia(constraints);
    }

    // Аудио-only → нативный захват
    var deviceId = null;
    if (constraints && constraints.audio && typeof constraints.audio === 'object') {
      if (constraints.audio.deviceId) {
        var d = constraints.audio.deviceId;
        deviceId = typeof d === 'object' && d.exact ? d.exact : d;
      }
    }

    return startCapture(deviceId).then(function(stream) {
      // Запоминаем поток: когда дорожка завершится (track.stop() или unload),
      // останавливаем захват. Сверяем с micCurrentStream, чтобы setMic (замена
      // микрофона) не убила новый захват остановкой старой дорожки.
      micCurrentStream = stream;
      var tracks = stream.getAudioTracks();
      var onEnded = function() {
        // Останавливаем захват, только если завершилась дорожка ТЕКУЩЕГО потока.
        if (micCurrentStream === stream) {
          stopCapture();
        }
      };
      for (var i = 0; i < tracks.length; i++) {
        var track = tracks[i];
        track.addEventListener('ended', onEnded);
        // voice.ts/refreshMicInfo читает label и getSettings().deviceId
        // чтобы показать название активного микрофона в настройках.
        // MediaStreamAudioDestinationNode-трек даёт пустой label и не
        // содержит deviceId — подменяем их на имя устройства cpal.
        try {
          Object.defineProperty(track, 'label', {
            get: function() { return micDeviceId || 'Default Microphone'; },
            configurable: true
          });
        } catch(e) { /* read-only property, ignore */ }
        try {
          var origSettings = track.getSettings.bind(track);
          track.getSettings = function() {
            var s = origSettings();
            if (micDeviceId) s.deviceId = micDeviceId;
            return s;
          };
        } catch(e) { /* ignore */ }
      }
      return stream;
    });
  };

  // ─── Подмена enumerateDevices ─────────────────────────────────────
  var origEnumerateDevices = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
  navigator.mediaDevices.enumerateDevices = function() {
    return origEnumerateDevices().then(function(browserDevices) {
      // Убираем браузерные аудиовходы (в WebKitGTK они нерабочие или пустые)
      var videoOnly = [];
      for (var i = 0; i < browserDevices.length; i++) {
        if (browserDevices[i].kind !== 'audioinput') videoOnly.push(browserDevices[i]);
      }
      // Добавляем нативные микрофоны
      if (nativeDevices && nativeDevices.length > 0) {
        return videoOnly.concat(nativeDevices);
      }
      // Если ещё не получили — запрашиваем и ждём
      return refreshDevices().then(function(nd) {
        if (nd && nd.length > 0) return videoOnly.concat(nd);
        return videoOnly;
      });
    }).catch(function() {
      // enumerateDevices отказал — пробуем хотя бы нативные
      return refreshDevices().then(function(nd) {
        return nd || [];
      }).catch(function() {
        return [];
      });
    });
  };

  // ─── Предзапрос устройств при старте ─────────────────────────────
  // К моменту загрузки Tauri-мост уже есть — запрашиваем устройства сразу,
  // чтобы enumerateDevices не ждал первый раз.
  if (tauri()) {
    refreshDevices();
  }
})();
"##;

/// Полифил RTCPeerConnection: в WebKitGTK на Linux RTCPeerConnection отсутствует
/// (сборка с -DENABLE_WEB_RTC=OFF). Подменяем его на мост к Rust webrtc-rs:
/// создание пиров, SDP-обмен, ICE — всё идёт через webrtc_linux.rs → события Tauri.
/// Вставляется ДО скриптов страницы, чтобы voice-support.ts увидел рабочий
/// RTCPeerConnection с createOffer.
#[cfg(target_os = "linux")]
pub const RTC_POLYFILL_CODE: &str = r##"
(function() {
  if (typeof window === 'undefined') return;
  // Не перезаписываем, если браузерный RTCPeerConnection есть
  if (window.RTCPeerConnection && typeof window.RTCPeerConnection.prototype.createOffer === 'function') return;

  var ev = window.__TAURI__ && window.__TAURI__.event;
  if (!ev) return; // нет Tauri-моста — полифил не нужен

  var pcCounter = 0;
  // Карта pcId → Promise-резолверы для ожидающих операций
  var pending = {};

  // Слушаем ответы Rust'а один раз на всё окно
  ev.listen('webrtc:offer-ready', function(e) {
    var p = pending['offer-' + e.payload.pcId];
    if (p) { delete pending['offer-' + e.payload.pcId]; p.resolve(e.payload); }
  }).catch(function(){});
  ev.listen('webrtc:answer-ready', function(e) {
    var p = pending['answer-' + e.payload.pcId];
    if (p) { delete pending['answer-' + e.payload.pcId]; p.resolve(e.payload); }
  }).catch(function(){});
  ev.listen('webrtc:ice-candidate', function(e) {
    var pcId = e.payload.pcId;
    var pcs = window.__rpcPolyfillPcs;
    if (!pcs || !pcs[pcId]) return;
    var pc = pcs[pcId];
    if (pc.onicecandidate) {
      pc.onicecandidate({ candidate: e.payload.candidate, sdpMid: e.payload.sdpMid, sdpMLineIndex: e.payload.sdpMlineIndex });
    }
  }).catch(function(){});
  ev.listen('webrtc:connection-state', function(e) {
    var pcId = e.payload.pcId;
    var pcs = window.__rpcPolyfillPcs;
    if (!pcs || !pcs[pcId]) return;
    var pc = pcs[pcId];
    pc._connectionState = e.payload.state || 'new';
    if (pc.onconnectionstatechange) pc.onconnectionstatechange();
  }).catch(function(){});
  ev.listen('webrtc:track', function(e) {
    var pcId = e.payload.pcId;
    var pcs = window.__rpcPolyfillPcs;
    if (!pcs || !pcs[pcId]) return;
    var pc = pcs[pcId];
    if (pc.ontrack) {
      pc.ontrack({ track: null, streams: [], transceiver: null });
    }
  }).catch(function(){});
  ev.listen('webrtc:negotiation-needed', function(e) {
    var pcId = e.payload.pcId;
    var pcs = window.__rpcPolyfillPcs;
    if (!pcs || !pcs[pcId]) return;
    var pc = pcs[pcId];
    if (pc.onnegotiationneeded) pc.onnegotiationneeded();
  }).catch(function(){});

  window.__rpcPolyfillPcs = window.__rpcPolyfillPcs || {};

  function RTCIceCandidate(candidateInitDict) {
    this.candidate = candidateInitDict.candidate || '';
    this.sdpMid = candidateInitDict.sdpMid || null;
    this.sdpMLineIndex = candidateInitDict.sdpMLineIndex !== undefined ? candidateInitDict.sdpMLineIndex : null;
  }

  function RTCPeerConnection(config) {
    var self = this;
    var pcId = 'pc-' + (++pcCounter);
    self._pcId = pcId;
    window.__rpcPolyfillPcs[pcId] = self;

    self._connectionState = 'new';
    self._iceConnectionState = 'new';
    self._signalingState = 'stable';
    self._closed = false;

    self.onnegotiationneeded = null;
    self.onicecandidate = null;
    self.ontrack = null;
    self.onconnectionstatechange = null;
    self.oniceconnectionstatechange = null;

    // Создаём пир в Rust
    ev.emit('webrtc:create', {
      pcId: pcId,
      iceServers: (config && config.iceServers) || [],
      iceTransportPolicy: (config && config.iceTransportPolicy) || 'all'
    }).catch(function(){});
  }

  // Доступные для чтения свойства
  Object.defineProperty(RTCPeerConnection.prototype, 'connectionState', {
    get: function() { return this._connectionState; }
  });
  Object.defineProperty(RTCPeerConnection.prototype, 'iceConnectionState', {
    get: function() { return this._iceConnectionState; }
  });
  Object.defineProperty(RTCPeerConnection.prototype, 'signalingState', {
    get: function() { return this._signalingState; }
  });

  // Promise-помощник: emit + ждём ответный event
  function request(pcId, cmd, payload) {
    return new Promise(function(resolve, reject) {
      var key = cmd + '-' + pcId;
      pending[key] = { resolve: resolve, reject: reject };
      ev.emit('webrtc:' + cmd, payload || { pcId: pcId }).catch(reject);
      // Таймаут 30с — если Rust не ответил
      setTimeout(function() {
        if (pending[key]) { delete pending[key]; reject(new Error('webrtc timeout')); }
      }, 30000);
    });
  }

  RTCPeerConnection.prototype.createOffer = function(options) {
    var self = this;
    if (self._closed) return Promise.reject(new Error('connection closed'));
    self._signalingState = 'have-local-offer';
    return request(self._pcId, 'offer').then(function(result) {
      return { type: result.type, sdp: result.sdp };
    });
  };

  RTCPeerConnection.prototype.createAnswer = function(options) {
    var self = this;
    if (self._closed) return Promise.reject(new Error('connection closed'));
    self._signalingState = 'have-local-pranswer';
    return request(self._pcId, 'answer').then(function(result) {
      return { type: result.type, sdp: result.sdp };
    });
  };

  RTCPeerConnection.prototype.setLocalDescription = function(sessionDescription) {
    var self = this;
    if (self._closed) return Promise.reject(new Error('connection closed'));
    self._localDescription = sessionDescription;
    self._signalingState = sessionDescription && sessionDescription.type === 'offer' ? 'have-local-offer' : 'stable';
    return Promise.resolve();
  };

  RTCPeerConnection.prototype.setRemoteDescription = function(sessionDescription) {
    var self = this;
    if (self._closed) return Promise.reject(new Error('connection closed'));
    self._remoteDescription = sessionDescription;
    self._signalingState = sessionDescription && sessionDescription.type === 'offer' ? 'have-remote-offer' : 'stable';
    // Отправляем в Rust для настоящей обработки SDP
    ev.emit('webrtc:set-remote', {
      pcId: self._pcId,
      type: sessionDescription.type,
      sdp: sessionDescription.sdp
    }).catch(function(){});
    return Promise.resolve();
  };

  RTCPeerConnection.prototype.addIceCandidate = function(candidate) {
    var self = this;
    if (self._closed) return Promise.reject(new Error('connection closed'));
    if (candidate && candidate.candidate) {
      ev.emit('webrtc:add-ice', {
        pcId: self._pcId,
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid || null,
        sdpMLineIndex: candidate.sdpMLineIndex
      }).catch(function(){});
    }
    return Promise.resolve();
  };

  RTCPeerConnection.prototype.addTrack = function(track, stream) {
    var self = this;
    if (self._closed) throw new Error('connection closed');
    ev.emit('webrtc:add-track', { pcId: self._pcId, kind: track ? track.kind : 'audio' }).catch(function(){});
    var sender = {
      track: track || null,
      replaceTrack: function(newTrack) { sender.track = newTrack; return Promise.resolve(); },
      setParameters: function(params) { return Promise.resolve(); },
      getParameters: function() { return { encodings: [{}], codecs: [] }; }
    };
    return sender;
  };

  RTCPeerConnection.prototype.removeTrack = function(sender) {
    return Promise.resolve();
  };

  RTCPeerConnection.prototype.close = function() {
    var self = this;
    if (self._closed) return;
    self._closed = true;
    self._connectionState = 'closed';
    ev.emit('webrtc:close', { pcId: self._pcId }).catch(function(){});
    delete window.__rpcPolyfillPcs[self._pcId];
    Object.keys(pending).forEach(function(k) {
      if (pending[k] && k.indexOf(self._pcId) >= 0) {
        try { pending[k].reject(new Error('connection closed')); } catch(e) {}
        delete pending[k];
      }
    });
  };

  RTCPeerConnection.prototype.restartIce = function() {
    // no-op for now
  };

  RTCPeerConnection.prototype.getStats = function(selector) {
    return Promise.resolve(new Map());
  };

  RTCPeerConnection.prototype.getSenders = function() {
    return [];
  };

  RTCPeerConnection.prototype.getReceivers = function() {
    return [];
  };

  RTCPeerConnection.prototype.getTransceivers = function() {
    return [];
  };

  RTCPeerConnection.prototype.addTransceiver = function(trackOrKind, init) {
    return { mid: '0', sender: { track: null }, receiver: { track: null }, direction: 'sendrecv' };
  };

  // Экспортируем в window
  window.RTCPeerConnection = RTCPeerConnection;
  window.RTCIceCandidate = window.RTCIceCandidate || RTCIceCandidate;
  // RTCSessionDescription для обратной совместимости
  if (!window.RTCSessionDescription) {
    window.RTCSessionDescription = function(init) { this.type = init.type; this.sdp = init.sdp; };
  }
})();
"##;

// На не-Linux шим не нужен — getUserMedia работает через браузер.
#[cfg(not(target_os = "linux"))]
pub const PROCESSOR_CODE: &str = "";
#[cfg(not(target_os = "linux"))]
pub const SHIM_CODE: &str = "";
#[cfg(not(target_os = "linux"))]
pub const RTC_POLYFILL_CODE: &str = "";
