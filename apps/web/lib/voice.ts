'use client';

import { toast } from 'sonner';
import type { VoicePresence } from '@relay/shared';
import { getSocket } from '@/lib/socket';
import { getSfx } from '@/lib/sfx';
import { useUiStore, myName } from '@/stores/ui';
import { loadClientId } from '@/lib/identity';
import { tx as msg } from '@/lib/i18n';
import type { MessageKey, Vars } from '@/lib/i18n/translate';
import { useVoiceStore } from '@/stores/voice';
import { createMeshTransport } from '@/lib/voice/mesh';
import { voiceSupport } from '@/lib/voice-support';
import { diag } from '@/lib/voice/diag';
import { mediaErrorText } from '@/lib/voice/device-error';
import { forgetSpeaker, resetSpeaking, startSpeakingWatch } from '@/lib/voice/speaking';
import {
  attachRemoteAudio,
  cleanupPeerAudio,
  detachRemoteAudio,
  initOutput,
  isSpeakersOn,
  refreshOutputDevices,
  setPeerGain,
  setSpeakersOn,
  teardownPeerAudio,
} from '@/lib/voice/output';

import {
  applyMute,
  ensureLocalStream,
  initMic,
  isMicOn,
  loadMicThreshold,
  refreshMicInfo,
  setMicOn,
  startGate,
  teardownMic,
} from '@/lib/voice/mic';

// Микшер, устройство вывода и захват микрофона живут в своих файлах. Наружу
// уезжают отсюда: компоненты знают один адрес, `@/lib/voice`.
export { refreshSpeakers, resumeVoiceAudio, setSpeaker } from '@/lib/voice/output';
import {
  currentScreenMode,
  currentVideoTrack,
  initCamera,
  isCamOn,
  isScreenOn,
  screenAudio,
  screenDegradation,
  teardownVideo,
} from '@/lib/voice/camera';

export {
  refreshCameras,
  setCamera,
  setScreenMode,
  toggleCamera,
  toggleScreen,
} from '@/lib/voice/camera';
export {
  desktopPtt,
  getMicLevel,
  loadMediaPrefs,
  refreshMics,
  setMic,
  setMicThreshold,
  setNoiseSuppression,
  setPushToTalk,
} from '@/lib/voice/mic';
import type { TransportHost, VoiceTicket, VoiceTransport } from '@/lib/voice/types';
import {
  addTile,
  clearFocus,
  clearTiles,
  dropRemoteTiles,
  initTiles,
  relabelSelf as relabelTile,
  remoteCount,
  removeTile,
  renameTile,
  roleOf,
  savePeerVol,
  setTileNet,
  setTileScreen,
  setTileState,
  setTileVideoOn,
  syncPeerRoles,
  tileOf,
} from '@/lib/voice/tiles';

// Плитки, роли собеседников, громкости и крупный план живут в `voice/tiles.ts`
// — это витрина, и дирижёру от неё нужно только уметь её звать. Наружу они
// уезжают отсюда же: компоненты знают один адрес, `@/lib/voice`.
export {
  clearFocus,
  PEER_VOL_MAX,
  setFocus,
  setPeerScreenVolume,
  setPeerVolume,
  toggleFocus,
} from '@/lib/voice/tiles';

const sfx = () => getSfx();

/**
 * Дирижёр звонка: заход и выход, выбор и смена транспорта, разбор
 * расщепления, события сокета.
 *
 * Всё, что можно было отсюда унести, унесено: захват (`voice/mic.ts`,
 * `voice/camera.ts`), микшер и вывод (`voice/output.ts`), плитки
 * (`voice/tiles.ts`), обводка (`voice/speaking.ts`). Осталось то, что не
 * принадлежит никому из них по отдельности, — сама сессия. Именно её надо
 * уметь прочесть целиком, когда звонок ведёт себя странно.
 *
 * Своего состояния здесь ровно три вещи, и каждая нужна всем сразу: комната,
 * исходящий набор дорожек (в него кладут и микрофон, и камеру, и экран) и
 * право говорить. Остальное дирижёр не хранит, а спрашивает.
 *
 * Доставку медиа собеседникам дирижёр НЕ делает сам — этим занят транспорт за
 * интерфейсом `VoiceTransport` (`lib/voice/types.ts`): mesh (`voice/mesh/`)
 * или медиасервер (`voice/sfu/`). Активен всегда ровно один.
 *
 * Наружу — реактивная витрина через `useVoiceStore`, которую рисуют
 * VideoGrid/Controls/Members, и один адрес импорта для компонентов: части
 * звонка реэкспортируются отсюда, чтобы `@/lib/voice` оставался единственным.
 */

let room: string | null = null;
let localStream: MediaStream | null = null;

/**
 * Слушатель: мы пришли по инвайту в канал закрытого сервера. Слышим комнату,
 * но своего медиа не отдаём — микрофон не просим вовсе (браузер и не спросит),
 * камеру и демонстрацию не показываем. Право это выдаёт сервер подписью в
 * гостевом токене, здесь оно только объявлено: настоящие заслоны стоят на
 * медиасервере (`produce` получает отказ) и у собеседников (входящий звук
 * слушателя они отбрасывают). Ставится один раз гостевой сценой до входа.
 */
let listenOnly = false;

let initialized = false;
let pingTimer: ReturnType<typeof setInterval> | null = null;

const socket = () => getSocket();

// Транспорты медиа. Оба создаются лениво (host ссылается на функции ниже по
// файлу) и живут всё время работы приложения; активен всегда ровно один — его
// выбирает `pickTransport` при входе в канал, по режиму самого канала.
//
// Mesh при этом подписан на сигналинг всегда, но реагирует, только пока в нём
// есть комната: войдя в SFU-канал, мы ему `join` не даём, и приходящие
// `peers`/`offer` он игнорирует.
let meshTransport: VoiceTransport | null = null;
let sfuTransport: VoiceTransport | null = null;
let transport: VoiceTransport | null = null;

function mesh(): VoiceTransport {
  if (!meshTransport) {
    meshTransport = createMeshTransport(host);
    meshTransport.init();
  }
  return meshTransport;
}

// Грузим по требованию: `mediasoup-client` весит заметно, а self-host без
// медиасервера живёт целиком на p2p — незачем возить его в общем бандле тем,
// кто ни разу не зайдёт в SFU-канал.
async function sfu(): Promise<VoiceTransport> {
  if (!sfuTransport) {
    const { createSfuTransport } = await import('@/lib/voice/sfu');
    sfuTransport = createSfuTransport(host);
    sfuTransport.init();
  }
  return sfuTransport;
}

/** Активный транспорт. Вне звонка — mesh: он и по умолчанию, и на фолбэк. */
function tx(): VoiceTransport {
  return transport ?? mesh();
}

/**
 * То, что транспорт вправе спросить у дирижёра: локальные дорожки на отправку и
 * витрину на приём. Единственная дверь между ними — что и позволит подставить
 * вместо mesh реализацию на SFU, не трогая ни UI, ни устройства.
 */
const host: TransportHost = {
  localStream: () => localStream,
  screenAudioTrack: () => screenAudio(),
  videoTrack: () => currentVideoTrack(),
  camOn: () => isCamOn(),
  screenOn: () => isScreenOn(),
  screenDegradation: () => screenDegradation(),

  addTile,
  removeTile,
  setTileState,
  setTileNet,
  cleanupPeerAudio,
  attachRemoteAudio,
  detachRemoteAudio,
  transportLost: onTransportLost,
  diag,
  setStatus,
  setPing: (ping) => useVoiceStore.getState().setPing(ping),
  setUplink: (status) => useVoiceStore.getState().setUplink(status),
  playSfx: (name) => sfx().play(name),
};

/**
 * Обновляет videoOn локальной плитки и рассылает собеседникам полное медиасостояние
 * (видео + мут/глушилка). Сервер запоминает мут на сокете и раздаёт его через
 * voice-presence — индикаторы в сайдбаре видят даже те, кто сам не в эфире.
 */
function broadcastMediaState() {
  const on = isCamOn() || isScreenOn();
  setTileVideoOn('local', on);
  if (room)
    socket().emit('media-update', {
      camOn: isCamOn(),
      screenOn: isScreenOn(),
      micOn: isMicOn(),
      deafened: !isSpeakersOn(),
    });
}

function setStatus(key: MessageKey, vars?: Vars) {
  useVoiceStore.getState().setStatus({ key, vars });
}

// Был ли включён микрофон до «глушилки» — чтобы вернуть его при включении звука.
let micWasOnBeforeDeafen = true;

/**
 * Переключает глобальный мут всех звуков сайта (пиры + sfx) — режим «глушилки»
 * (deafen, как в Discord). Выключил звук — микрофон гаснет автоматически (не
 * слышишь — не говоришь); включил обратно — микрофон возвращается в то
 * состояние, в котором был до глушилки.
 */
export function toggleSpeakers() {
  const on = !isSpeakersOn();
  setSpeakersOn(on);
  getSfx().setAllMuted(!on);
  // «Не слышишь — не говоришь»: это правило дирижёра, а не микшера. Микшер
  // знает только про мастер-громкость, микрофон ему не принадлежит.
  if (!on) {
    micWasOnBeforeDeafen = isMicOn();
    setMicOn(false);
  } else {
    setMicOn(micWasOnBeforeDeafen);
  }
  broadcastMediaState();
}

// ─────────────────────────────────────────────────────────────────────────
// Вступление в голосовой канал
// ─────────────────────────────────────────────────────────────────────────

/**
 * Спрашиваем у api пропуск в медиасервер для канала. Ответ и есть выбор
 * транспорта: пропуск дали — канал в режиме SFU и сервер поднят; отказали
 * (`not-sfu`, `unavailable`) — идём в mesh, это штатный путь, а не ошибка.
 *
 * Таймаут короткий и намеренный: канал в SFU-режиме, но api молчит — звонок не
 * должен из-за этого ждать. Молчание = mesh.
 */
async function requestSfuTicket(targetRoom: string): Promise<VoiceTicket | null> {
  try {
    // Имя — в запросе: `join` ещё не случился, серверу его больше взять неоткуда.
    const res = await socket()
      .timeout(3000)
      .emitWithAck('sfu-token', { room: targetRoom, name: myName() });
    if (!res.ok) {
      // 'not-sfu' — штатный p2p-канал; остальные отказы означают, что канал
      // ЖДАЛ медиасервер, а мы уезжаем в p2p — веху обязан увидеть сервер.
      if (res.error !== 'not-sfu') diag('sfu-ticket denied', res.error);
      return null;
    }
    return { url: res.url, token: res.token };
  } catch {
    diag('sfu-ticket timeout'); // api не ответил вовремя — звоним напрямую
    return null;
  }
}

// Порог мягкого переезда в p2p, когда медиасервер умер посреди звонка. Двое-
// трое собеседников mesh переживёт; на 4+ с видео он даёт ровно ту боль, ради
// которой SFU и затевался, — там честнее ждать сервер, чем задушить всех
// аплинком. Считаем собеседников, себя не учитываем.
const MESH_FALLBACK_MAX_PEERS = 3;
const SFU_RETRY_MS = 5000;
let sfuRetryTimer: ReturnType<typeof setTimeout> | null = null;

function leaveTransports() {
  meshTransport?.leave();
  sfuTransport?.leave();
  transport = null;
}

/**
 * Номер текущего переезда. Между «отцепиться от старого транспорта» и
 * «объявиться на новом» есть await (запрос пропуска, загрузка чанка mediasoup), и
 * за это время вполне прилетает второй переезд: владелец щёлкнул режим канала
 * дважды, следом упал медиасервер. Обгонять себя тут нельзя — старый переезд
 * доехал бы уже после нового и оставил бы позади живой сокет медиасервера при
 * mesh-плитках, то есть звонок без звука и без пути назад. Каждый переезд берёт
 * номер и сходит с дистанции, увидев, что появился следующий.
 */
let migration = 0;

/**
 * Подключить транспорт к комнате и объявиться на сигналинге. Пропуск = выбор
 * транспорта: он есть — идём в SFU, нет — в mesh.
 *
 * `gen` спрашиваем, а не берём сами: номер принадлежит тому заходу или переезду,
 * который сюда привёл, и взять его здесь — значит объявить себя последним уже
 * после того, как нас обогнали.
 */
async function enterRoom(target: string, ticket: VoiceTicket | null, gen: number) {
  // Транспорт медиасервера может не подняться у нас самих: чанк
  // `mediasoup-client` весит заметно и грузится по требованию, а сеть на входе в
  // канал — та же, что только что моргнула. Бросать на этом весь заход нельзя:
  // канал у человека уже открыт, и остаться в нём без единого `join` — это
  // «подключено» с полной тишиной и без пути назад. Едем прямыми звонками, как
  // при любом другом отказе медиасервера.
  let pass = ticket;
  let next: VoiceTransport;
  try {
    next = pass ? await sfu() : mesh();
  } catch (err) {
    diag('sfu start failed', String((err as Error)?.message ?? err));
    next = mesh();
    pass = null;
  }
  if (room !== target || gen !== migration) return; // ушли в другой канал/переезд
  // Транспорт, который мы сменяем, обязан уйти сам. Просто перестать на него
  // смотреть — не то же самое, что выйти: он держит свой сокет, свои дорожки и
  // наш микрофон, то есть продолжает звонить в комнату, из которой мы ушли.
  if (transport && transport !== next) transport.leave();
  transport = next;
  next.join(target, pass ?? undefined);
  socket().emit('join', {
    room: target,
    name: myName(),
    clientId: loadClientId(),
    // Транспорт — в join: сервер раздаст его остальным в presence. Иначе
    // разъехавшиеся участники видят друг друга в канале и молча не слышат.
    transport: pass ? 'sfu' : 'p2p',
  });
  // После join: сервер уже знает имя и впишет его в строку лога.
  diag('transport', `${pass ? 'sfu' : 'mesh'} room="${target}"`);
  // Сразу за join — своё медиасостояние: сервер только что сбросил его, а мут/
  // глушилка могли остаться с прошлого канала.
  broadcastMediaState();
  setStatus('voice.status.connected', { room: target });
}

/**
 * Переезд на другой транспорт, не выходя из канала: сюда сходятся фолбэк на
 * p2p, возвращение медиасервера и смена режима канала владельцем. Звук пропадёт
 * на пару секунд — это дешевле, чем мост между транспортами.
 */
async function remigrate(force?: 'mesh') {
  const target = room;
  if (!target) return;
  const gen = ++migration;
  holdSplitChecks();
  cancelSfuRetry();
  leaveTransports();
  dropRemoteTiles();
  const ticket = force === 'mesh' ? null : await requestSfuTicket(target);
  if (room !== target || gen !== migration) return; // нас обогнал следующий переезд
  await enterRoom(target, ticket, gen);
  if (gen !== migration) return;
  // Осадку считаем от СВОЕГО приезда: остальные едут своим ходом, и тот, у кого
  // пропуск выписывался дольше всех, ещё в дороге.
  holdSplitChecks();
}

function cancelSfuRetry() {
  if (sfuRetryTimer) clearTimeout(sfuRetryTimer);
  sfuRetryTimer = null;
}

/** Ждём возвращения медиасервера, пока канал слишком велик для прямых звонков. */
function scheduleSfuRetry() {
  cancelSfuRetry();
  sfuRetryTimer = setTimeout(() => {
    sfuRetryTimer = null;
    void (async () => {
      const target = room;
      if (!target) return;
      // Круг ожидания принадлежит ТОМУ звонку, в котором начался. Отменить его
      // после `await` уже нечем (таймер отработал, тело живёт само), а комната
      // за эти секунды успевает смениться и даже вернуться той же: человек
      // вышел и зашёл снова. Раньше сходства слага хватало, чтобы запоздавший
      // круг разобрал заново собранный звонок и пересобрал его поверх себя.
      const gen = migration;
      const ticket = await requestSfuTicket(target);
      if (room !== target || gen !== migration) return;
      if (!ticket) {
        scheduleSfuRetry(); // всё ещё лежит — заходим на следующий круг
        return;
      }
      diag('sfu-retry', 'ok — moving back to sfu');
      const moving = ++migration;
      holdSplitChecks();
      leaveTransports();
      dropRemoteTiles();
      await enterRoom(target, ticket, moving);
      if (moving !== migration) return;
      holdSplitChecks();
      toast.success(msg('voice.toast.sfuBack'));
    })();
  }, SFU_RETRY_MS);
}

// Комната разъехалась в транспортах: часть через медиасервер, часть напрямую.
// Слышать друг друга такие участники не могут в принципе — это не деградация
// качества, а полная тишина, причём выглядящая как «он в канале, но молчит».
// Съезжаем в p2p всей комнатой: он собирает всех, тогда как медиасервер собрать
// не всех может (старый клиент про него не знает, у кого-то он не поднялся).
// Но только пока комната мала: тащить туда 4+ — ровно та боль, ради которой SFU
// и заводился, там честнее сказать правду и оставить как есть.
let splitHandled = false;

// Комната переезжает не мгновенно и не у всех разом: пока идёт переезд,
// участники НЕИЗБЕЖНО оказываются на разных транспортах — один уже в
// медиасервере, другой ещё ждёт пропуск (до трёх секунд). Это середина переезда,
// а не расщепление, и фолбэк на него — та самая кнопка «оборвать звонок»: первый
// переехавший тут же тащил себя обратно в mesh, за ним второй, и комната
// расходилась по транспортам уже всерьёз, без пути назад. Поэтому на время
// переезда разбор расщепления откладываем — но именно откладываем, а не
// пропускаем: осевшее расщепление обязано быть замечено, даже если нового
// presence больше не придёт.
const MIGRATION_SETTLE_MS = 6000;
let settleUntil = 0;
let splitTimer: ReturnType<typeof setTimeout> | null = null;
let lastPresence: VoicePresence = {};

/** Отложить разбор расщепления: комната сейчас переезжает. */
function holdSplitChecks() {
  settleUntil = Math.max(settleUntil, Date.now() + MIGRATION_SETTLE_MS);
}

function cancelSplitCheck() {
  if (splitTimer) clearTimeout(splitTimer);
  splitTimer = null;
}

/** Вернуться к разбору расщепления, когда комната осядет. */
function scheduleSplitCheck(ms: number) {
  cancelSplitCheck();
  splitTimer = setTimeout(() => {
    splitTimer = null;
    if (!room) return;
    const wait = settleUntil - Date.now();
    if (wait > 0) {
      scheduleSplitCheck(wait); // переезд успел продлиться — ждём дальше
      return;
    }
    evaluateSplit();
  }, ms);
}

function onPresence(presence: VoicePresence) {
  useVoiceStore.getState().setPresence(presence);
  lastPresence = presence;
  syncPeerRoles(presence, room);
  if (!room) {
    splitHandled = false;
    cancelSplitCheck();
    return;
  }
  const wait = settleUntil - Date.now();
  if (wait > 0) {
    scheduleSplitCheck(wait);
    return;
  }
  evaluateSplit();
}

/**
 * Выгнать гостя из эфира. Право проверяет сервер (любой НЕ-гость, кому виден
 * канал); здесь — только отправка и внятный ответ человеку.
 */
export function kickGuest(peerId: string, name: string) {
  socket().emit('guest-kick', { id: peerId }, (res) => {
    if (res?.ok) toast(msg('members.kick.done', { name }));
    else if (res?.error === 'not-found') toast(msg('members.kick.gone', { name }));
    else toast.error(msg('members.kick.failed'));
  });
}

function evaluateSplit() {
  if (!room) return;
  // Транспорт ещё не выбран: идёт заход или переезд, пропуск в пути. «Нет
  // транспорта» — это не «звоню напрямую», а сравнивать нам пока не с чем.
  // Раньше это читалось как p2p, и заход в людной SFU-канал встречал человека
  // красной ошибкой «тебя не слышат» ещё до того, как он куда-либо подключился.
  // Не бросаем, а откладываем: расщепление обязано быть замечено и после.
  if (!transport) {
    scheduleSplitCheck(MIGRATION_SETTLE_MS);
    return;
  }
  const myId = socket().id;
  const others = (lastPresence[room] ?? []).filter((p) => p.id !== myId);
  const mine = transport === sfuTransport ? 'sfu' : 'p2p';
  const apart = others.filter((p) => (p.transport ?? 'p2p') !== mine);
  if (apart.length === 0) {
    splitHandled = false;
    return;
  }
  if (splitHandled) return; // уже отреагировали на это расщепление
  splitHandled = true;
  const names = apart.map((p) => p.name || msg('voice.peer.fallback')).join(', ');
  diag('transport split', `me=${mine} apart=${apart.length} (${names})`);
  if (mine === 'sfu' && others.length <= MESH_FALLBACK_MAX_PEERS) {
    toast(msg('voice.toast.peersDirect', { names }));
    void remigrate('mesh');
    return;
  }
  // Съезжать некуда: либо нас слишком много для прямых звонков, либо напрямую
  // звоним как раз мы. Молчать нельзя — человек должен понимать, почему тишина.
  toast.error(
    mine === 'sfu' ? msg('voice.toast.peerCannotHear', { names }) : msg('voice.toast.youAreDirect'),
  );
  sfx().play('error');
}

/**
 * SFU-транспорт исчерпал свою лестницу восстановления. Решение принимаем здесь:
 * только дирижёр знает состав канала и владеет комнатой.
 */
function onTransportLost(reason: 'setup' | 'lost') {
  if (!room || transport !== sfuTransport) return;
  // На входе — всегда в p2p: человек ещё никого не слышал, ждать ему нечего.
  if (reason === 'setup' || remoteCount() <= MESH_FALLBACK_MAX_PEERS) {
    diag('sfu-lost', `${reason} → mesh fallback`);
    toast.error(msg('voice.toast.sfuDownDirect'));
    sfx().play('error');
    void remigrate('mesh');
    return;
  }
  diag('sfu-lost', `${reason} → waiting for sfu (${remoteCount()} peers)`);
  toast.error(msg('voice.toast.sfuDownWaiting'));
  sfx().play('error');
  setStatus('voice.status.sfuWaiting');
  scheduleSfuRetry();
}

/**
 * Объявить себя слушателем — гостевая сцена делает это до входа, прочитав
 * право из подписанного инвайт-токена (см. GuestStage). Меняет ровно две вещи:
 * микрофон не берём и микрофон считаем выключенным. Всё остальное — обычный
 * звонок: слушателя видно в составе канала, он слышит всех и уходит как все.
 */
export function setListenOnly(on: boolean) {
  listenOnly = on;
  if (!on) return;
  setMicOn(false);
  useVoiceStore.getState().setListenOnly(true);
  syncMediaState();
}

export async function joinVoice(newRoom: string, label: string) {
  // Уже на связи в этой комнате — значит, мы просто смотрели текст: показываем сетку
  if (newRoom === room) {
    useUiStore.setState({ view: 'voice', voiceRoom: room, voiceLabel: label });
    return;
  }

  // Возможности движка проверяем ДО микрофона: в WebKitGTK без WebRTC
  // getUserMedia отработает, а RTCPeerConnection нет — раньше это давало вход в
  // канал с зажжённым микрофоном и полной тишиной без единой ошибки.
  const support = voiceSupport();
  if (!support.ok) {
    toast.error(msg('voice.toast.joinFailed', { reason: support.message }));
    setStatus('voice.status.unsupported');
    sfx().play('error');
    return;
  }

  // Заход — не одно действие: впереди два ожидания подряд (устройство, пропуск
  // в медиасервер), и на каждом человек успевает щёлкнуть соседний канал. Заход
  // берёт номер и сходит с дистанции, увидев, что появился следующий, — тем же
  // способом, что и переезд (см. `migration`). Сравнения слагов тут мало:
  // «щёлкнул соседний канал и вернулся» даёт тот же слаг у обоих заходов, и
  // обогнанный доезжает ПОСЛЕ нового, вставая поверх него — с живым сокетом
  // второго транспорта за спиной.
  if (room) leaveVoice(false); // мягко переключаемся между голосовыми — поток живёт
  const gen = ++migration;

  if (!localStream && listenOnly) {
    // Слушателю устройство не нужно, и спрашивать его — врать: отдать эту
    // дорожку всё равно некуда. Пустой поток не заглушка, а честная форма того
    // же состояния: транспорт спрашивает у дирижёра локальные дорожки и
    // получает пустой набор (см. mesh: он попросит приём отдельно).
    localStream = new MediaStream();
  }
  if (!localStream) {
    setStatus('voice.status.micRequesting');
    try {
      await ensureLocalStream();
    } catch (err) {
      console.error('getUserMedia failed:', err);
      setStatus('voice.status.micDenied');
      toast.error(msg('voice.toast.joinFailedMic', { reason: mediaErrorText(err) }));
      sfx().play('error'); // отказано в доступе к устройству
      return;
    }
    if (gen !== migration) return; // пока ждали микрофон, ушли в другой канал
  }

  room = newRoom;

  useUiStore.setState({ view: 'voice', voiceRoom: room, voiceLabel: label });

  addTile('local', msg('common.you', { name: myName() }), localStream, true);
  applyMute();
  syncMediaState();

  // Транспорт выбираем ДО `join`: сразу за ним сервер пришлёт состав комнаты, и
  // к этому моменту должно быть решено, кто его слушает. Спрашиваем у api — не
  // у своего реестра каналов: гость по инвайту реестра не получает вовсе, а
  // разъехавшись с остальными в транспорте, он останется без звука.
  const ticket = await requestSfuTicket(newRoom);
  if (room !== newRoom || gen !== migration) return; // нас обогнал следующий заход
  await enterRoom(newRoom, ticket, gen);
  if (room !== newRoom || gen !== migration) return;
  sfx().play('join'); // вышли на связь

  // Подсказка про смену микрофона — один раз, чтобы знали, где переключить.
  // Слушателю её не показываем: у него нет ни микрофона, ни самой кнопки, на
  // которую она указывает.
  if (
    !listenOnly &&
    typeof localStorage !== 'undefined' &&
    !localStorage.getItem('relay-mic-hint')
  ) {
    localStorage.setItem('relay-mic-hint', '1');
    toast(msg('voice.toast.micHint'), { duration: 7000 });
  }
}

// hard=true — полная демобилизация (освобождаем камеру/микрофон, меняем вид).
// hard=false — мягкий выход при переключении голосовых: поток и вид оставит вызывающий.
export function leaveVoice(hard = true) {
  if (hard && room) sfx().play('leave'); // покидаем звонок (не при смене канала)
  cancelSfuRetry();
  splitHandled = false;
  // Незавершённый переезд обязан сойти с дистанции вместе с нами: доехав уже
  // после выхода, он объявился бы в покинутой комнате.
  migration++;
  cancelSplitCheck();
  settleUntil = 0;
  lastPresence = {};
  if (room) socket().emit('leave');
  leaveTransports(); // следующий вход выберет транспорт заново
  teardownPeerAudio();
  clearFocus();
  clearTiles();
  room = null;

  if (!hard) return;

  // Камеру и микрофон освобождаем только при полном выходе
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  teardownMic();
  resetSpeaking();
  teardownVideo();
  // Микрофон к следующему входу включаем, но глушилка переживает выход из эфира —
  // под ней микрофон остаётся выключенным (не слышишь — не говоришь). Слушателю
  // включать нечего: права говорить выход из канала ему не добавил.
  setMicOn(!listenOnly && isSpeakersOn());
  micWasOnBeforeDeafen = true;
  syncMediaState();

  // Голос отключили, но текстовый канал мог остаться открытым — показываем его
  const ui = useUiStore.getState();
  if (ui.textRoom) {
    useUiStore.setState({ view: 'text', voiceRoom: null, voiceLabel: '' });
    setStatus('voice.status.inTextChannel', { channel: ui.textLabel || '# ' + ui.textRoom });
  } else {
    useUiStore.setState({ view: 'lobby', voiceRoom: null, voiceLabel: '' });
    setStatus('voice.status.disconnected');
  }
}

/**
 * Смена тега на лету: обновляем подпись своей плитки и шлём серверу rename —
 * тот обновит presence голосового канала и ростер текстового, а собеседникам
 * разошлёт peer-renamed (подписи наших плиток у них).
 */
/**
 * Подпись своей плитки. Ярлык собирает дирижёр: «ты» рядом с именем — это его
 * формулировка, а не свойство плитки.
 */
export function relabelSelf(name: string) {
  relabelTile(msg('common.you', { name }));
}

export function renameSelf(name: string) {
  relabelSelf(name);
  socket().emit('rename', { name });
}

/**
 * Клик по статусу в панели голоса — вернуться к видеосетке. На мобиле это ещё и
 * переход на экран сцены: сама панель голоса живёт в сайдбаре, то есть жмут её
 * с экрана каналов.
 */
export function showVoiceStage() {
  if (!room) return;
  useUiStore.setState({ view: 'voice', mobilePanel: 'stage' });
}

// ─────────────────────────────────────────────────────────────────────────
// Микрофон / камера / демонстрация экрана
// ─────────────────────────────────────────────────────────────────────────

function syncMediaState() {
  useVoiceStore.getState().setMedia({
    micOn: isMicOn(),
    camOn: isCamOn(),
    screenOn: isScreenOn(),
    screenMode: currentScreenMode(),
  });
}

export function toggleMic() {
  if (listenOnly) return; // включать нечего: микрофон мы не брали
  // Включение микрофона под «глушилкой» снимает и её (как в Discord): нелепо
  // говорить, не слыша ответов. toggleSpeakers сам вернёт микрофон и разошлёт.
  if (!isMicOn() && !isSpeakersOn()) {
    micWasOnBeforeDeafen = true;
    toggleSpeakers();
    return;
  }
  setMicOn(!isMicOn());
  broadcastMediaState();
}

// ─────────────────────────────────────────────────────────────────────────
// Инициализация: socket-обработчики дирижёра (один раз на приложение).
// Сигналинг медиа (offer/answer/ice/состав пиров) слушает транспорт — см.
// его init(); здесь остаётся то, что от транспорта не зависит.
// ─────────────────────────────────────────────────────────────────────────

export function initVoice() {
  if (initialized) return;
  initialized = true;

  loadMicThreshold(); // применится при следующем входе в эфир

  // Подключили/отключили устройство — обновляем списки в сторе
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    void refreshMicInfo();
    refreshOutputDevices();
  });

  // Витрина плиток — то, чего она сама не знает: звук пира, его громкость и
  // крупный план. Всё трое принадлежат микшеру и транспорту, поэтому и
  // спрашиваются, а не берутся.
  initTiles({
    dropAudio: cleanupPeerAudio,
    setGain: setPeerGain,
    focusChanged: (id) => tx().focusChanged?.(id),
  });
  // Микшер снимает узлы ушедшего сам, а вот «когда он в последний раз говорил»
  // — это уже обводка плитки, и живёт она здесь.
  initOutput({ forgetSpeaker });
  // Микрофон кладёт свою дорожку в общий исходящий поток — тот же, куда потом
  // попадут камера и экран. Поток принадлежит дирижёру, поэтому спрашивается.
  initMic({
    stream: () => localStream,
    adopt: (stream) => {
      localStream = stream;
    },
    screenAudioTrack: screenAudio,
    replaceTrack: (from, to) => tx().replaceMicTrack(from, to),
    syncStore: syncMediaState,
    announce: broadcastMediaState,
  });
  // Камера и экран делят один видео-слот у собеседников, а поток и транспорт —
  // с микрофоном. Своего у них только сами дорожки.
  initCamera({
    stream: () => localStream,
    maySend: () => !listenOnly,
    publish: (what) => (what === 'camera' ? tx().publishVideo() : tx().publishScreen()),
    unpublish: (what) => (what === 'camera' ? tx().unpublishVideo() : tx().unpublishScreen()),
    retune: () => tx().retuneVideo(),
    syncStore: syncMediaState,
    announce: broadcastMediaState,
  });

  const s = socket();

  mesh().init(); // mesh слушает сигналинг всегда — он же и транспорт по умолчанию

  s.on('peer-joined', ({ name }) => {
    setStatus('voice.status.peerJoined', { name: name || msg('voice.peer.fallback') });
    sfx().play('peerJoin'); // звук подключения участника
    // Новичок ещё не знает, что мы показываем экран/камеру: media-update летит
    // только на переключении. Повторяем текущее состояние, чтобы его плитка
    // сразу знала про наше видео (флаг videoOn), а не ждала косвенных сигналов.
    if (isCamOn() || isScreenOn()) broadcastMediaState();
  });

  s.on('media-update', ({ from, camOn: peerCam, screenOn: peerScreen }) => {
    setTileVideoOn(from, peerCam || peerScreen);
    // Экран в видеослоте собеседника — не косметика: плитка показывает такой
    // кадр целиком (а не обрезает по краям), а погасший флаг — сигнал «показ
    // окончен», по которому крупный план сам возвращается в сетку.
    setTileScreen(from, peerScreen);
  });

  // Собеседник сменил тег — обновляем подпись его плитки и имя пира.
  s.on('peer-renamed', ({ id, name }) => {
    tx().renamePeer(id, name);
    const t = tileOf(id);
    if (t && t.name !== name) {
      // Имя сменилось — переносим сохранённую громкость на новое, чтобы
      // выкрученные проценты не потерялись. Касается это только гостя по
      // инвайту: отпечатка ему не выдают, и имя — единственный его ключ. У
      // человека с ключом громкость записана на отпечаток и переименования
      // не замечает вовсе.
      if (!roleOf(id)?.fingerprint && (t.volume !== 1 || t.screenVolume !== 1))
        savePeerVol(id, name, { voice: t.volume, screen: t.screenVolume });
      renameTile(id, name);
    }
  });

  // Владелец сменил транспорт канала прямо во время звонка — переезжаем все
  // вместе. Событие летит в комнату (а не только с реестром каналов) как раз
  // ради гостей: реестра у них нет, а разъехаться в транспортах нельзя.
  s.on('voice-mode', ({ room: changed, mode }) => {
    if (!room || changed !== room) return;
    toast(
      msg('voice.toast.modeSwitched', {
        mode: msg(mode === 'sfu' ? 'voice.toast.mode.sfu' : 'voice.toast.mode.p2p'),
      }),
    );
    // Мы уже на том транспорте, который канал только что объявил, — ехать
    // некуда. Переезд стоит секунд тишины на ровном месте: он снимает плитки и
    // пересобирает все соединения заново. Чаще всего это случается с тем, кто
    // и так звонил напрямую (медиасервер не поднялся у него одного), а владелец
    // как раз поэтому канал и переключил. Транспорта нет вовсе — значит идёт
    // заход или переезд, и гадать нечего: едем.
    const settled = mode === 'sfu' ? transport === sfuTransport : transport === meshTransport;
    if (settled) {
      // Круг ожидания вернувшегося медиасервера ждать больше нечего: канал
      // прямой. Иначе он так и стучался бы в api каждые пять секунд.
      if (mode === 'p2p') cancelSfuRetry();
      return;
    }
    void remigrate();
  });

  s.on('voice-presence', (p: VoicePresence) => {
    onPresence(p && typeof p === 'object' ? p : {});
  });

  // Нас выгнали из эфира (только гостевой сценарий: выгоняют гостя). Сервер уже
  // выписал из комнаты и закрыл вход по той же ссылке на час — сворачиваем
  // звонок и поднимаем флаг: пропавший без объяснений звук человек читает как
  // поломку и лезет чинить микрофон.
  s.on('kicked', () => {
    useVoiceStore.getState().setKicked(true);
    if (!room) return;
    sfx().play('error');
    leaveVoice();
  });

  // Вход в канал закрытого сервера отбит: пропуска нет или он умер (сменили
  // пароль). Сервер нас в комнату не пустил, а клиент об этом раньше не знал —
  // и оставался «в канале», которого для сервера нет: без звука, без состава и
  // без единой подсказки, что нужен пароль. Уходим по-настоящему и говорим об
  // этом. Комната в событии своя у каждого отказа — чужую не трогаем.
  s.on('voice-locked', ({ room: locked }) => {
    if (!room || room !== locked) return;
    toast.error(msg('voice.toast.locked'));
    sfx().play('error');
    leaveVoice();
  });

  s.on('connect', () => {
    // Свой id нужен, чтобы пометить себя в составе голосовых каналов
    useVoiceStore.getState().setMyId(s.id ?? null);
    if (!room) return;
    // Сессия восстановлена после кратковременного обрыва (socket.io connection
    // state recovery): id и комнаты те же, сервер не выкидывал нас из канала,
    // P2P-медиа всё это время могло течь. Звонок не пересобираем — иначе он
    // дёргался бы на каждое моргание сети, — но и «всё само» тут неверно: то же
    // моргание рвёт ICE, а лестница восстановления без сигналинга стоит на паузе.
    // Пусть транспорт догонит тех, кто с связи всё-таки слетел.
    if (s.recovered) {
      setStatus('voice.status.connected', { room });
      tx().resync?.();
      return;
    }
    // Полноценный реконнект: у сокета новый id — все старые соединения мертвы,
    // собираем заново.
    tx().reset();
    toast(msg('voice.toast.serverBack'));
    sfx().play('reconnect'); // связь восстановлена
    if (transport === sfuTransport) {
      // Пропуск в медиасервер выписан на прежний socket.id и вместе с ним умер —
      // нужен новый, а значит полный переезд, а не просто повторный join.
      void remigrate();
      return;
    }
    // Транспорт называем и здесь: до сюда доходит только mesh (у SFU выше свой
    // путь — ему нужен новый пропуск), но сервер, которому не сказали, гадает по
    // выданному пропуску, а гадание про транспорт стоит целого канала.
    s.emit('join', { room, name: myName(), clientId: loadClientId(), transport: 'p2p' });
    setStatus('voice.status.connected', { room });
  });

  s.on('disconnect', () => {
    if (!room) return;
    setStatus('voice.status.serverLost');
    toast(msg('voice.toast.serverLost'));
    sfx().play('connLost'); // обрыв связи
  });

  // Метрики связи — целиком дело транспорта: он один знает, что и у кого мерить.
  if (!pingTimer) pingTimer = setInterval(() => tx().pollStats(), 3000);

  // Обводка «говорит сейчас» — частый, но дешёвый опрос анализаторов
  startSpeakingWatch(() => room !== null);

  // Шумовой гейт микрофона — отдельный, более частый тик для быстрой атаки
  startGate();
}
