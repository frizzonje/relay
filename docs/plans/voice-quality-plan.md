# Качество голоса и потолок медиасервера — план

> **Для исполнителя-агента:** обязательный навык — superpowers:subagent-driven-development
> (рекомендуется) или superpowers:executing-plans. Шаги — чекбоксы `- [ ]`.

**Цель:** голос в прямых звонках устойчив к потерям (RED) и не тратит битрейт на
стерео; порог микрофона не гонит голос через Web Audio; медиасервер не упирается в
~50 человек из-за портов.

**Архитектура:** А1–А2 — правка переговоров mesh (порядок кодеков через
`setCodecPreferences`, по-секционный fmtp в SDP); А3 — одна дорожка микрофона,
затвор через `track.enabled`, анализатор на клоне; Б1 — `WebRtcServer` mediasoup,
порт на воркер.

**Стек:** Next.js (apps/web), NestJS + mediasoup 3.22 (apps/sfu), vitest,
Playwright 1.55.

**Спецификация:** [voice-quality.md](voice-quality.md) — читать вместе с планом:
там разведка, на которую опираются решения.

## Глобальные ограничения

- Сборка, тесты, линт — **только в Docker** (образ `node:20-alpine`, репозиторий
  смонтирован в `/mono`). Хостовые `pnpm`/`node`/`npx` не запускать.
- Коммиты — на английском, в конце строка
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `git add` — только перечисленные файлы, никогда каталог целиком.
- Умолчания каталога настроек не меняются (`packages/shared/src/settings.ts`).
- iOS-клиент (`clients/ios`) не трогать.
- Фаервол, `install.sh`, `.env.example`, compose-файлы не трогать: порты SFU
  остаются внутри `40000–40100`.
- Стиль кода — как вокруг: комментарии по-русски, объясняют «почему».
- E2E-стенд — только под проектом `-p relay-e2e`: без него compose сядет на тома
  живой инсталляции.

### Команды (из корня репозитория)

```bash
# web: один файл тестов
docker run --rm -v "$PWD":/mono -w /mono/apps/web node:20-alpine sh -c './node_modules/.bin/vitest run lib/sdp.test.ts'
# web: типы
docker run --rm -v "$PWD":/mono -w /mono/apps/web node:20-alpine node /mono/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
# sfu: тесты и типы
docker run --rm -v "$PWD":/mono -w /mono/apps/sfu node:20-alpine sh -c './node_modules/.bin/vitest run src/media'
docker run --rm -v "$PWD":/mono -w /mono/apps/sfu node:20-alpine sh -c './node_modules/.bin/tsc -p tsconfig.json --noEmit'
# линт и формат по списку файлов
docker run --rm -v "$PWD":/mono -w /mono node:20-alpine node node_modules/eslint/bin/eslint.js <файлы>
docker run --rm -v "$PWD":/mono -w /mono node:20-alpine node node_modules/prettier/bin/prettier.cjs --check <файлы>
```

---

### Задача 1. Голос моно, демонстрация стерео (А2)

**Файлы:**
- Изменить: `apps/web/lib/sdp.ts` (блок Opus: `OPUS_FMTP_PARAMS`, `boostAudioBitrate`, `mergeFmtp`)
- Тест: `apps/web/lib/sdp.test.ts` (блок `describe('boostAudioBitrate')`)
- Документация: `docs/media.md` (раздел «Дорожки и битрейт»)

**Интерфейсы:**
- Производит: `boostAudioBitrate(sdp: string | undefined): string | undefined` —
  подпись та же, поведение по-секционное. `OPUS_MAX_BITRATE` остаётся экспортом.

- [ ] **Шаг 1: переписать тесты `boostAudioBitrate`.** Заменить весь блок
  `describe('boostAudioBitrate', …)` в `apps/web/lib/sdp.test.ts`:

```ts
// Голос и звук демонстрации — две аудиолинии, как у собеседника, который
// показывает экран. Opus = 111 в обеих: BUNDLE это разрешает, разведка
// (docs/plans/voice-quality.md) проверила на Chromium, WebKit и Firefox.
const call = [
  'v=0',
  'a=group:BUNDLE 0 1 2',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
  'a=mid:0',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=mid:1',
  'a=rtpmap:96 VP8/90000',
  'a=fmtp:96 max-fs=12288',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
  'a=mid:2',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  '',
].join('\r\n');

/** fmtp Opus в N-й аудиолинии. */
function opusFmtp(sdp: string, audioIndex: number): string {
  const audio = sdp.split(/\r\n(?=m=)/).filter((s) => s.startsWith('m=audio'))[audioIndex];
  return audio.split('\r\n').find((l) => l.startsWith('a=fmtp:111'))!;
}

describe('boostAudioBitrate', () => {
  it('undefined/пусто → как есть', () => {
    expect(boostAudioBitrate(undefined)).toBeUndefined();
    expect(boostAudioBitrate('')).toBe('');
  });

  it('голос — первая аудиолиния — моно: стерео на голосе только тратит битрейт', () => {
    const voice = opusFmtp(boostAudioBitrate(call)!, 0);
    expect(voice).toContain(';stereo=0');
    expect(voice).toContain('sprop-stereo=0');
  });

  it('звук демонстрации — следующие аудиолинии — стерео: там музыка', () => {
    const screen = opusFmtp(boostAudioBitrate(call)!, 1);
    expect(screen).toContain(';stereo=1');
    expect(screen).toContain('sprop-stereo=1');
  });

  it('битрейт, FEC и DTX одинаковы у обеих ролей', () => {
    const out = boostAudioBitrate(call)!;
    for (const fmtp of [opusFmtp(out, 0), opusFmtp(out, 1)]) {
      expect(fmtp).toContain(`maxaveragebitrate=${OPUS_MAX_BITRATE}`);
      expect(fmtp).toContain('useinbandfec=1');
      expect(fmtp).toContain('usedtx=0');
      expect((fmtp.match(/useinbandfec/g) || []).length).toBe(1);
    }
  });

  it('RED и видео не трогает', () => {
    const lines = boostAudioBitrate(call)!.split('\r\n');
    expect(lines.filter((l) => l.startsWith('a=fmtp:63'))).toEqual([
      'a=fmtp:63 111/111',
      'a=fmtp:63 111/111',
    ]);
    expect(lines.find((l) => l.startsWith('a=fmtp:96'))).toBe('a=fmtp:96 max-fs=12288');
  });

  it('слушатель: единственная recvonly-аудиолиния — это голос', () => {
    const listener = [
      'v=0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=recvonly',
      'a=rtpmap:111 opus/48000/2',
    ].join('\r\n');
    expect(boostAudioBitrate(listener)).toContain(';stereo=0');
  });

  it('добавляет a=fmtp сразу после rtpmap, если её не было', () => {
    const noFmtp = ['m=audio 9 RTP 111', 'a=rtpmap:111 opus/48000/2'].join('\r\n');
    const lines = boostAudioBitrate(noFmtp)!.split('\r\n');
    expect(lines[2]).toMatch(/^a=fmtp:111 .*stereo=0/);
  });

  it('идемпотентность: повторный вызов не меняет результат', () => {
    const once = boostAudioBitrate(call)!;
    expect(boostAudioBitrate(once)).toBe(once);
  });

  it('сохраняет CRLF и число строк, если fmtp уже были', () => {
    const out = boostAudioBitrate(call)!;
    expect(out.split('\r\n').length).toBe(call.split('\r\n').length);
    expect(out.endsWith('\r\n')).toBe(true);
  });

  it('без opus SDP не меняется', () => {
    const videoOnly = ['m=video 9 RTP 96', 'a=rtpmap:96 VP8/90000'].join('\r\n');
    expect(boostAudioBitrate(videoOnly)).toBe(videoOnly);
  });
});
```

- [ ] **Шаг 2: убедиться, что тесты падают.**
  Run: `…/vitest run lib/sdp.test.ts` (команда web выше).
  Expected: FAIL в «голос — первая аудиолиния — моно…» (сегодня там `stereo=1`).

- [ ] **Шаг 3: реализация.** В `apps/web/lib/sdp.ts` заменить блок от комментария
  «Качество голоса (Opus)» до конца `mergeFmtp` на:

```ts
// ─────────────────────────────────────────────────────────────────────────
// Качество голоса (Opus). Дефолт WebRTC для голоса — ~32 кбит/с без тюнинга, и
// звонок звучит глухо. Поднимаем: высокий средний битрейт, in-band FEC
// (устойчивость к потерям), без DTX (без «проглатывания» тихих участков).
//
// Каналы — по роли линии. Голос — моно: микрофон моно, а стерео заставляло
// кодек кодировать два одинаковых канала (разведка: 100% кадров голоса шли
// стерео). Звук демонстрации — стерео: там музыка и фильмы. Роль линии — её
// место среди аудиолиний: первая — голос, остальные — демонстрация. То же
// правило, по которому микшер (lib/voice/output.ts) отличает голос от показа:
// микрофон добавляется первым, звук экрана — позже, а m-линии не
// переупорядочиваются никогда.
//
// Это ПОТОЛОК кодека в SDP (maxaveragebitrate). Фактический максимум каждого
// потока задаётся отдельно через sender.encodings.maxBitrate (см.
// lib/voice/mesh/senders.ts) — голос держим скромнее и по числу, которое
// выбирает владелец инсталляции (`voice.audioBitrateKbps`), а звук демонстрации
// пускаем под этот потолок ради музыки/фильмов.
// ─────────────────────────────────────────────────────────────────────────
export const OPUS_MAX_BITRATE = 256_000;

// Параметры fmtp Opus, общие для обеих ролей (перетирают встречные значения).
const OPUS_FMTP_COMMON: Record<string, string> = {
  maxaveragebitrate: String(OPUS_MAX_BITRATE),
  maxplaybackrate: '48000',
  useinbandfec: '1',
  usedtx: '0',
  minptime: '10',
};

const VOICE_CHANNELS: Record<string, string> = { stereo: '0', 'sprop-stereo': '0' };
const SCREEN_CHANNELS: Record<string, string> = { stereo: '1', 'sprop-stereo': '1' };

/**
 * Прокачивает Opus в SDP по ролям линий: первая аудиолиния — голос (моно),
 * остальные — звук демонстрации (стерео); битрейт, FEC и DTX — общие. Кодеку
 * без строки a=fmtp дописывает её сразу после a=rtpmap. Не-Opus строки (RED,
 * видео) не трогает. Идемпотентна. undefined → undefined.
 */
export function boostAudioBitrate(sdp: string | undefined): string | undefined {
  if (!sdp) return sdp;
  const out: string[] = [];
  let section: string[] = [];
  let audioSeen = 0;
  const flush = () => {
    if (section[0]?.startsWith('m=audio')) {
      const channels = audioSeen === 0 ? VOICE_CHANNELS : SCREEN_CHANNELS;
      out.push(...tuneOpus(section, { ...OPUS_FMTP_COMMON, ...channels }));
      audioSeen++;
    } else {
      out.push(...section);
    }
    section = [];
  };
  for (const line of sdp.split('\r\n')) {
    if (line.startsWith('m=')) flush();
    section.push(line);
  }
  flush();
  return out.join('\r\n');
}

/** Opus одной m-линии: fmtp обновить на месте, недостающий — дописать. */
function tuneOpus(lines: string[], params: Record<string, string>): string[] {
  // Payload-типы opus и индекс их rtpmap-строки (чтобы вставить fmtp при нужде)
  const opusPts = new Map<string, number>();
  lines.forEach((l, i) => {
    const m = l.match(/^a=rtpmap:(\d+) opus\/\d+/i);
    if (m) opusPts.set(m[1], i);
  });
  if (!opusPts.size) return lines;

  const seen = new Set<string>();
  const out = lines.map((l) => {
    const m = l.match(/^a=fmtp:(\d+) (.*)$/);
    if (!m || !opusPts.has(m[1])) return l;
    seen.add(m[1]);
    return `a=fmtp:${m[1]} ${mergeFmtp(m[2], params)}`;
  });

  // Кодекам без fmtp дописываем строку сразу после rtpmap (с конца, чтобы
  // индексы не съезжали)
  const missing = [...opusPts.entries()].filter(([pt]) => !seen.has(pt));
  missing.sort((a, b) => b[1] - a[1]);
  const fresh = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join(';');
  for (const [pt, idx] of missing) out.splice(idx + 1, 0, `a=fmtp:${pt} ${fresh}`);
  return out;
}

// Сливает существующие параметры fmtp с нашими (наши перетирают встречные).
function mergeFmtp(existing: string, ours: Record<string, string>): string {
  const params = new Map<string, string>();
  for (const part of existing.split(';')) {
    const [k, ...rest] = part.split('=');
    if (k.trim()) params.set(k.trim(), rest.join('='));
  }
  for (const [k, v] of Object.entries(ours)) params.set(k, v);
  return [...params.entries()].map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join(';');
}
```

- [ ] **Шаг 4: тесты зелёные.** Run: `…/vitest run lib/sdp.test.ts`. Expected: PASS.
  Потом весь веб: `…/vitest run` — PASS (никто больше не завязан на `stereo=1`
  голоса; если что-то упало — читать, а не чинить ожидания вслепую).

- [ ] **Шаг 5: документация.** В `docs/media.md`, раздел «Дорожки и битрейт»,
  строку про Opus заменить на:

```markdown
- Opus в SDP: голос (первая аудиолиния) — моно, звук демонстрации — стерео; FEC,
  `usedtx=0` (мут — это `track.enabled = false`, RTP идёт дальше, поэтому сторож
  тишины не путает мут с обрывом).
```

- [ ] **Шаг 6: коммит.**

```bash
git add apps/web/lib/sdp.ts apps/web/lib/sdp.test.ts docs/media.md
git commit -m "fix(voice): send the mic mono in direct calls, keep screen audio stereo

Every Opus line got stereo=1, so the mic was encoded as two identical
channels (100% of voice frames carried the stereo flag). The SDP tuner now
works per m-section: the first audio line is voice (mono), the rest is
screen audio (stereo). Verified in Chromium, WebKit and Firefox: BUNDLE
accepts different fmtp for the same payload type.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Задача 2. RED для голоса в mesh (А1)

**Файлы:**
- Создать: `apps/web/lib/voice/mid.ts`
- Изменить: `apps/web/lib/voice/output.ts` (удалить локальную `cmpMid`, импортировать общую)
- Создать: `apps/web/lib/voice/mesh/red.ts`
- Тест: `apps/web/lib/voice/mesh/red.test.ts`
- Изменить: `apps/web/lib/voice/mesh/negotiation.ts` (вызов перед `createOffer` и `createAnswer`)
- Документация: `docs/media.md` (раздел «Дорожки и битрейт»)

**Интерфейсы:**
- Производит: `cmpMid(a: string, b: string): number` из `@/lib/voice/mid`;
  `preferRedForVoice(pc: RTCPeerConnection): void` и
  `redFirst(codecs: Codec[]): Codec[] | null` из `./red`.

- [ ] **Шаг 1: общий `cmpMid`.** Создать `apps/web/lib/voice/mid.ts`:

```ts
/**
 * Порядок mid — то, по чему relay отличает голос от звука демонстрации: микрофон
 * добавляется первым, звук экрана — позже, значит у голоса mid меньше. Правилом
 * пользуются двое — микшер (output.ts) и RED (mesh/red.ts), — и разойтись им
 * нельзя: иначе избыточность достанется музыке, а громкость голоса — показу.
 *
 * Числовые mid («0», «1», …) — по значению, иначе лексикографически.
 */
export function cmpMid(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}
```

  В `apps/web/lib/voice/output.ts` удалить функцию `cmpMid` вместе с комментарием
  над ней («Сравнение mid: …») и добавить в импорты:

```ts
import { cmpMid } from '@/lib/voice/mid';
```

- [ ] **Шаг 2: тесты RED.** Создать `apps/web/lib/voice/mesh/red.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preferRedForVoice, redFirst } from './red';

/**
 * RED — только голосу и только там, где браузер его умеет. Каждый отказ здесь
 * обязан быть тихим: переговоры без RED — это просто сегодняшний звонок, а
 * исключение из этого модуля уронило бы переговоры целиком.
 */

const opus = { mimeType: 'audio/opus', clockRate: 48000, channels: 2, sdpFmtpLine: 'minptime=10' };
const red = { mimeType: 'audio/red', clockRate: 48000, channels: 2, sdpFmtpLine: '111/111' };
const pcmu = { mimeType: 'audio/PCMU', clockRate: 8000 };

function transceiver(kind: 'audio' | 'video', mid: string | null, direction = 'sendrecv') {
  return {
    mid,
    direction,
    currentDirection: direction === 'stopped' ? 'stopped' : null,
    receiver: { track: { kind } },
    setCodecPreferences: vi.fn(),
  };
}

const pcWith = (...ts: ReturnType<typeof transceiver>[]) =>
  ({ getTransceivers: () => ts }) as unknown as RTCPeerConnection;

function capabilities(codecs: object[] | null) {
  vi.stubGlobal('RTCRtpReceiver', {
    getCapabilities: () => (codecs ? { codecs, headerExtensions: [] } : null),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('redFirst', () => {
  it('ставит RED первым и не теряет остальных', () => {
    expect(redFirst([opus, red, pcmu] as never)).toEqual([red, opus, pcmu]);
  });

  it('без RED — null: трогать нечего', () => {
    expect(redFirst([opus, pcmu] as never)).toBeNull();
  });

  it('регистр mimeType не важен', () => {
    const upper = { ...red, mimeType: 'audio/RED' };
    expect(redFirst([opus, upper] as never)![0]).toBe(upper);
  });
});

describe('preferRedForVoice', () => {
  it('RED получает только голос — аудио с наименьшим mid', () => {
    capabilities([opus, red, pcmu]);
    const screen = transceiver('audio', '2');
    const video = transceiver('video', '1');
    const voice = transceiver('audio', '0');
    preferRedForVoice(pcWith(screen, video, voice));
    expect(voice.setCodecPreferences).toHaveBeenCalledWith([red, opus, pcmu]);
    expect(screen.setCodecPreferences).not.toHaveBeenCalled();
    expect(video.setCodecPreferences).not.toHaveBeenCalled();
  });

  it('mid сравниваются числами: «10» позже «9»', () => {
    capabilities([opus, red]);
    const ten = transceiver('audio', '10');
    const nine = transceiver('audio', '9');
    preferRedForVoice(pcWith(ten, nine));
    expect(nine.setCodecPreferences).toHaveBeenCalled();
    expect(ten.setCodecPreferences).not.toHaveBeenCalled();
  });

  it('до первых переговоров mid нет — голос первый аудиотрансивер', () => {
    capabilities([opus, red]);
    const first = transceiver('audio', null);
    const second = transceiver('audio', null);
    preferRedForVoice(pcWith(first, second));
    expect(first.setCodecPreferences).toHaveBeenCalled();
    expect(second.setCodecPreferences).not.toHaveBeenCalled();
  });

  it('новый трансивер без mid не отбирает роль у голоса', () => {
    capabilities([opus, red]);
    const fresh = transceiver('audio', null);
    const voice = transceiver('audio', '0');
    preferRedForVoice(pcWith(fresh, voice));
    expect(voice.setCodecPreferences).toHaveBeenCalled();
    expect(fresh.setCodecPreferences).not.toHaveBeenCalled();
  });

  it('остановленный трансивер не в счёт', () => {
    capabilities([opus, red]);
    const stopped = transceiver('audio', '0', 'stopped');
    const live = transceiver('audio', '3');
    preferRedForVoice(pcWith(stopped, live));
    expect(live.setCodecPreferences).toHaveBeenCalled();
    expect(stopped.setCodecPreferences).not.toHaveBeenCalled();
  });

  it('браузер без RED (Firefox) — ничего не делает', () => {
    capabilities([opus, pcmu]);
    const voice = transceiver('audio', '0');
    preferRedForVoice(pcWith(voice));
    expect(voice.setCodecPreferences).not.toHaveBeenCalled();
  });

  it('нет getCapabilities или setCodecPreferences — ничего не делает и не падает', () => {
    const voice = { ...transceiver('audio', '0'), setCodecPreferences: undefined };
    capabilities([opus, red]);
    expect(() => preferRedForVoice(pcWith(voice as never))).not.toThrow();
    vi.stubGlobal('RTCRtpReceiver', {});
    const other = transceiver('audio', '0');
    expect(() => preferRedForVoice(pcWith(other))).not.toThrow();
    expect(other.setCodecPreferences).not.toHaveBeenCalled();
  });

  it('отказ браузера не роняет переговоры', () => {
    capabilities([opus, red]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const voice = transceiver('audio', '0');
    voice.setCodecPreferences.mockImplementation(() => {
      throw new Error('InvalidModificationError');
    });
    expect(() => preferRedForVoice(pcWith(voice))).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});
```

- [ ] **Шаг 3: тесты падают.** Run: `…/vitest run lib/voice/mesh/red.test.ts`.
  Expected: FAIL — `Failed to resolve import "./red"`.

- [ ] **Шаг 4: реализация.** Создать `apps/web/lib/voice/mesh/red.ts`:

```ts
'use client';

import { cmpMid } from '@/lib/voice/mid';

/**
 * RED (RFC 2198) для голоса в прямых звонках: каждый пакет несёт новый кадр
 * Opus и копию прошлого. Потерянный пакет восстанавливается из следующего —
 * голос перестаёт «булькать» на плохом Wi-Fi и мобильной сети.
 *
 * Кодек отправки каждая сторона берёт первым из списка СОБЕСЕДНИКА. Поэтому
 * ставим RED первым в своём списке — тогда RED шлют нам. Chrome и WebKit RED
 * объявляют и сами, но вторым, после Opus, и договариваются на Opus.
 *
 * Только голос: звук демонстрации (музыка до 256 кбит/с) с копией стоил бы
 * вдвое больше на каждого собеседника. RED идёт поверх потолка Opus, а не
 * делит его: `maxBitrate` ограничивает Opus, копия добавляется сверху
 * (разведка: 259 кбит/с при потолке 128).
 *
 * Всё необязательно: нет RED у браузера (Firefox), нет setCodecPreferences,
 * браузер отказал — переговоры идут как без этого модуля, на Opus.
 */

type Codec = NonNullable<ReturnType<typeof RTCRtpReceiver.getCapabilities>>['codecs'][number];

const isRed = (c: Codec) => c.mimeType.toLowerCase() === 'audio/red';

/** RED первым, остальные в прежнем порядке; null — RED у браузера нет. */
export function redFirst(codecs: Codec[]): Codec[] | null {
  const red = codecs.filter(isRed);
  return red.length ? [...red, ...codecs.filter((c) => !isRed(c))] : null;
}

/**
 * Голосовой трансивер — аудио с наименьшим mid (см. lib/voice/mid.ts). До
 * первых переговоров mid нет ни у кого — тогда первый аудио: микрофон
 * добавляется в createPeer раньше всего остального.
 */
function voiceTransceiver(pc: RTCPeerConnection): RTCRtpTransceiver | null {
  const audio = pc
    .getTransceivers()
    .filter(
      (t) =>
        t.direction !== 'stopped' &&
        t.currentDirection !== 'stopped' &&
        t.receiver.track.kind === 'audio',
    );
  const withMid = audio.filter((t) => t.mid !== null);
  if (withMid.length) return withMid.sort((a, b) => cmpMid(a.mid!, b.mid!))[0];
  return audio[0] ?? null;
}

/** Поставить RED первым голосу. Звать перед каждым createOffer и createAnswer. */
export function preferRedForVoice(pc: RTCPeerConnection): void {
  const voice = voiceTransceiver(pc);
  if (!voice || typeof voice.setCodecPreferences !== 'function') return;
  if (typeof RTCRtpReceiver === 'undefined' || typeof RTCRtpReceiver.getCapabilities !== 'function') {
    return;
  }
  const codecs = RTCRtpReceiver.getCapabilities('audio')?.codecs;
  const ordered = codecs ? redFirst(codecs) : null;
  if (!ordered) return;
  try {
    voice.setCodecPreferences(ordered);
  } catch (err) {
    console.warn('RED preference rejected:', err);
  }
}
```

- [ ] **Шаг 5: вызовы в переговорах.** В `apps/web/lib/voice/mesh/negotiation.ts`
  импорт рядом с `tuneSdp`:

```ts
import { preferRedForVoice } from './red';
```

  В `offerTo` — перед `createOffer`:

```ts
        talk.makingOffer = true;
        preferRedForVoice(pc);
        const offer = await pc.createOffer();
```

  В `onOffer` — перед `createAnswer` (после `drainCandidates`: трансиверы
  собеседника к этому моменту уже созданы `setRemoteDescription`):

```ts
        await drainCandidates(from, pc);
        preferRedForVoice(pc);
        const answer = await pc.createAnswer();
```

- [ ] **Шаг 6: зелёные тесты и типы.** Run: `…/vitest run lib/voice` и
  `tsc --noEmit` (команды web). Expected: PASS, без ошибок типов.

- [ ] **Шаг 7: документация.** В `docs/media.md`, «Дорожки и битрейт», после
  строки про Opus:

```markdown
- RED ([`mesh/red.ts`](../apps/web/lib/voice/mesh/red.ts)): голосу — избыточность
  RFC 2198, каждый пакет несёт копию прошлого кадра. Только в mesh (mediasoup RED
  не знает) и только там, где браузер умеет (Chromium, WebKit; Firefox — нет,
  откат на Opus). Идёт поверх потолка голоса, ~×2 трафика голоса.
```

- [ ] **Шаг 8: коммит.**

```bash
git add apps/web/lib/voice/mid.ts apps/web/lib/voice/output.ts apps/web/lib/voice/mesh/red.ts apps/web/lib/voice/mesh/red.test.ts apps/web/lib/voice/mesh/negotiation.ts docs/media.md
git commit -m "feat(voice): RED redundancy for the voice line in direct calls

Chrome and WebKit already offer red/48000/2, but second to Opus, so calls
settled on plain Opus. The voice transceiver now puts RED first before every
offer and answer, so a lost packet is rebuilt from the next one. Screen audio
stays on plain Opus; browsers without RED (Firefox) negotiate as before.
The mid ordering rule moves to lib/voice/mid.ts, shared with the mixer.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Задача 3. Затвор порога — чистая функция (А3, часть 1)

**Файлы:**
- Создать: `apps/web/lib/voice/gate.ts`
- Тест: `apps/web/lib/voice/gate.test.ts`

**Интерфейсы:**
- Производит: `interface GateState { open: boolean; openUntil: number }`,
  `nextGate(input: { level: number; threshold: number; now: number; openUntil: number; holdMs: number }): GateState`.

- [ ] **Шаг 1: тесты.** Создать `apps/web/lib/voice/gate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { nextGate } from './gate';

const HOLD = 250;
const at = (now: number, level: number, openUntil = 0, threshold = 0.5) =>
  nextGate({ level, threshold, now, openUntil, holdMs: HOLD });

describe('nextGate', () => {
  it('порог 0 — затвор открыт всегда, что бы ни было с уровнем', () => {
    expect(at(1000, 0, 0, 0)).toEqual({ open: true, openUntil: 0 });
  });

  it('тише порога — закрыт', () => {
    expect(at(1000, 0.1).open).toBe(false);
  });

  it('громче порога — открыт и держится ещё HOLD', () => {
    expect(at(1000, 0.8)).toEqual({ open: true, openUntil: 1000 + HOLD });
  });

  it('ровно на пороге — открыт: порог — это «с этого уровня слышно»', () => {
    expect(at(1000, 0.5).open).toBe(true);
  });

  it('после спада держится до openUntil и закрывается ровно на нём', () => {
    expect(at(1200, 0.1, 1250)).toEqual({ open: true, openUntil: 1250 });
    expect(at(1250, 0.1, 1250)).toEqual({ open: false, openUntil: 1250 });
  });
});
```

- [ ] **Шаг 2: падают.** Run: `…/vitest run lib/voice/gate.test.ts`. Expected: FAIL (нет модуля).

- [ ] **Шаг 3: реализация.** Создать `apps/web/lib/voice/gate.ts`:

```ts
/**
 * Затвор порога микрофона — одно решение без побочных эффектов: открыт ли он
 * сейчас и до какого момента держится. Всё, что затвор делает с дорожкой, живёт
 * в mic.ts; здесь только арифметика, поэтому её и можно проверить без браузера.
 *
 * Уровень и порог — в шкале метра (0..1). Порог 0 — затвора нет. Громче порога
 * — открыт и держится ещё `holdMs` после спада, чтобы хвосты слов не рубило.
 */
export interface GateState {
  open: boolean;
  /** До какого момента (performance.now) затвор держится открытым. */
  openUntil: number;
}

export function nextGate(input: {
  level: number;
  threshold: number;
  now: number;
  openUntil: number;
  holdMs: number;
}): GateState {
  if (input.threshold <= 0) return { open: true, openUntil: 0 };
  const openUntil = input.level >= input.threshold ? input.now + input.holdMs : input.openUntil;
  return { open: input.now < openUntil, openUntil };
}
```

- [ ] **Шаг 4: зелёные.** Run: `…/vitest run lib/voice/gate.test.ts`. Expected: PASS.

- [ ] **Шаг 5: коммит.**

```bash
git add apps/web/lib/voice/gate.ts apps/web/lib/voice/gate.test.ts
git commit -m "refactor(voice): the mic gate decision becomes a pure function

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Задача 4. Одна дорожка микрофона, затвор через `enabled` (А3, часть 2)

**Файлы:**
- Изменить: `apps/web/lib/voice/mic.ts`
- Тест: `apps/web/lib/voice/mic.test.ts` (новый)
- Документация: `docs/media.md` (таблица модулей, строка `voice/mic.ts`)

**Интерфейсы:**
- Потребляет: `nextGate` из `@/lib/voice/gate` (задача 3).
- Производит: экспорты `mic.ts` **не меняются** (`initMic`, `isMicOn`, `setMicOn`,
  `ensureLocalStream`, `setMicThreshold`, `micLevelNorm`, `getMicLevel`,
  `refreshMicInfo`, `refreshMics`, `setMic`, `setNoiseSuppression`, `setAutoGain`,
  `desktopPtt`, `setPushToTalk`, `loadMediaPrefs`, `applyMute`, `micRingThreshold`,
  `hasLocalAnalyser`, `startGate`, `loadMicThreshold`, `teardownMic`,
  `MicSurroundings`).

- [ ] **Шаг 1: тесты.** Создать `apps/web/lib/voice/mic.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Микрофон после разреза: дорожка одна — та, что пришла с устройства, — и она
 * же уходит собеседникам. Здесь проверяется то, что ломается молча:
 *  - в сеть не уходит выход Web Audio (на Linux это треск);
 *  - анализатор слушает клон — иначе закрытый затвор оглох бы навсегда;
 *  - мут, затвор и смена устройства сходятся в одну формулу `micOn && gateOpen`;
 *  - выход гасит и дорожку, и клон — иначе лампочка записи горит до перезагрузки.
 */

const h = vi.hoisted(() => {
  const node = () => ({ connect: (n: unknown) => n, disconnect: () => {} });
  const sources: { getAudioTracks(): unknown[] }[] = [];
  return {
    rms: 0,
    sources,
    ctx: {
      currentTime: 0,
      destination: {},
      createMediaStreamSource: (s: { getAudioTracks(): unknown[] }) => {
        sources.push(s);
        return node();
      },
      createAnalyser: () => ({ ...node(), fftSize: 0 }),
      createGain: () => ({ ...node(), gain: { value: 1, setTargetAtTime: () => {} } }),
      // Старый код гнал голос сюда и отдавал собеседникам ЭТУ дорожку. Подделка
      // умеет выход Web Audio, чтобы тест «в сеть уходит дорожка устройства»
      // падал на старом коде, а не проходил из-за отката на сырую дорожку.
      createMediaStreamDestination: () => ({
        ...node(),
        stream: new (globalThis as unknown as { MediaStream: new (t: unknown[]) => unknown })
          .MediaStream([{ kind: 'audio', id: 'web-audio', enabled: true, contentHint: '' }]),
      }),
    },
  };
});

vi.mock('@/lib/voice/output', () => ({
  ANALYSER_FFT_SIZE: 512,
  analyserRms: () => h.rms,
  // audioContext новому mic.ts не нужен; он здесь, чтобы старый код падал на
  // проверках, а не на TypeError в таймере гейта (шаг 2).
  audioContext: () => h.ctx,
  getAudioCtx: () => h.ctx,
  refreshOutputDevices: () => {},
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

class FakeTrack {
  kind = 'audio';
  enabled = true;
  readyState: 'live' | 'ended' = 'live';
  contentHint = '';
  label: string;
  constructor(readonly id: string) {
    this.label = `mic ${id}`;
  }
  /** Как в браузере: клон наследует enabled оригинала. */
  clone(): FakeTrack {
    const c = new FakeTrack(`${this.id}~clone`);
    c.enabled = this.enabled;
    return c;
  }
  stop() {
    this.readyState = 'ended';
  }
  getSettings() {
    return { deviceId: `dev-${this.id}` };
  }
}

class FakeStream {
  private tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks];
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getTracks() {
    return [...this.tracks];
  }
  addTrack(t: FakeTrack) {
    this.tracks.push(t);
  }
  removeTrack(t: FakeTrack) {
    this.tracks = this.tracks.filter((x) => x !== t);
  }
}

let mic: typeof import('./mic');
let outgoing: FakeStream | null;
let captured: FakeTrack[];
let replaced: [FakeTrack | null, FakeTrack][];
let announced: number;
let synced: number;

/** Уровень в шкале метра: micLevelNorm = sqrt(rms / 0.5). */
const level = (norm: number) => {
  h.rms = norm * norm * 0.5;
};
const sent = () => outgoing!.getAudioTracks()[0];
const meter = () => h.sources.at(-1)!.getAudioTracks()[0] as FakeTrack;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'],
  });
  h.rms = 0;
  h.sources.length = 0;
  captured = [];
  replaced = [];
  outgoing = null;
  announced = 0;
  synced = 0;
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
  });
  vi.stubGlobal('MediaStream', FakeStream);
  vi.stubGlobal('window', {
    AudioContext: class {},
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: async () => {
        const t = new FakeTrack(String(captured.length + 1));
        captured.push(t);
        return new FakeStream([t]);
      },
      enumerateDevices: async () => [],
    },
  });
  mic = await import('./mic');
  mic.initMic({
    stream: () => outgoing as unknown as MediaStream,
    adopt: (s) => {
      outgoing = s as unknown as FakeStream;
    },
    screenAudioTrack: () => null,
    replaceTrack: (from, to) =>
      replaced.push([from as unknown as FakeTrack | null, to as unknown as FakeTrack]),
    syncStore: () => {
      synced++;
    },
    announce: () => {
      announced++;
    },
  });
});

afterEach(() => {
  mic.teardownMic();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('одна дорожка', () => {
  it('в сеть уходит дорожка устройства — и при включённом пороге тоже', async () => {
    mic.setMicThreshold(0.5);
    await mic.ensureLocalStream();
    expect(sent()).toBe(captured[0]);
    expect(outgoing!.getAudioTracks()).toHaveLength(1);
  });

  it('анализатор слушает клон, а не дорожку, которую глушит затвор', async () => {
    await mic.ensureLocalStream();
    expect(meter()).not.toBe(captured[0]);
    expect(meter().id).toBe('1~clone');
  });
});

describe('затвор', () => {
  beforeEach(async () => {
    mic.setMicThreshold(0.5);
    await mic.ensureLocalStream();
    mic.startGate();
    announced = 0;
    synced = 0;
  });

  it('тише порога — выключена, громче — включена, после спада держится 250 мс', () => {
    level(0.1);
    vi.advanceTimersByTime(50);
    expect(sent().enabled).toBe(false);
    expect(meter().enabled).toBe(true); // клон затвор не глушит

    level(0.8);
    vi.advanceTimersByTime(50);
    expect(sent().enabled).toBe(true);

    level(0.1);
    vi.advanceTimersByTime(200);
    expect(sent().enabled).toBe(true);
    vi.advanceTimersByTime(100);
    expect(sent().enabled).toBe(false);
  });

  it('затвор — не мут: собеседникам и витрине ничего не объявляется', () => {
    level(0.1);
    vi.advanceTimersByTime(50);
    level(0.8);
    vi.advanceTimersByTime(50);
    expect(announced).toBe(0);
    expect(synced).toBe(0);
  });

  it('мут главнее открытого затвора, а снятый мут при закрытом затворе не включает', () => {
    level(0.8);
    vi.advanceTimersByTime(50);
    mic.setMicOn(false);
    expect(sent().enabled).toBe(false);

    level(0.1);
    vi.advanceTimersByTime(300);
    mic.setMicOn(true);
    expect(sent().enabled).toBe(false);
  });

  it('порог 0 открывает затвор сразу, не дожидаясь тика', () => {
    level(0);
    vi.advanceTimersByTime(50);
    expect(sent().enabled).toBe(false);
    mic.setMicThreshold(0);
    expect(sent().enabled).toBe(true);
  });
});

it('без анализатора затвор не глушит — иначе человека не слышно вовсе', async () => {
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
  mic.setMicThreshold(0.5);
  await mic.ensureLocalStream();
  mic.startGate();
  vi.advanceTimersByTime(100);
  expect(mic.hasLocalAnalyser()).toBe(false);
  expect(sent().enabled).toBe(true);
});

it('выход гасит и дорожку устройства, и клон — лампочка записи гаснет', async () => {
  await mic.ensureLocalStream();
  const clone = meter();
  mic.teardownMic();
  expect(captured[0].readyState).toBe('ended');
  expect(clone.readyState).toBe('ended');
});

describe('смена устройства', () => {
  it('одна ветка: подмена у собеседников, старое погашено, мут переехал', async () => {
    await mic.ensureLocalStream();
    const oldClone = meter();
    mic.setMicOn(false);
    await mic.setMic('dev-x');
    expect(replaced).toEqual([[captured[0], captured[1]]]);
    expect(sent()).toBe(captured[1]);
    expect(outgoing!.getAudioTracks()).toHaveLength(1);
    expect(captured[1].enabled).toBe(false);
    expect(captured[0].readyState).toBe('ended');
    expect(oldClone.readyState).toBe('ended');
  });

  it('клон, снятый при муте, всё равно слышит — метр и затвор живы', async () => {
    await mic.ensureLocalStream();
    mic.setMicOn(false);
    await mic.setMic('dev-x');
    expect(meter().id).toBe('2~clone');
    expect(meter().enabled).toBe(true);
  });
});
```

- [ ] **Шаг 2: падают.** Run: `…/vitest run lib/voice/mic.test.ts`.
  Expected: FAIL — «в сеть уходит дорожка устройства» (сегодня уходит дорожка
  `web-audio` из `createMediaStreamDestination`), «анализатор слушает клон»
  (сегодня анализатор на самой дорожке), тесты затвора (сегодня затвор — gain в
  Web Audio, `enabled` дорожки не меняется). Тесты «без анализатора» и «выход
  гасит…» могут пройти и на старом коде — это страховка от регрессии, не
  доказательство правки.

- [ ] **Шаг 3: реализация — шапка файла.** В `apps/web/lib/voice/mic.ts`:
  импорт из output заменить (уходит `audioContext`), добавить импорт затвора:

```ts
import { nextGate } from '@/lib/voice/gate';
import {
  ANALYSER_FFT_SIZE,
  analyserRms,
  getAudioCtx,
  refreshOutputDevices,
} from '@/lib/voice/output';
```

  Первый JSDoc файла заменить на:

```ts
/**
 * Захват микрофона: устройство, шумовой гейт, push-to-talk, мут и анализатор,
 * по которому зажигается обводка «говорю».
 *
 * Дорожка микрофона одна — та, что пришла с устройства, и она же уходит
 * собеседникам. Всё, что её глушит (мут, push-to-talk, «глушилка», затвор
 * порога), сходится в одну формулу `enabled = micOn && gateOpen` и пишется в
 * одном месте — `applyTrackState`. Web Audio здесь только слушает: уровень
 * снимается с КЛОНА дорожки, потому что выключенная дорожка отдаёт тишину всем
 * своим потребителям, и анализатор на ней самой после первого же закрытия
 * затвора видел бы ноль — затвор больше не открылся бы никогда.
 *
 * Раньше при пороге > 0 голос шёл через GainNode и MediaStreamDestination, и
 * собеседникам уходил выход Web Audio — вторая дорожка, пересэмплирование на
 * частоту вывода и подозреваемый в треске на Linux. См. docs/plans/voice-quality.md.
 */
```

- [ ] **Шаг 4: реализация — порог и состояние.** Блок от комментария
  «Порог срабатывания микрофона (шумовой гейт…)» до `const MIC_KEY` заменить на:

```ts
// ─── Порог срабатывания микрофона (шумовой гейт, как в Discord) ───────────
// Пока уровень ниже порога, затвор закрыт и дорожка устройства выключена
// (`enabled = false`: пакеты тишины идут дальше, и сторож тишины у собеседника
// не спутает это с обрывом — ровно как при муте). Выше — открыт. После спада
// держим открытым ещё GATE_HOLD_MS, чтобы хвосты слов не рубило. Порог 0 —
// затвора нет. Затвор резкий, без фронтов: цена того, что голос не идёт через
// Web Audio.
const MIC_THRESHOLD_KEY = 'relay-mic-threshold';
let micThreshold = 0; // 0..1 в шкале метра (0 = гейт выключен); читаем в initVoice
let micTrack: MediaStreamTrack | null = null; // дорожка устройства — она же уходит собеседникам
let meterTrack: MediaStreamTrack | null = null; // её клон под анализатор: затвор и мут его не глушат

const MIC_METER_FULL = 0.5; // RMS, при котором метр (и шкала порога) заполнен
const MIC_RING_FLOOR = 0.12; // мин. уровень для обводки «говорю», когда гейт выключен
const GATE_HOLD_MS = 250;
const GATE_TICK_MS = 50;
let gateOpen = true;
let gateOpenUntil = 0;
let gateTimer: ReturnType<typeof setInterval> | null = null;

// Анализатор своего микрофона: он же питает и метр у ползунка порога, и гейт,
// и обводку «говорю». Тихий путь до destination нужен, чтобы граф «тянул»
// микрофон, — себя мы не слышим.
let localAnalyser: AnalyserNode | null = null;
let localVadSource: MediaStreamAudioSourceNode | null = null;
let localVadGain: GainNode | null = null;
```

- [ ] **Шаг 5: реализация — захват.** В `ensureLocalStream` строки после
  `around.adopt(stream);` до `setupLocalVad();` заменить:

```ts
  around.adopt(stream);
  micTrack = stream.getAudioTracks()[0] ?? null;
  if (micTrack) micTrack.contentHint = 'speech'; // голос, не музыка
  gateOpen = true; // первый тик гейта закроет, если тихо
  gateOpenUntil = 0;
  applyTrackState();
  setupLocalVad(); // анализатор своего микрофона для обводки и гейта
```

- [ ] **Шаг 6: реализация — удалить конвейер.** Удалить целиком функции
  `sentMicTrack` и `ensureMicPipeline` с их комментариями. Функции
  `setMicThreshold` и `evaluateGate` заменить на:

```ts
/**
 * Порог срабатывания микрофона, 0..1 в шкале метра (0 = гейт выключен, слышно
 * всегда). Чем правее — тем громче надо говорить, чтобы микрофон открылся.
 * Сам затвор ведёт evaluateGate. Выбор — в localStorage.
 */
export function setMicThreshold(value: number) {
  const t = Math.max(0, Math.min(1, value));
  micThreshold = t;
  if (typeof localStorage !== 'undefined') localStorage.setItem(MIC_THRESHOLD_KEY, String(t));
  useVoiceStore.getState().setMicThreshold(t);
  // Порог выключили — затвор открывается сразу, не дожидаясь тика.
  if (t <= 0) setGate({ open: true, openUntil: 0 });
}

/** Сменить состояние затвора; дорожку трогаем, только если оно правда сменилось. */
function setGate(next: { open: boolean; openUntil: number }) {
  gateOpenUntil = next.openUntil;
  if (next.open === gateOpen) return;
  gateOpen = next.open;
  applyTrackState();
}

/**
 * Тик гейта. Без анализатора (нет Web Audio) порог не применяем вовсе: уровень
 * там всегда ноль, и затвор закрылся бы навсегда — человека не было бы слышно.
 */
function evaluateGate() {
  setGate(
    nextGate({
      level: micOn ? micLevelNorm() : 0,
      threshold: localAnalyser ? micThreshold : 0,
      now: performance.now(),
      openUntil: gateOpenUntil,
      holdMs: GATE_HOLD_MS,
    }),
  );
}
```

- [ ] **Шаг 7: реализация — метки и смена устройства.** В `refreshMicInfo`
  заменить две строки выбора дорожки на:

```ts
  // Метку/девайс берём с дорожки устройства — она и уходит собеседникам.
  const track = micTrack;
```

  В `setMic` всё от `const newTrack = stream.getAudioTracks()[0];` до
  `setupLocalVad();` заменить на:

```ts
  const newTrack = stream.getAudioTracks()[0];
  if (!newTrack) return;
  newTrack.contentHint = 'speech'; // голос, не музыка
  // Мут и затвор — до того, как дорожка попадёт к собеседникам: иначе между
  // replaceTrack и applyTrackState заглушённый человек на миг слышен.
  newTrack.enabled = micOn && gateOpen;

  const oldTrack = micTrack;
  around.replaceTrack(oldTrack, newTrack);
  if (oldTrack) {
    oldTrack.stop();
    around.stream()!.removeTrack(oldTrack);
  }
  around.stream()!.addTrack(newTrack);
  micTrack = newTrack;
  applyTrackState();

  setupLocalVad(); // переподцепляем анализатор к новому устройству
```

- [ ] **Шаг 8: реализация — одна формула.** Функцию `applyMute` заменить на:

```ts
/**
 * Привести дорожку микрофона к формуле `micOn && gateOpen`. Звук демонстрации
 * в том же потоке, но ни мут, ни затвор его не касаются.
 */
function applyTrackState() {
  const live = micOn && gateOpen;
  const screenAudio = around.screenAudioTrack();
  around
    .stream()
    ?.getAudioTracks()
    .forEach((t) => {
      if (t !== screenAudio) t.enabled = live;
    });
}

/**
 * Применить текущий мут к дорожкам исходящего потока и рассказать витрине.
 *
 * Зовётся и снаружи: при входе в канал поток только что собран, а мут на нём
 * уже свой — он переживает выход из эфира (под «глушилкой» микрофон остаётся
 * выключенным).
 */
export function applyMute() {
  applyTrackState();
  around.syncStore();
}
```

- [ ] **Шаг 9: реализация — анализатор на клоне и выход.** `setupLocalVad`,
  `teardownLocalVad` и `teardownMic` заменить на:

```ts
// Поднимает локальный анализатор микрофона. Слушает КЛОН дорожки: выключенная
// дорожка отдаёт тишину всем потребителям, и анализатор на ней самой не
// услышал бы голос, который должен открыть закрытый затвор.
function setupLocalVad() {
  teardownLocalVad();
  if (!micTrack || typeof window === 'undefined') return;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;
  try {
    const ctx = getAudioCtx();
    meterTrack = micTrack.clone();
    meterTrack.enabled = true; // клон наследует enabled — а при муте он был бы глухим
    localVadSource = ctx.createMediaStreamSource(new MediaStream([meterTrack]));
    localAnalyser = ctx.createAnalyser();
    localAnalyser.fftSize = ANALYSER_FFT_SIZE;
    localVadGain = ctx.createGain();
    localVadGain.gain.value = 0; // молча: только «протягиваем» сигнал ради анализа
    localVadSource.connect(localAnalyser);
    localAnalyser.connect(localVadGain);
    localVadGain.connect(ctx.destination);
  } catch (err) {
    console.warn('local VAD setup failed:', err);
    teardownLocalVad();
  }
}

function teardownLocalVad() {
  try {
    localVadSource?.disconnect();
    localAnalyser?.disconnect();
    localVadGain?.disconnect();
  } catch {
    /* узлы могли быть уже отключены */
  }
  meterTrack?.stop(); // клон держит устройство так же, как оригинал
  meterTrack = null;
  localVadSource = null;
  localAnalyser = null;
  localVadGain = null;
}
```

```ts
/**
 * Полный выход из эфира: гасим устройство и клон под анализатор. Оба держат
 * микрофон — забудь любой, и лампочка записи не гаснет до перезагрузки вкладки.
 */
export function teardownMic(): void {
  micTrack?.stop();
  micTrack = null;
  gateOpen = true;
  gateOpenUntil = 0;
  teardownLocalVad();
}
```

- [ ] **Шаг 10: зелёные тесты и типы.** Run: `…/vitest run lib/voice` и web
  `tsc --noEmit`. Expected: PASS. Затем
  `grep -n "rawMicTrack\|micPipelineActive\|micDest\|micGainNode\|micSource\|sentMicTrack\|ensureMicPipeline" apps/web/lib/voice/mic.ts`
  — пусто.

- [ ] **Шаг 11: полный веб.** Run: `…/vitest run` (весь apps/web) и eslint/prettier
  по `apps/web/lib/voice/mic.ts apps/web/lib/voice/mic.test.ts`. Expected: PASS.

- [ ] **Шаг 12: документация.** В `docs/media.md` строку таблицы модулей для
  `voice/mic.ts` заменить на:

```markdown
| [`voice/mic.ts`](../apps/web/lib/voice/mic.ts) | захват микрофона, шумодав/эхо/автоусиление, порог (затвор через `track.enabled`, анализатор на клоне), push-to-talk |
```

- [ ] **Шаг 13: коммит.**

```bash
git add apps/web/lib/voice/mic.ts apps/web/lib/voice/mic.test.ts docs/media.md
git commit -m "fix(voice): the mic threshold gates the device track, not a Web Audio copy

With a threshold set, peers used to get the output of GainNode ->
MediaStreamDestination: a second mic track, resampled to the output rate,
and a suspect in crackle on Linux. Now the device track is the one that
goes out; the gate flips track.enabled, and the level meter listens to a
clone, because a disabled track feeds silence to every consumer and the
gate would never reopen. Mute, push-to-talk and the gate share one rule:
enabled = micOn && gateOpen.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Задача 5. `WebRtcServer` в SFU (Б1)

**Файлы:**
- Изменить: `apps/sfu/src/media/media.config.ts`
- Изменить: `apps/sfu/src/media/workers.service.ts`
- Изменить: `apps/sfu/src/media/rooms.service.ts` (`Room`, `createRoom`, `createTransport`)
- Изменить: `apps/sfu/src/media/testkit.ts` (`FakeRouter`, `FakeWorkers`)
- Изменить: `apps/sfu/src/gateway/sfu.gateway.ts` (комментарий к `MAX_TRANSPORTS_PER_PEER`)
- Тесты: `apps/sfu/src/media/media.config.test.ts`, `workers.service.test.ts`, `rooms.service.test.ts`
- Документация: `docs/media.md` (раздел «Как устроен сервис»), `docs/self-hosting.md` (таблица переменных)

**Интерфейсы:**
- Производит: `rtcPortRange(): { min: number; max: number }`,
  `rtcPortCount(): number`, `webRtcServerOptions(index: number): types.WebRtcServerOptions`,
  `webRtcTransportOptions(webRtcServer: types.WebRtcServer): types.WebRtcTransportOptions`
  (из `media.config.ts`); `interface WorkerSlot { worker: types.Worker; webRtcServer: types.WebRtcServer }`,
  `WorkersService.take(): WorkerSlot`.

- [ ] **Шаг 1: тесты `media.config`.** В `apps/sfu/src/media/media.config.test.ts`
  импорт заменить на

```ts
import {
  MEDIA_CODECS,
  announcedIp,
  rtcPortCount,
  rtcPortRange,
  webRtcServerOptions,
  webRtcTransportOptions,
  workerSettings,
} from './media.config';
import type { types } from 'mediasoup';
```

  блок `describe('workerSettings', …)` заменить на

```ts
describe('порты', () => {
  it('дефолтный диапазон — тот, что открыт в compose и install.sh', () => {
    expect(rtcPortRange()).toEqual({ min: 40000, max: 40100 });
    expect(rtcPortCount()).toBe(101);
  });

  it('диапазон переопределяется из env', () => {
    process.env.SFU_RTC_MIN_PORT = '50000';
    process.env.SFU_RTC_MAX_PORT = '50500';
    expect(rtcPortRange()).toEqual({ min: 50000, max: 50500 });
  });

  it('мусор и ноль в env не превращаются в NaN-порт — берём дефолт', () => {
    for (const bad of ['abc', '0', '-1', '   ', '']) {
      process.env.SFU_RTC_MIN_PORT = bad;
      expect(rtcPortRange().min, bad).toBe(40000);
    }
  });

  it('перевёрнутый диапазон — ноль портов, а не отрицательное число', () => {
    process.env.SFU_RTC_MIN_PORT = '40100';
    process.env.SFU_RTC_MAX_PORT = '40000';
    expect(rtcPortCount()).toBe(0);
  });

  it('воркер больше не берёт порты из диапазона — у него свой WebRtcServer', () => {
    expect(workerSettings()).not.toHaveProperty('rtcMinPort');
    expect(workerSettings()).not.toHaveProperty('rtcMaxPort');
  });
});
```

  блок `describe('опции транспорта', …)` заменить на

```ts
describe('WebRtcServer и транспорт', () => {
  it('воркер i слушает min + i — UDP и TCP на одном номере', () => {
    const o = webRtcServerOptions(3);
    expect(o.listenInfos.map((i) => [i.protocol, i.port])).toEqual([
      ['udp', 40003],
      ['tcp', 40003],
    ]);
  });

  it('слушаем 0.0.0.0, а анонсируем публичный адрес', () => {
    process.env.SFU_ANNOUNCED_IP = '203.0.113.7';
    for (const info of webRtcServerOptions(0).listenInfos) {
      expect(info.ip).toBe('0.0.0.0');
      expect(info.announcedAddress).toBe('203.0.113.7');
    }
  });

  it('транспорт садится на сервер воркера и держит ICE-TCP', () => {
    const server = { id: 'srv' } as unknown as types.WebRtcServer;
    const o = webRtcTransportOptions(server) as types.WebRtcTransportOptions & {
      webRtcServer: types.WebRtcServer;
    };
    expect(o.webRtcServer).toBe(server);
    expect(o).not.toHaveProperty('listenInfos');
    expect(o.enableUdp).toBe(true);
    expect(o.enableTcp).toBe(true);
    expect(o.preferUdp).toBe(true);
  });
});
```

- [ ] **Шаг 2: реализация `media.config.ts`.** Функции `workerSettings` и
  `webRtcTransportOptions` заменить, добавить новые:

```ts
export function workerSettings(): types.WorkerSettings {
  return {
    logLevel: 'warn',
    logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
  };
}

/**
 * Диапазон RTC-портов из env. Раньше из него брал порт КАЖДЫЙ транспорт, и
 * сотни портов хватало человек на пятьдесят на весь сервер (у участника два
 * транспорта). Теперь каждый воркер слушает ровно один порт — `min + номер
 * воркера`, — а транспорты живут на нём и различаются по ICE ufrag. Диапазон
 * остался прежним, чтобы уже открытый фаервол продолжал подходить.
 */
export function rtcPortRange(): { min: number; max: number } {
  return {
    min: num(process.env.SFU_RTC_MIN_PORT, 40000),
    max: num(process.env.SFU_RTC_MAX_PORT, 40100),
  };
}

/** Сколько воркеров влезает в диапазон: по порту на каждого. */
export function rtcPortCount(): number {
  const { min, max } = rtcPortRange();
  return Math.max(0, max - min + 1);
}

/** WebRtcServer воркера `index`: UDP и TCP на одном порту `min + index`. */
export function webRtcServerOptions(index: number): types.WebRtcServerOptions {
  const port = rtcPortRange().min + index;
  const announcedAddress = announcedIp();
  return {
    listenInfos: [
      { protocol: 'udp', ip: '0.0.0.0', announcedAddress, port },
      { protocol: 'tcp', ip: '0.0.0.0', announcedAddress, port },
    ],
  };
}

export function webRtcTransportOptions(
  webRtcServer: types.WebRtcServer,
): types.WebRtcTransportOptions {
  return {
    webRtcServer,
    enableUdp: true,
    // ICE-TCP — единственный путь наружу из сетей, где UDP режут. Своим TURN
    // mediasoup ходить не умеет, так что это его единственная страховка.
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1_000_000,
  };
}
```

  Run: `…/vitest run src/media/media.config.test.ts` (sfu). Expected: PASS.

- [ ] **Шаг 3: тесты `workers.service`.** В `apps/sfu/src/media/workers.service.test.ts`
  фейковому воркеру добавить `createWebRtcServer` — функцию `fakeWorker` заменить на:

```ts
function fakeWorker(pid: number) {
  let onDied: (() => void) | undefined;
  const servers: { listenInfos: { port: number }[] }[] = [];
  return {
    pid,
    closed: false,
    servers,
    on(event: string, fn: () => void) {
      if (event === 'died') onDied = fn;
    },
    async createWebRtcServer(opts: { listenInfos: { port: number }[] }) {
      servers.push(opts);
      return { id: `srv-${pid}`, opts };
    },
    close() {
      this.closed = true;
    },
    die() {
      onDied?.();
    },
  };
}
```

  (интерфейс `FakeWorker` над ней удалить — тип выводится.) В `beforeEach` и
  `afterEach` к `delete process.env.SFU_WORKERS` добавить
  `delete process.env.SFU_RTC_MIN_PORT; delete process.env.SFU_RTC_MAX_PORT;`
  и `vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});` в
  `beforeEach`. Тест «воркеры получают настроенный диапазон портов» и тест
  «комнаты раздаются по кругу…» заменить на:

```ts
it('воркер i поднимает WebRtcServer на min + i', async () => {
  process.env.SFU_WORKERS = '3';
  process.env.SFU_RTC_MIN_PORT = '50000';
  process.env.SFU_RTC_MAX_PORT = '50100';
  await new WorkersService().onModuleInit();
  expect(made.map((w) => w.servers[0].listenInfos[0].port)).toEqual([50000, 50001, 50002]);
});

it('комнаты раздаются по кругу — воркер однопоточный, свалить всё в один нельзя', async () => {
  process.env.SFU_WORKERS = '2';
  const s = new WorkersService();
  await s.onModuleInit();
  const taken = [s.take(), s.take(), s.take()];
  expect(taken.map((t) => t.worker)).toEqual([made[0], made[1], made[0]]);
  expect(taken[0].webRtcServer).toEqual({ id: 'srv-1000', opts: made[0].servers[0] });
});

it('ядер больше, чем портов, — воркеров столько, сколько портов, и предупреждение', async () => {
  process.env.SFU_RTC_MIN_PORT = '40000';
  process.env.SFU_RTC_MAX_PORT = '40000';
  const warn = vi.spyOn(Logger.prototype, 'warn');
  await new WorkersService().onModuleInit();
  expect(made).toHaveLength(1);
  if (cpus().length > 1) expect(warn).toHaveBeenCalled();
});

it('явный SFU_WORKERS, который не влезает в диапазон, — громкий отказ на старте', async () => {
  process.env.SFU_WORKERS = '5';
  process.env.SFU_RTC_MIN_PORT = '40000';
  process.env.SFU_RTC_MAX_PORT = '40002';
  await expect(new WorkersService().onModuleInit()).rejects.toThrow(/SFU_WORKERS=5.*3/);
  expect(made).toHaveLength(0);
});

it('перевёрнутый диапазон — отказ на старте, даже без SFU_WORKERS', async () => {
  process.env.SFU_RTC_MIN_PORT = '40100';
  process.env.SFU_RTC_MAX_PORT = '40000';
  await expect(new WorkersService().onModuleInit()).rejects.toThrow(/SFU_RTC_MAX_PORT/);
});
```

  Run: `…/vitest run src/media/workers.service.test.ts`. Expected: FAIL (нет
  `createWebRtcServer`-вызова, `take()` отдаёт воркер).

- [ ] **Шаг 4: реализация `workers.service.ts`.** Файл целиком:

```ts
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { cpus } from 'node:os';
import * as mediasoup from 'mediasoup';
import type { types } from 'mediasoup';
import { rtcPortCount, rtcPortRange, webRtcServerOptions, workerSettings } from './media.config';

/** Воркер и его WebRtcServer — на нём живут все транспорты комнат воркера. */
export interface WorkerSlot {
  worker: types.Worker;
  webRtcServer: types.WebRtcServer;
}

/**
 * Пул mediasoup-воркеров. Воркер — отдельный C++-процесс, он однопоточный, так
 * что параллелизм даёт только их количество: заводим по числу ядер и раздаём
 * комнатам по кругу (комната целиком живёт в одном воркере — роутер не умеет
 * пересекать процессы).
 *
 * У каждого воркера свой WebRtcServer на одном порту: `SFU_RTC_MIN_PORT + i`,
 * UDP и TCP. Поэтому воркеров не больше, чем портов в диапазоне.
 */
@Injectable()
export class WorkersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkersService.name);
  private readonly slots: WorkerSlot[] = [];
  private next = 0;

  async onModuleInit(): Promise<void> {
    const count = this.workerCount();
    for (let i = 0; i < count; i++) {
      const worker = await mediasoup.createWorker(workerSettings());
      // Смерть воркера — это потеря всех комнат в нём, и починить это изнутри
      // нельзя: молча деградировать хуже, чем упасть и дать рестартнуть себя
      // рантайму compose (restart: unless-stopped).
      worker.on('died', () => {
        this.logger.error(`mediasoup worker ${worker.pid} died — exiting`);
        process.exit(1);
      });
      const webRtcServer = await worker.createWebRtcServer(webRtcServerOptions(i));
      this.slots.push({ worker, webRtcServer });
    }
    const { min } = rtcPortRange();
    this.logger.log(
      `mediasoup: ${count} worker(s), RTC ports ${min}-${min + count - 1} (UDP+TCP, one per worker)`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    for (const { worker } of this.slots) worker.close();
  }

  /** Следующий воркер по кругу — для новой комнаты. */
  take(): WorkerSlot {
    const slot = this.slots[this.next % this.slots.length];
    this.next++;
    return slot;
  }

  /**
   * Сколько воркеров заводить. Явный `SFU_WORKERS` — просьба человека: не
   * влезает в диапазон портов — отказ на старте, молча дать меньше хуже
   * рестарта. Число по ядрам — наше умолчание: на машине, где ядер больше, чем
   * портов, оно урезается до портов с предупреждением, а не роняет SFU, который
   * вчера работал.
   */
  private workerCount(): number {
    const ports = rtcPortCount();
    const { min, max } = rtcPortRange();
    if (ports < 1) {
      throw new Error(
        `SFU_RTC_MAX_PORT (${max}) is below SFU_RTC_MIN_PORT (${min}): no port for any worker`,
      );
    }
    const asked = Math.floor(Number(process.env.SFU_WORKERS ?? ''));
    if (Number.isFinite(asked) && asked >= 1) {
      if (asked > ports) {
        throw new Error(
          `SFU_WORKERS=${asked}, but SFU_RTC_MIN_PORT-SFU_RTC_MAX_PORT (${min}-${max}) holds only ${ports} port(s), one per worker. Widen the range or lower SFU_WORKERS.`,
        );
      }
      return asked;
    }
    const cores = Math.max(1, cpus().length);
    if (cores > ports) {
      this.logger.warn(
        `${cores} cores but only ${ports} RTC port(s) in ${min}-${max}: starting ${ports} worker(s). Widen SFU_RTC_MIN_PORT-SFU_RTC_MAX_PORT to use every core.`,
      );
      return ports;
    }
    return cores;
  }
}
```

  Run: `…/vitest run src/media/workers.service.test.ts`. Expected: PASS.

- [ ] **Шаг 5: тестовый набор и комнаты — тест.** В `apps/sfu/src/media/testkit.ts`:
  `FakeRouter.createWebRtcTransport` запоминает опции, `FakeWorkers.take`
  отдаёт слот:

```ts
  readonly transportOptions: unknown[] = [];

  async createWebRtcTransport(options?: unknown): Promise<FakeTransport> {
    if (this.failTransport) throw new Error('порты кончились');
    this.transportOptions.push(options);
    const t = new FakeTransport();
    this.transports.push(t);
    return t;
  }
```

```ts
export class FakeWorkers {
  readonly routers: FakeRouter[] = [];
  readonly servers: { id: string }[] = [];
  taken = 0;

  take() {
    this.taken++;
    const webRtcServer = { id: nextId('webrtc-server') };
    this.servers.push(webRtcServer);
    return {
      worker: {
        createRouter: async ({ mediaCodecs }: { mediaCodecs: unknown }) => {
          const router = new FakeRouter(mediaCodecs);
          this.routers.push(router);
          return router as unknown as types.Router;
        },
      } as unknown as types.Worker,
      webRtcServer: webRtcServer as unknown as types.WebRtcServer,
    };
  }
}
```

  В `apps/sfu/src/media/rooms.service.test.ts` тест «транспорт анонсирует внешний
  адрес, а не адрес контейнера» заменить на:

```ts
  it('транспорт садится на WebRtcServer воркера своей комнаты, а не на свой порт', async () => {
    const { peer } = await join('эфир', 'a');
    await rooms.createTransport(peer);
    const options = workers.routers[0].transportOptions[0] as { webRtcServer: unknown };
    expect(options.webRtcServer).toBe(workers.servers[0]);
    expect(options).not.toHaveProperty('listenInfos');
  });
```

  Run: `…/vitest run src/media/rooms.service.test.ts`. Expected: FAIL
  (`this.workers.take().createRouter is not a function`).

- [ ] **Шаг 6: реализация `rooms.service.ts`.** Тип комнаты:

```ts
interface Room {
  id: string;
  router: types.Router;
  /** Сервер воркера, где живёт роутер: транспорты комнаты садятся на его порт. */
  webRtcServer: types.WebRtcServer;
  peers: Map<string, Peer>;
}
```

  `createRoom`:

```ts
  private async createRoom(id: string): Promise<Room> {
    const { worker, webRtcServer } = this.workers.take();
    const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
    const room: Room = { id, router, webRtcServer, peers: new Map() };
    this.rooms.set(id, room);
    this.logger.log(`room "${id}" created (router ${router.id})`);
    return room;
  }
```

  Начало `createTransport`:

```ts
    const room = this.rooms.get(peer.room);
    if (!room) throw new Error('room is gone');
    const transport = await room.router.createWebRtcTransport(
      webRtcTransportOptions(room.webRtcServer),
    );
```

- [ ] **Шаг 7: комментарий лимита.** В `apps/sfu/src/gateway/sfu.gateway.ts`
  комментарий над `MAX_TRANSPORTS_PER_PEER` заменить на:

```ts
  /**
   * Потолки на участника. Транспортов ему нужно ровно два (send и recv), плюс
   * запас на пересборку: клиент строит новые до того, как сервер закроет старые.
   * Портов транспорты больше не едят (все живут на WebRtcServer воркера), но
   * каждый — это ICE/DTLS-состояние в однопоточном воркере, и цикл
   * переподключений у одного клиента иначе раздувал бы его для всей комнаты.
   * Дорожек четыре по числу ролей (mic/cam/screen/screen-audio), запас — на
   * пересоздание видео при смене камера↔экран.
   */
```

- [ ] **Шаг 8: весь sfu зелёный.** Run: sfu `vitest run` (весь пакет) и sfu `tsc`.
  Expected: PASS, без ошибок типов. Если `sfu.gateway.test.ts` падает — он
  ходит через `FakeWorkers`; чинить фейк, не проверки.

- [ ] **Шаг 9: документация.** В `docs/media.md`, «Как устроен сервис», пункт
  «Транспорты» заменить на:

```markdown
- **Транспорты** живут на `WebRtcServer` своего воркера: воркер `i` слушает один
  порт `SFU_RTC_MIN_PORT + i`, UDP и TCP, все его транспорты — на нём, различаются
  по ICE ufrag. Слушаем `0.0.0.0`, анонсируем `SFU_ANNOUNCED_IP` (или
  `TURN_EXTERNAL_IP`, или `SERVER_HOST`, если это IP). Воркеров не больше, чем
  портов в диапазоне: число по ядрам урезается с предупреждением, явный
  `SFU_WORKERS` сверх диапазона — отказ на старте. В compose сервис в
  `network_mode: host`.
```

  В той же таблице сравнения (начало файла) ячейку «CPU и UDP/TCP-порты
  `40000–40100`» заменить на «CPU; по UDP/TCP-порту на воркер из `40000–40100`».
  В `docs/self-hosting.md` строку `SFU_RTC_MIN_PORT` таблицы переменных заменить на:

```markdown
| `SFU_RTC_MIN_PORT` / `SFU_RTC_MAX_PORT` | `40000` / `40100` | порты медиа SFU: воркер `i` слушает `MIN + i` (UDP и TCP), воркеров не больше, чем портов |
```

- [ ] **Шаг 10: проверка docs.** Run:
  `docker run --rm -v "$PWD":/mono -w /mono node:20-alpine node tools/check-docs.mjs`.
  Expected: без ошибок.

- [ ] **Шаг 11: коммит.**

```bash
git add apps/sfu/src/media/media.config.ts apps/sfu/src/media/media.config.test.ts apps/sfu/src/media/workers.service.ts apps/sfu/src/media/workers.service.test.ts apps/sfu/src/media/rooms.service.ts apps/sfu/src/media/rooms.service.test.ts apps/sfu/src/media/testkit.ts apps/sfu/src/gateway/sfu.gateway.ts docs/media.md docs/self-hosting.md
git commit -m "feat(sfu): one WebRtcServer port per worker instead of a port per transport

Every WebRtcTransport took its own UDP and TCP port from 40000-40100,
shared by all workers: two transports per person capped the whole server
at about 50 people. Each worker now listens on a single port
(SFU_RTC_MIN_PORT + i, UDP+TCP) and all its transports live there, told
apart by ICE ufrag. The ports sit inside the range installs already open,
so firewalls and env stay as they are. Default worker count is clamped to
the range with a warning; an explicit SFU_WORKERS that does not fit fails
at startup.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Задача 6. E2E: что реально уходит в сеть

**Файлы:**
- Изменить: `e2e/fixtures/stand.ts` (`PersonOptions.initScript`, вызов в `person`)
- Создать: `e2e/tests/audio.spec.ts`

**Интерфейсы:**
- Потребляет: поведение задач 1, 2, 4 (голосовая m-линия: RED первым, `stereo=0`;
  отправляемая дорожка — с `deviceId`, затвор меняет `enabled`) и задачи 5
  (SFU-звонок в `sfu.spec.ts` на настоящем mediasoup).

- [ ] **Шаг 1: фикстура.** В `e2e/fixtures/stand.ts`, в `PersonOptions`:

```ts
  /**
   * Скрипт, который браузер выполнит до кода приложения на каждой странице
   * контекста. Нужен спекам, которые смотрят в само соединение: приложение
   * своих RTCPeerConnection наружу не отдаёт, и подсмотреть их можно, только
   * встав между ним и конструктором раньше него.
   */
  initScript?: () => void;
```

  В `person` сразу после `await ctx.addCookies(…)`:

```ts
  if (options.initScript) await ctx.addInitScript(options.initScript);
```

- [ ] **Шаг 2: спек.** Создать `e2e/tests/audio.spec.ts`:

```ts
import { expect, type Page } from '@playwright/test';
import { connected, joinVoice, person, test, unique } from '../fixtures/stand';

/**
 * Что уходит в сеть со звуком — то, чего не видно глазами и не слышно в CI.
 *
 * Три обещания из docs/plans/voice-quality.md, каждое из которых ломается
 * молча: голос договорён с RED (порядок кодеков в голосовой m-линии — по нему
 * и выбирают, чем слать; getStats RED не показывает), голос моно (stereo=0),
 * а при пороге в сеть уходит дорожка устройства, которую затвор выключает, —
 * а не выход Web Audio (у того нет deviceId).
 *
 * Канал — «P2P общий»: RED и стерео живут только в прямых звонках.
 */

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

/** Все соединения страницы — в window.__pcs, раньше, чем приложение создаст первое. */
function trackPeerConnections() {
  const Native = window.RTCPeerConnection;
  const pcs: RTCPeerConnection[] = [];
  (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs = pcs;
  window.RTCPeerConnection = class extends Native {
    constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
      super(...args);
      pcs.push(this);
    }
  } as typeof RTCPeerConnection;
}

/** Первый кодек и stereo голосовой (первой аудио) m-линии — своей и собеседника. */
function voiceLine(page: Page) {
  return page.evaluate(() => {
    const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs;
    const pc = pcs.filter((p) => p.connectionState === 'connected').at(-1)!;
    const read = (sdp: string) => {
      const audio = sdp.split(/\r\n(?=m=)/).find((s) => s.startsWith('m=audio'))!;
      const lines = audio.split('\r\n');
      const pts = lines[0].split(' ').slice(3);
      const codec = (pt: string) =>
        (lines.find((l) => l.startsWith(`a=rtpmap:${pt} `)) ?? '')
          .split(' ')[1]
          ?.split('/')[0]
          .toLowerCase();
      const opus = pts.find((pt) => codec(pt) === 'opus');
      const fmtp = lines.find((l) => l.startsWith(`a=fmtp:${opus} `)) ?? '';
      return { first: codec(pts[0]), stereo: /[; ]stereo=(\d)/.exec(fmtp)?.[1] };
    };
    return { local: read(pc.localDescription!.sdp), remote: read(pc.remoteDescription!.sdp) };
  });
}

/** Дорожка, которую реально отдаёт отправитель голоса. */
function sentVoice(page: Page) {
  return page.evaluate(() => {
    const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs;
    const pc = pcs.filter((p) => p.connectionState === 'connected').at(-1)!;
    const track = pc.getSenders().find((s) => s.track?.kind === 'audio')?.track;
    return { deviceId: track?.getSettings().deviceId ?? '', enabled: track?.enabled };
  });
}

test('голос уходит моно и с RED, а порог глушит дорожку устройства', async ({ browser }) => {
  test.setTimeout(180_000);
  const her = unique('Аня');
  const him = unique('Борис');
  const opts = { permissions: ['microphone'], initScript: trackPeerConnections };
  const anya = await person(browser, her, opts);
  const boris = await person(browser, him, opts);

  await joinVoice(anya, 'P2P общий', her);
  await joinVoice(boris, 'P2P общий', him);
  await connected(anya);
  await connected(boris);

  // Каждая сторона ставит RED первым у себя — значит, RED шлют обе.
  for (const page of [anya, boris]) {
    expect(await voiceLine(page)).toEqual({
      local: { first: 'red', stereo: '0' },
      remote: { first: 'red', stereo: '0' },
    });
  }

  // Порог на максимум: в сеть по-прежнему уходит дорожка устройства, и затвор
  // её выключает. Фейковый микрофон Chromium пищит раз в секунду — затвор может
  // приоткрыться на писке, поэтому ждём закрытого состояния опросом.
  await anya.getByRole('button', { name: 'Pick a microphone' }).click();
  const threshold = anya.getByLabel('Microphone activation threshold');
  await threshold.fill('100');
  await expect
    .poll(() => sentVoice(anya), { timeout: 15_000 })
    .toEqual({ deviceId: expect.stringMatching(/.+/), enabled: false });

  // Порог выключили — затвор открывается сразу.
  await threshold.fill('0');
  await expect.poll(() => sentVoice(anya), { timeout: 5_000 }).toMatchObject({ enabled: true });

  // Закрытый затвор не рвёт связь: пакеты тишины шли, сторож тишины молчал.
  await connected(boris);
});
```

- [ ] **Шаг 3: поднять стенд** (проект строго `relay-e2e`):

```bash
SITE_PASSWORD=testpass123 docker compose -p relay-e2e -f docker-compose.yml -f infra/docker-compose.e2e.yml up -d --build
```

  Дождаться здоровья api и медиасервера:

```bash
until [ "$(docker inspect -f '{{.State.Health.Status}}' relay-e2e-api-1)" = healthy ] && [ "$(docker inspect -f '{{.State.Health.Status}}' relay-e2e-sfu-e2e-1)" = healthy ]; do sleep 2; done
docker logs relay-e2e-sfu-e2e-1 2>&1 | grep "RTC ports"
```

  Expected в логе sfu: `mediasoup: N worker(s), RTC ports 40000-4000M (UDP+TCP, one per worker)`.

- [ ] **Шаг 4: прогнать спеки звука и SFU.**

```bash
CADDY_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' relay-e2e-caddy-1)
docker run --rm --network relay-e2e_default --add-host "relay.test:$CADDY_IP" \
  -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD":/work -w /work/e2e \
  -e BASE_URL=https://relay.test -e SITE_PASSWORD=testpass123 -e CI=1 \
  -e E2E_SFU_CONTAINER=relay-e2e-sfu-e2e-1 -e E2E_API_CONTAINER=relay-e2e-api-1 \
  mcr.microsoft.com/playwright:v1.55.0-noble \
  sh -c 'npm install --no-save @playwright/test@1.55.0 && npx playwright test tests/audio.spec.ts tests/voice.spec.ts tests/sfu.spec.ts'
```

  Expected: все зелёные. `sfu.spec.ts` — доказательство, что `WebRtcServer`
  работает на настоящем mediasoup: звонок через сервер встаёт, переживает смену
  режима и падение медиасервера. На перегруженной машине допустим один ретрай
  на «element is not stable» — это известная флака стенда, не наша.

- [ ] **Шаг 5: полный e2e тем же стендом** (без списка файлов в конце команды).
  Expected: зелёный. Потом снести стенд:

```bash
docker compose -p relay-e2e -f docker-compose.yml -f infra/docker-compose.e2e.yml down -v
```

- [ ] **Шаг 6: коммит.**

```bash
git add e2e/fixtures/stand.ts e2e/tests/audio.spec.ts
git commit -m "test(e2e): check what the voice line actually puts on the wire

RED first and stereo=0 on both sides of a direct call, and a threshold
that disables the device track instead of sending a Web Audio copy.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Задача 7. Разведка: RED через SFU (А1′)

**Файлы:**
- Изменить: `docs/plans/voice-quality.md` (раздел «А1′. Разведка RED через SFU» — дописать итог)
- Изменить: `docs/media.md` (одна строка в «Кодирование» раздела SFU)

Кода нет. Итог — рекомендация с источниками.

- [ ] **Шаг 1: собрать факты.** Ответить с источниками (ссылки на issue/PR/
  changelog/доки):
  1. Есть ли `audio/red` в `supportedRtpCapabilities` у последней версии mediasoup
     (npm `mediasoup`, файл `node/lib/supportedRtpCapabilities.js`), есть ли
     открытый issue/PR или форк с RED.
  2. Можно ли протащить RED через роутер «насквозь» без поддержки в mediasoup
     (объявить `audio/red` в `mediaCodecs` роутера) — проверить в `ortc.js`,
     что роутер делает с неизвестным `mimeType` (ожидание: отказ
     `UnsupportedError` при `createRouter`).
  3. Opus DRED (Opus 1.5+): есть ли в libwebrtc Chromium, как включается, нужен ли
     SFU для него (DRED едет внутри Opus-пакета — mediasoup его не разбирает).
  4. Покрывает ли in-band FEC участок «сервер → слушатель»: от чего зависит, что
     кодер включает FEC (`packetLossPercentage`/RTCP-отчёты), и что mediasoup
     шлёт производителю в RTCP — потери своего плеча или агрегат потребителей.

- [ ] **Шаг 2: записать итог.** В `docs/plans/voice-quality.md` под заголовком
  «А1′» — подраздел «Итог разведки»: ответы 1–4 и одна рекомендация (что
  делать дальше и во что обойдётся), со ссылками.

- [ ] **Шаг 3: строка в media.md.** В `docs/media.md`, «Кодирование» (SFU),
  после «Голос — те же потолки Opus, что в mesh.» добавить одну строку — вывод
  разведки (например: «RED в SFU нет: mediasoup не знает `audio/red`; см.
  docs/plans/voice-quality.md»), формулировку взять из итога.

- [ ] **Шаг 4: коммит.**

```bash
git add docs/plans/voice-quality.md docs/media.md
git commit -m "docs(sfu): what it would take to carry RED through the media server

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Задача 8. Хвост для iOS и финальная проверка

**Файлы:**
- Изменить: `docs/plans/old/native-clients.md` (раздел iOS)

- [ ] **Шаг 1: хвост iOS.** В `docs/plans/old/native-clients.md`, в раздел про
  iOS, пункт в список «Осталось»:

```markdown
- **голос моно и RED, как в вебе** (docs/plans/voice-quality.md, А1–А2):
  `Core/SDP.swift` ставит `stereo=1` всем Opus-линиям — голос уходит стерео;
  RED — `setCodecPreferences` голосовому трансиверу в `CallEngine`. Совместимость
  не страдает и без этого: iOS просто не получает выгоды.
```

- [ ] **Шаг 2: полный прогон веба, api, sfu, shared.** Как в CONTRIBUTING
  (с временной базой, проект не `relay`):

```bash
docker network create relay-vq-test
docker run -d --rm --name relay-vq-db --network relay-vq-test -e POSTGRES_USER=relay -e POSTGRES_PASSWORD=relay -e POSTGRES_DB=relay_test postgres:16-alpine
until docker exec relay-vq-db pg_isready -U relay -d relay_test; do sleep 1; done
for pkg in apps/web apps/sfu packages/shared; do docker run --rm -v "$PWD":/mono -w /mono/$pkg node:20-alpine sh -c './node_modules/.bin/vitest run' || echo "FAIL $pkg"; done
docker run --rm --network relay-vq-test -v "$PWD":/mono -w /mono/apps/api -e TEST_DATABASE_URL=postgresql://relay:relay@relay-vq-db:5432/relay_test node:20-alpine sh -c './node_modules/.bin/vitest run'
docker stop relay-vq-db; docker network rm relay-vq-test
```

  Expected: все зелёные. Плюс типы web и sfu, eslint и prettier по всем
  изменённым файлам, `tools/check-docs.mjs`.

- [ ] **Шаг 3: коммит.**

```bash
git add docs/plans/old/native-clients.md
git commit -m "docs(ios): note the mono voice and RED follow-up for the native client

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Самопроверка плана

- Покрытие спецификации: А2 → задача 1; А1 → задача 2; А3 → задачи 3–4; Б1 →
  задача 5; проверка на живых браузерах и настоящем mediasoup → задача 6; А1′ →
  задача 7; iOS-хвост → задача 8.
- Имена сквозные: `cmpMid` (задача 2 ↔ output.ts), `nextGate`/`GateState`
  (3 ↔ 4), `WorkerSlot`/`take()`/`webRtcTransportOptions(server)` (5: workers ↔
  rooms ↔ testkit), `initScript` (6: фикстура ↔ спек).
- Порядок: задачи 1–2 и 3–4 независимы от 5; задача 6 — после 1, 2, 4, 5.
