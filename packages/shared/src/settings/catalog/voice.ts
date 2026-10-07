/** Каталог настроек, группа `voice` — голос и медиа. */

import { SECRET_MAX, URL_MAX } from '../limits';
import type { SettingSpec } from '../spec';

export const VOICE_SETTINGS: readonly SettingSpec[] = [
  { key: 'voice.videoEnabled', group: 'voice', kind: 'boolean', fallback: true, applies: 'now' },
  {
    key: 'voice.screenShareEnabled',
    group: 'voice',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  // 128 кбит/с — MIC_AUDIO_MAX_BITRATE, 2500 — VIDEO_MAX_BITRATE
  // (apps/web/lib/voice/mesh/senders.ts): столько потоки берут сегодня.
  {
    key: 'voice.audioBitrateKbps',
    group: 'voice',
    kind: 'number',
    fallback: 128,
    applies: 'new',
    min: 8,
    max: 256,
    client: true,
  },
  {
    key: 'voice.videoBitrateKbps',
    group: 'voice',
    kind: 'number',
    fallback: 2500,
    applies: 'new',
    min: 100,
    max: 8000,
    client: true,
  },
  // Трансляция экрана. Потолок высоты — сколько стример вправе снять, битрейт —
  // сколько уходит на одного зрителя в верхнем слое. Это деньги владельца:
  // каждый, кто нажал «Смотреть», — ещё один такой поток с медиасервера.
  // Умолчания — те, ради которых трансляция и затевалась: 1440p, а битрейт с
  // запасом под самое тяжёлое сочетание (1440p60 — около 13 Мбит/с).
  {
    key: 'voice.screenMaxHeight',
    group: 'voice',
    kind: 'select',
    fallback: '1440',
    applies: 'new',
    options: ['720', '1080', '1440'],
    client: true,
  },
  {
    key: 'voice.screenBitrateKbps',
    group: 'voice',
    kind: 'number',
    fallback: 15000,
    applies: 'new',
    min: 1000,
    max: 20000,
    client: true,
  },
  {
    key: 'voice.noiseSuppressionDefault',
    group: 'voice',
    kind: 'boolean',
    fallback: true,
    applies: 'new',
    client: true,
  },
  {
    key: 'voice.autoGainControlDefault',
    group: 'voice',
    kind: 'boolean',
    fallback: true,
    applies: 'new',
    client: true,
  },
  {
    key: 'voice.pushToTalkDefault',
    group: 'voice',
    kind: 'boolean',
    fallback: false,
    applies: 'new',
    client: true,
  },
  // Окно восстановления связи — RECOVER_WINDOW_MS в lib/voice/sfu/recovery.ts.
  {
    key: 'voice.iceRestartSeconds',
    group: 'voice',
    kind: 'number',
    fallback: 8,
    applies: 'new',
    min: 2,
    max: 60,
    client: true,
  },
  /**
   * Инфраструктура: адреса и секреты TURN и медиасервера. В панели показаны,
   * но не правятся, и это не осторожность, а правда — их читает не только api:
   * coturn и SFU поднимаются тем же `.env` рядом. Правка в таблице разошлась бы
   * с тем, что реально слушает порт, и это худший вид расхождения — звонок
   * собирается, а звука нет.
   */
  {
    key: 'voice.turnUrls',
    group: 'voice',
    kind: 'text',
    fallback: '',
    applies: 'env',
    max: URL_MAX,
    env: 'TURN_URLS',
    readOnly: true,
  },
  {
    key: 'voice.turnSecretSet',
    group: 'voice',
    kind: 'secret',
    fallback: '',
    applies: 'env',
    max: SECRET_MAX,
    secret: true,
    env: 'TURN_SECRET',
    readOnly: true,
  },
  {
    key: 'voice.sfuUrl',
    group: 'voice',
    kind: 'text',
    fallback: '',
    applies: 'env',
    max: URL_MAX,
    env: 'SFU_URL',
    readOnly: true,
  },
  {
    key: 'voice.sfuSecretSet',
    group: 'voice',
    kind: 'secret',
    fallback: '',
    applies: 'env',
    max: SECRET_MAX,
    secret: true,
    env: 'SFU_SECRET',
    readOnly: true,
  },
];
