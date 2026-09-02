import type { AppServer, AppSocket } from './socket-data';

/**
 * Где человек сейчас — на всю инсталляцию.
 *
 * `recent` — «только что был»: человек закрыл вкладку или у него моргнула сеть.
 * `offline` в списке не хранится вовсе, он и означает «этой личности в картине
 * нет»; уезжает он только дельтой — тем единственным событием, которым у
 * собеседника гаснет зелёная точка.
 *
 * Форма совпадает с одноимёнными типами из `@relay/shared`: api намеренно не
 * зависит от пакета фронта, и контракт здесь держится совпадением, а не общим
 * импортом (см. ./protocol).
 */
export type PresenceState = 'online' | 'in-voice' | 'recent' | 'offline';

export interface PresenceEntry {
  /** Отпечаток ключа: им человек назван всюду, где он адресат (ЛС, звонок). */
  fingerprint: string;
  state: PresenceState;
  /** Когда это состояние началось, мс Unix. */
  since: number;
}

/**
 * Что присутствие спрашивает у того, чем не владеет.
 *
 * Список из двух вопросов, и это не бедность интерфейса, а его граница: кто
 * этот сокет (личность или никто) и сидит ли он в эфире. Всё остальное —
 * комнаты, права, видимость каналов — присутствия не касается: оно глобальное
 * по построению.
 */
export interface PresenceSurroundings {
  /** Личность за сокетом. Пусто у гостя по инвайту и у неопознанного клиента. */
  identityOf(sock: AppSocket): { id: string; fingerprint: string } | undefined;
  /** Сидит ли этот сокет в голосовом канале — из этого и берётся «в голосе». */
  inVoice(sock: AppSocket): boolean;
}

/**
 * Владелец глобального присутствия: кто из личностей сейчас на связи.
 *
 * Пер-канальный `voice-presence` отвечает на вопрос «кто в этой комнате», и для
 * дозвона он бесполезен: звонят человеку, а не комнате, и до ответа комнаты
 * ещё нет вовсе. Здесь отвечают на второй вопрос — «где вообще этот человек», —
 * и ответ один на всю инсталляцию.
 *
 * Три инварианта, на которых держится этот ответ:
 *
 * 1. **Присутствие принадлежит личности, а не сокету.** Одно устройство ушло —
 *    человек не ушёл; «в голосе» с телефона сильнее «в сети» с ноутбука. Считай
 *    мы по сокетам, у человека с двумя вкладками было бы два присутствия, и
 *    звонить пришлось бы выбранной вкладке (см. `picture`).
 * 2. **Ушедший гаснет не сразу.** `RECENT_MS` — окно, в котором человек ещё
 *    «недавно», а не «не в сети» (см. `RECENT_MS`).
 * 3. **Картина всегда пересчитывается целиком из живых сокетов.** `touch` и
 *    `drop` — только повод пересчитать, а не запись состояния. Голосовое
 *    состояние меняется из десятка мест (вход, выход, бан, удаление канала,
 *    истёкший грейс), и перечисли мы их поимённо — присутствие расходилось бы с
 *    правдой ровно в том месте, которое забыли (см. `restate`).
 *
 * Гостя по инвайту в присутствии нет ни одной стороной: личности он не
 * предъявлял, звонить ему некуда, а состав инсталляции за инвайт утекать не
 * должен. Правило это записано в одном месте — в `identityOf`: нет личности —
 * нет и присутствия, ни своего, ни чужого.
 */
export class Presence {
  /**
   * Сколько человек числится «недавно» после ухода последнего устройства.
   *
   * Две минуты — это про человека, а не про сеть: перезагрузка страницы, потеря
   * вайфая в лифте и «отошёл на минуту» не должны выглядеть как «не в сети»,
   * иначе звонить будет некому в самый обычный момент. Дольше держать нельзя по
   * той же причине: «недавно» у того, кого нет уже полчаса, — враньё, на
   * котором строят несостоявшийся звонок.
   *
   * `VoiceSessions.LEAVE_GRACE_MS` (24 с) сюда не годится, хотя и похож по
   * смыслу: он отмеряет окно восстановления сессии socket.io — техническую
   * величину, привязанную к `connectionStateRecovery`. Это окно обязано быть
   * ДЛИННЕЕ его: иначе человек успевал бы стать «не в сети» здесь, всё ещё
   * занимая плитку в эфире там.
   */
  static readonly RECENT_MS = 120_000;

  /** Пачка изменений за окно = одна дельта. То же окно, что и у реестра. */
  private static readonly UPDATE_DEBOUNCE_MS = 80;

  /** Разосланная картина: identityId → запись, какой её знают клиенты. */
  private people = new Map<string, PresenceEntry>();

  private updateTimer: ReturnType<typeof setTimeout> | null = null;

  /** Будильник на угасание ближайшего «недавно» — один на всех, см. `planFade`. */
  private fadeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly serverOf: () => AppServer,
    private readonly around: PresenceSurroundings,
  ) {}

  private get server(): AppServer {
    return this.serverOf();
  }

  // ── Поводы пересчитать ────────────────────────────────────────────────────

  /**
   * Сокет подключился или сменил голосовое состояние — пересчитать личность и
   * разослать изменение.
   *
   * Личность названа параметром, а пересчитывается всё равно вся картина, и это
   * намеренно: аргумент говорит, ЧТО случилось, а инвариант 3 не даёт этому
   * знанию стать вторым способом считать состояние.
   */
  touch(_identityId: string): void {
    this.schedule();
  }

  /**
   * Сокет отключился. Ушёл ли при этом человек — здесь не решается: сокет мог
   * быть не последним у этой личности (второе устройство), и правду знает
   * только общий пересчёт.
   */
  drop(_identityId: string): void {
    this.schedule();
  }

  // ── Чтение ────────────────────────────────────────────────────────────────

  /**
   * Снимок для этого сокета: только те, кого ему положено видеть.
   *
   * Сокет в параметрах, потому что видеть положено не всякому: у гостя по
   * инвайту и у клиента без личности присутствия нет вовсе, и пустой список —
   * это ответ, а не заглушка.
   *
   * Считается заново, а не берётся из разосланной картины: снимок уезжает на
   * подключении, то есть в тот самый момент, когда ещё не разослана дельта про
   * самого подключившегося. Разошедшийся на 80 мс снимок дал бы человеку
   * картину, в которой его самого нет.
   */
  snapshot(client: AppSocket): PresenceEntry[] {
    if (!this.around.identityOf(client)) return [];
    return [...this.picture(Date.now()).values()];
  }

  /**
   * Где эта личность прямо сейчас. Спрашивается в момент решения — можно ли
   * дозвониться, — поэтому считается по живым сокетам, а не по разосланной
   * картине: та отстаёт на окно коалесцирования, и звонок «не в сети» человеку,
   * который вошёл 50 мс назад, был бы отказом на пустом месте.
   */
  stateOf(identityId: string): PresenceState {
    return this.picture(Date.now()).get(identityId)?.state ?? 'offline';
  }

  // ── Как считается картина ─────────────────────────────────────────────────

  /**
   * Кто где прямо сейчас. Ничего не рассылает и ничего не запоминает — по этой
   * карте считается и снимок, и дельта, и оба поэтому не могут разойтись.
   *
   * Живые сокеты дают «в сети» и «в голосе», а тот, кого среди них нет, но кто
   * ещё числится, — «недавно», пока не вышел грейс. Вышел — личности в карте
   * больше нет, и это и есть «не в сети»: хранить всех, кто когда-либо заходил,
   * значило бы хранить список личностей инсталляции второй раз.
   */
  private picture(now: number): Map<string, PresenceEntry> {
    const next = new Map<string, PresenceEntry>();
    for (const sock of this.server.sockets.sockets.values()) {
      const who = this.around.identityOf(sock);
      if (!who) continue;
      const state: PresenceState = this.around.inVoice(sock) ? 'in-voice' : 'online';
      // Инвариант 1: «в голосе» с одного устройства сильнее «в сети» с
      // остальных — человек звонит, а не просто открыл вкладку.
      if (state === 'online' && next.has(who.id)) continue;
      next.set(who.id, {
        fingerprint: who.fingerprint,
        state,
        since: this.sinceOf(who.id, state, now),
      });
    }
    for (const [id, was] of this.people) {
      if (next.has(id)) continue;
      if (was.state !== 'recent') {
        next.set(id, { fingerprint: was.fingerprint, state: 'recent', since: now });
      } else if (now - was.since < Presence.RECENT_MS) {
        next.set(id, was);
      }
    }
    return next;
  }

  /**
   * С какого момента человек в этом состоянии. Состояние то же, что и было, —
   * значит и момент прежний: иначе «в сети с» подпрыгивало бы на каждый чужой
   * вход, а по этому же полю считается и угасание «недавно».
   */
  private sinceOf(id: string, state: PresenceState, now: number): number {
    const was = this.people.get(id);
    return was && was.state === state ? was.since : now;
  }

  /**
   * Запомнить новую картину и вернуть то, чем она отличается от разосланной.
   * Пропавший из картины уезжает записью `offline` — клиенту нужно событие, а
   * не отсутствие события.
   */
  private restate(now: number): PresenceEntry[] {
    const next = this.picture(now);
    const changed: PresenceEntry[] = [];
    for (const [id, entry] of next) {
      if (this.people.get(id)?.state !== entry.state) changed.push(entry);
    }
    for (const [id, was] of this.people) {
      if (!next.has(id))
        changed.push({ fingerprint: was.fingerprint, state: 'offline', since: now });
    }
    this.people = next;
    return changed;
  }

  // ── Рассылка ──────────────────────────────────────────────────────────────

  /**
   * Разослать изменение. Коалесцирующий (trailing-edge) дебаунс: таймер уже
   * взведён — ничего не делаем. Окно то же, что у реестра и у состава эфиров:
   * человек, открывший вкладку, меняет картину один раз, а не столько раз,
   * сколько событий он при этом породил.
   */
  private schedule(): void {
    if (this.updateTimer) return;
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      this.publish();
    }, Presence.UPDATE_DEBOUNCE_MS);
    this.updateTimer.unref?.();
  }

  private publish(): void {
    const now = Date.now();
    const changed = this.restate(now);
    this.planFade(now);
    if (!changed.length) return;
    for (const sock of this.server.sockets.sockets.values()) {
      if (this.around.identityOf(sock)) sock.emit('presence-update', changed);
    }
  }

  /**
   * Будильник на ближайшее угасание. Без него «недавно» гасло бы не по времени,
   * а по чужому событию: человек, ушедший из тихой инсталляции, оставался бы
   * «недавно» до следующего чьего-нибудь входа — то есть до утра.
   *
   * Таймер один на всех и взводится на самый ранний уход: остальные к этому
   * моменту либо тоже угаснут (их посчитает тот же пересчёт), либо получат свой
   * будильник следом.
   */
  private planFade(now: number): void {
    if (this.fadeTimer) {
      clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
    }
    let earliest = Infinity;
    for (const entry of this.people.values()) {
      if (entry.state === 'recent') earliest = Math.min(earliest, entry.since);
    }
    if (earliest === Infinity) return;
    this.fadeTimer = setTimeout(
      () => {
        this.fadeTimer = null;
        this.publish();
      },
      Math.max(0, earliest + Presence.RECENT_MS - now),
    );
    this.fadeTimer.unref?.();
  }
}
