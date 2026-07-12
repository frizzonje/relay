#!/usr/bin/env python3
"""Генератор UI-звуков relay.

Оригинальные короткие сигналы эфира (join/leave/peer/error/reconnect/connLost),
синтезируются процедурно — только stdlib. Сигнальная цепь:

  аддитивный синтез (парциалы колокол/малет + unison-detune)
    + короткий шумовой транзиент атаки  →  HPF 110 Гц  →  LPF  →  tanh-сатурация
    →  стерео-реверб Шрёдера с pre-delay  →  нормализация + фейд.

Звуки авторские (CC0). Пишет стерео WAV; при наличии ffmpeg кодирует в MP3
(320k CBR — для тихих реверб-хвостов важно, иначе слышны артефакты) и убирает WAV.

Запуск:  python3 tools/gen-sfx.py
"""

import math
import os
import random
import shutil
import struct
import subprocess
import wave

SR = 44100
TAU = 2 * math.pi
OUT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "apps", "web", "public", "sfx"))
random.seed(42)  # детерминированный шум атаки → воспроизводимо

# Низкий тёплый регистр. Мелодические контуры прежние, сдвинуты вниз.
G2, A2, C3, D3, E3, F3, G3, A3, B3, C4, E4 = (
    98.00, 110.00, 130.81, 146.83, 164.81, 174.61, 196.00, 220.00, 246.94, 261.63, 329.63,
)

# Колокольно-малеточные парциалы: (кратность, амплитуда, T60 сек).
# 2-я гармоника усилена — низкий фундамент так читается и на мелких динамиках.
PARTIALS = [
    (1.00, 1.00, 1.20),
    (2.00, 0.62, 0.75),
    (3.01, 0.24, 0.34),
    (4.02, 0.10, 0.18),
]
DETUNE = 0.0016  # ±0.16% unison — тёплый хор без явной расстройки


def _transient(amp):
    """Короткий отфильтрованный шумовой «удар» — даёт атаке телесность/чёткость."""
    n = int(SR * 0.020)
    raw = [random.uniform(-1, 1) * amp * math.exp(-i / (SR * 0.004)) for i in range(n)]
    return lowpass(raw, 2600.0)


def note(freq, dur, amp=0.5):
    """Малеточный удар: аддитивный синтез + плавная атака + шумовой транзиент."""
    n = int(SR * dur)
    attack = int(SR * 0.008)
    buf = [0.0] * n
    norm = sum(a for _, a, _ in PARTIALS)
    for ratio, pa, t60 in PARTIALS:
        k = math.log(1000.0) / t60
        for det in (1.0 - DETUNE, 1.0 + DETUNE):
            w = TAU * freq * ratio * det / SR
            for i in range(n):
                env = math.exp(-k * i / SR)
                if i < attack:
                    env *= 0.5 - 0.5 * math.cos(math.pi * i / attack)
                buf[i] += amp * (pa / norm) * 0.5 * env * math.sin(w * i)
    for i, t in enumerate(_transient(amp * 0.10)):
        if i < n:
            buf[i] += t
    return buf


def highpass(x, cutoff):
    """Однополюсный HPF — убирает мутный подгул ниже ~cutoff."""
    dt = 1.0 / SR
    rc = 1.0 / (TAU * cutoff)
    a = rc / (rc + dt)
    y = [0.0] * len(x)
    px = py = 0.0
    for i, xi in enumerate(x):
        py = a * (py + xi - px)
        px = xi
        y[i] = py
    return y


def lowpass(x, cutoff):
    """Однополюсный LPF — снимает «стеклянные» верхи."""
    dt = 1.0 / SR
    a = dt / (1.0 / (TAU * cutoff) + dt)
    y = [0.0] * len(x)
    prev = 0.0
    for i, xi in enumerate(x):
        prev += a * (xi - prev)
        y[i] = prev
    return y


def saturate(x, drive=1.3):
    d = math.tanh(drive)
    return [math.tanh(drive * s) / d for s in x]


def _comb(x, delay, fb, damp):
    buf = [0.0] * delay
    y = [0.0] * len(x)
    store = 0.0
    idx = 0
    for i, xi in enumerate(x):
        out = buf[idx]
        store = out * (1.0 - damp) + store * damp
        buf[idx] = xi + store * fb
        y[i] = out
        idx = (idx + 1) % delay
    return y


def _allpass(x, delay, g):
    buf = [0.0] * delay
    y = [0.0] * len(x)
    idx = 0
    for i, xi in enumerate(x):
        bo = buf[idx]
        y[i] = -xi + bo
        buf[idx] = xi + bo * g
        idx = (idx + 1) % delay
    return y


def reverb(x, spread, room=0.82, damp=0.34):
    """Стерео-реверб Шрёдера: 4 гребёнки || + 2 all-pass. spread сдвигает
    задержки → ширина. Больше damp = темнее и глаже хвост (не «зернит»)."""
    acc = [0.0] * len(x)
    for d in (1116, 1188, 1277, 1356):
        c = _comb(x, d + spread, room, damp)
        for i in range(len(x)):
            acc[i] += c[i]
    for d in (556, 441):
        acc = _allpass(acc, d + spread, 0.5)
    return acc


def mix(events, tail=1.3, wet=0.30, predelay=0.012):
    """Синтез ударов → HPF/LPF/сатурация → стерео-реверб с pre-delay → нормализация."""
    dur = max(start + 0.001 for _, _, start, _ in events)
    total = int(SR * (dur + tail))
    dry = [0.0] * total
    for freq, ndur, start, amp in events:
        off = int(SR * start)
        for i, s in enumerate(note(freq, ndur, amp)):
            if off + i < total:
                dry[off + i] += s

    dry = saturate(lowpass(highpass(dry, 110.0), 3800.0))

    # pre-delay: сухая атака идёт первой, реверб «зала» — чуть позже (чище)
    pd = int(SR * predelay)
    src = [0.0] * pd + dry
    src = src[:total] if len(src) > total else src + [0.0] * (total - len(src))
    left = reverb(src, spread=0)
    right = reverb(src, spread=190)  # заметная ширина справа

    out = [(dry[i] * (1 - wet) + left[i] * wet, dry[i] * (1 - wet) + right[i] * wet) for i in range(total)]

    peak = max(1e-9, max(max(abs(l), abs(r)) for l, r in out))
    g = 0.70 / peak
    fade = int(SR * 0.05)
    for i in range(len(out)):
        f = min(1.0, (len(out) - i) / fade)
        out[i] = (out[i][0] * g * f, out[i][1] * g * f)
    return out


def write_wav(path, stereo):
    with wave.open(path, "w") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        frames = bytearray()
        for l, r in stereo:
            frames += struct.pack("<hh", int(max(-1, min(1, l)) * 32767), int(max(-1, min(1, r)) * 32767))
        w.writeframes(bytes(frames))


def ev(freq, ndur, start, amp=0.5):
    return (freq, ndur, start, amp)


SOUNDS = {
    # вход — мягкий восходящий кварт-мотив
    "join":       mix([ev(G3, 0.65, 0.00), ev(C4, 0.80, 0.08, 0.44)]),
    # выход — нисходящая пара
    "leave":      mix([ev(C4, 0.55, 0.00, 0.44), ev(G3, 0.80, 0.09)]),
    # участник подключился — один тёплый удар
    "peer-join":  mix([ev(A3, 0.55, 0.00, 0.36)], tail=1.0),
    # участник вышел — удар пониже
    "peer-leave": mix([ev(E3, 0.55, 0.00, 0.36)], tail=1.0),
    # ошибка — тёмная нисходящая, приглушённо
    "error":      mix([ev(F3, 0.60, 0.00, 0.5), ev(C3, 0.85, 0.12, 0.5)], wet=0.36),
    # связь восстановлена — восходящий триад-арпеджио
    "reconnect":  mix([ev(G3, 0.50, 0.00, 0.38), ev(B3, 0.50, 0.08, 0.38), ev(E4, 0.72, 0.16, 0.42)]),
    # обрыв — нисходящая пара, длинный хвост
    "conn-lost":  mix([ev(G3, 0.55, 0.00, 0.40), ev(D3, 0.85, 0.10, 0.38)], tail=1.5, wet=0.36),
}


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    ffmpeg = shutil.which("ffmpeg")
    print("Генерация UI-звуков relay →", OUT, "| формат:", "mp3 320k" if ffmpeg else "wav")
    for name, stereo in SOUNDS.items():
        wav = os.path.join(OUT, name + ".wav")
        write_wav(wav, stereo)
        if ffmpeg:
            mp3 = os.path.join(OUT, name + ".mp3")
            subprocess.run(
                [ffmpeg, "-y", "-loglevel", "error", "-i", wav, "-codec:a", "libmp3lame", "-b:a", "320k", mp3],
                check=True,
            )
            os.remove(wav)
            print(f"  {name}.mp3  ({len(stereo)/SR*1000:.0f} ms)")
        else:
            print(f"  {name}.wav  ({len(stereo)/SR*1000:.0f} ms)")
    print("Готово.")
