// AudioWorklet-процессор для НАТИВНОГО звука демонстрации (десктоп на Windows).
//
// Зачем: в оболочке Tauri звук экрана снимается нативно (WASAPI process-loopback
// с ИСКЛЮЧЕНИЕМ процесса relay — см. clients/desktop/src-tauri/src/screen_audio.rs),
// поэтому в захват НЕ попадает то, что играет сам relay (голоса собеседников). Rust
// шлёт PCM-кадры в web-UI, lib/desktop-screen-audio.ts складывает их сюда через
// port.postMessage, а этот процессор проигрывает их ровным потоком в
// MediaStreamAudioDestinationNode → получаем настоящий MediaStreamTrack для WebRTC.
//
// Кадры приходят как Float32Array (моно, уже в частоте AudioContext). Держим
// кольцевой буфер: главный поток пишет, process() читает по 128 сэмплов на канал.
class ScreenAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // ~1 c при 48 кГц — с запасом гасит джиттер IPC, но не копит заметную задержку.
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
        // Переполнение (потребитель отстаёт) — двигаем чтение, роняем старейший
        // сэмпл. Лучше микро-провал, чем неограниченный рост задержки.
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
      // Моно-источник дублируем на все выходные каналы.
      for (let ch = 0; ch < output.length; ch++) output[ch][i] = sample;
    }
    return true; // держим процессор живым, пока узел не отключат
  }
}

registerProcessor('screen-audio-processor', ScreenAudioProcessor);
