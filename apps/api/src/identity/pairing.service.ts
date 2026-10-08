import { Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource, In, IsNull, type EntityManager } from 'typeorm';
import { DeviceRow, IdentityRow, MessageRow, RoleRow } from '../db/entities';
// Значением, а не `import type`: тип стирается при сборке, и
// `emitDecoratorMetadata` записывает в довод конструктора `Function` вместо
// класса — Nest такой довод не разрешает и падает при старте. Тесты этого не
// видят: они собирают сервисы руками, минуя контейнер.
import { SettingsService } from '../settings/settings.service';
import { fingerprint, newPairCode, verifySignature } from './crypto';
import { certificateMessage, isPairCode, type PairOffer } from '@relay/shared';
import { WindowCounter } from '../window-counter';

/**
 * Связка второго устройства с уже живущей личностью.
 *
 * Направление здесь обратное тому, к какому приучили ссылки-приглашения: код
 * показывает НОВОЕ устройство, а старое — сканирует и подтверждает. Так код
 * перестаёт быть пропуском на предъявителя: подсмотревший чужой экран может
 * лишь предложить себя, а впустить в личность способен только тот, кто в ней
 * уже есть. Побочная выгода не меньше: донор видит ключ, который подписывает,
 * и подписывает его сразу — иначе сертификату потребовался бы второй круг
 * («покажи мне ключ, которого я ещё не видел»).
 *
 * Просьбы живут в памяти три минуты — по той же причине, что и нонсы входа
 * (см. `identity.service.ts`): строка в базе ради значения, которое ценно
 * ровно до следующего запроса, стоит дороже, чем сама связка.
 *
 * Чем платим: связка не переживает рестарт api (человек показывает код заново)
 * и не работает на второй реплике. Второе — общая беда сессий слоя 2, и чинить
 * её надо разом, а не тут.
 */

/** Сколько живёт код. Успеть надо взять второе устройство в руки, не больше. */
const PAIR_TTL_MS = 3 * 60 * 1000;

/** Потолок незакрытых просьб на инсталляцию — та же защита, что у нонсов. */
const MAX_PENDING = 1_000;

/**
 * Промахов по коду на личность за минуту. Шесть цифр — это миллион, но без
 * счётчика их перебирают за минуты: подобравший чужой код перехватил бы чужое
 * новое устройство в свою личность.
 */
const MAX_MISSES = 10;
const MISS_WINDOW_MS = 60 * 1000;

export type PairFailure =
  /** Просится устройство личности, которая уже пожила: это уже не связка, а слияние. */
  | 'has-history'
  /** Кода нет, он протух или это вообще не код. */
  | 'bad-code'
  /** Слишком много промахов подряд — похоже на перебор. */
  | 'too-many'
  /** Сертификат не сошёлся с ключом донора. */
  | 'bad-signature'
  /** Код введён на том же устройстве, которое его показало. */
  | 'self'
  /**
   * У личности уже столько устройств, сколько разрешил владелец
   * (`access.maxDevicesPerIdentity`). Отказ свой, а не общий: чинится он
   * отзывом лишнего устройства, а не новым кодом.
   */
  | 'too-many-devices';

export type PairResult<T> = ({ ok: true } & T) | { ok: false; reason: PairFailure };

/** Просьба, ждущая подтверждения. Живёт в памяти и три минуты. */
interface Waiting {
  identityId: string;
  deviceId: string;
  publicKey: string;
  deviceName: string;
  expiresAt: number;
  /**
   * Подтверждение уже в пути. Ставится синхронно, до первого `await`: два
   * подтверждения одного кода разом (двойной клик, две личности, увидевшие
   * один экран) иначе прошли бы оба, и «впустили» сказали бы обоим.
   */
  taken?: boolean;
}

@Injectable()
export class PairingService {
  private readonly logger = new Logger('pairing');
  private readonly waiting = new Map<string, Waiting>();
  private readonly misses = new WindowCounter(MISS_WINDOW_MS);

  constructor(
    private readonly db: DataSource,
    private readonly settings: SettingsService,
    @Optional() private readonly now: () => number = Date.now,
  ) {}

  /**
   * «Впустите меня»: устройство просит связки и получает код, который покажет
   * человеку. Проверка на прожитую жизнь стоит здесь, а не в подтверждении, —
   * человек узнает о невозможности до того, как побежит за вторым устройством.
   */
  async ask(device: DeviceRow): Promise<PairResult<{ code: string; expiresIn: number }>> {
    const { id: deviceId, identityId } = device;
    if (!(await this.stillborn(this.db.manager, identityId, deviceId)))
      return { ok: false, reason: 'has-history' };

    this.sweep();
    if (this.waiting.size >= MAX_PENDING) {
      this.logger.warn('слишком много незакрытых просьб — новая не выдана');
      return { ok: false, reason: 'too-many' };
    }

    // Одно устройство — одна просьба: показанный минуту назад код больше не
    // работает, иначе брошенные коды копились бы до конца своего срока.
    for (const [code, w] of this.waiting) if (w.deviceId === deviceId) this.waiting.delete(code);

    const code = this.freeCode();
    this.waiting.set(code, {
      identityId,
      deviceId,
      publicKey: device.publicKey,
      deviceName: device.name,
      expiresAt: this.now() + PAIR_TTL_MS,
    });
    return { ok: true, code, expiresIn: PAIR_TTL_MS };
  }

  /**
   * Что стоит за кодом. Донор видит отпечаток и имя устройства — то, что он
   * сверит глазами с чужим экраном, — и публичный ключ, который подпишет.
   */
  look(code: unknown, donorIdentityId: string): PairResult<{ view: PairOffer }> {
    const found = this.find(code, donorIdentityId);
    if (!found.ok) return found;
    const { waiting } = found;
    return {
      ok: true,
      view: {
        publicKey: waiting.publicKey,
        fingerprint: fingerprint(waiting.publicKey),
        deviceName: waiting.deviceName,
        expiresIn: waiting.expiresAt - this.now(),
      },
    };
  }

  /**
   * Впустить. Донор ручается подписью: «этот ключ — моей личности», — и с этой
   * минуты устройство входит само, своим ключом, без всякой связки.
   *
   * Личность, под которой новичок жил до сих пор, исчезает целиком. Она была
   * пустой (это проверено дважды — при просьбе и здесь), родилась минуту назад
   * от автоматического входа и никому, кроме этого устройства, не принадлежала;
   * оставить её значило бы развести человека и его же вчерашнего двойника.
   */
  async confirm(
    code: unknown,
    donor: DeviceRow,
    signature: unknown,
  ): Promise<PairResult<{ deviceId: string }>> {
    const found = this.find(code, donor.identityId);
    if (!found.ok) return found;
    const { waiting } = found;
    if (waiting.taken) return { ok: false, reason: 'bad-code' };
    waiting.taken = true;
    try {
      const done = await this.attach(waiting, donor, signature);
      if (done.ok) this.waiting.delete(code as string);
      return done;
    } finally {
      waiting.taken = false;
    }
  }

  private async attach(
    waiting: Waiting,
    donor: DeviceRow,
    signature: unknown,
  ): Promise<PairResult<{ deviceId: string }>> {
    const message = certificateMessage(donor.identityId, waiting.publicKey);
    if (!(await verifySignature(donor.publicKey, message, signature)))
      return { ok: false, reason: 'bad-signature' };

    const guest = waiting.identityId;
    const refused = await this.db.transaction(async (m): Promise<PairFailure | null> => {
      // Обе личности — под замок, в одном порядке (иначе две встречные связки
      // ждали бы друг друга вечно). Проверки ниже без него устаревали бы к
      // записи: второе подтверждение разом прошло бы предел устройств, а реплика
      // новичка, сказанная между проверкой и сносом, ушла бы вместе с ним.
      await m.getRepository(IdentityRow).find({
        where: { id: In([guest, donor.identityId]) },
        order: { id: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      });

      // Проверка та же, что и при просьбе, но за три минуты человек мог успеть
      // сказать в чат — а сказанное держит личность, которую мы собрались снести.
      if (!(await this.stillborn(m, guest, waiting.deviceId))) return 'has-history';

      // Сколько устройств держать — дело владельца инсталляции. Спрашиваем здесь,
      // а не при показе кода: код показывает НОВИЧОК, а предел принадлежит той
      // личности, в которую его впускают, и до подтверждения она неизвестна.
      if (!(await this.roomForDevice(m, donor.identityId))) return 'too-many-devices';

      // Порядок один и не переставляется: устройство уходит из личности до
      // того, как та исчезнет, иначе каскад унесёт его с собой.
      await m.getRepository(DeviceRow).update(
        { id: waiting.deviceId },
        {
          identityId: donor.identityId,
          parentDeviceId: donor.id,
          certificate: signature as string,
        },
      );
      await m.getRepository(IdentityRow).delete({ id: guest });
      return null;
    });
    if (refused) return { ok: false, reason: refused };

    this.logger.log(
      `устройство ${fingerprint(waiting.publicKey)} связано с личностью ${donor.identityId}`,
    );
    return { ok: true, deviceId: waiting.deviceId };
  }

  /**
   * Просьба по коду — с наказанием за промах. Наказывается именно донор: код
   * ищет тот, кто уже вошёл, и перебирать его больше некому.
   */
  private find(
    code: unknown,
    donorIdentityId: string,
  ): { ok: true; waiting: Waiting } | { ok: false; reason: PairFailure } {
    if (this.blocked(donorIdentityId)) return { ok: false, reason: 'too-many' };
    this.sweep();
    const waiting = isPairCode(code) ? this.waiting.get(code) : undefined;
    if (!waiting) {
      this.miss(donorIdentityId);
      return { ok: false, reason: 'bad-code' };
    }
    // Личность у просящего и подтверждающего одна — а значит, это буквально
    // одно устройство: просить умеет только личность с единственным ключом.
    // Связывать нечего, и «подтвердить» тут означало бы снести живого.
    if (waiting.identityId === donorIdentityId) return { ok: false, reason: 'self' };
    return { ok: true, waiting };
  }

  /**
   * Пуста ли личность настолько, что её не жаль. Пустая — это одно устройство,
   * ни одной реплики и ни одной роли: ровно то, чем личность бывает через
   * минуту после автоматического входа и никогда — после дня жизни.
   */
  private async stillborn(
    m: EntityManager,
    identityId: string,
    deviceId: string,
  ): Promise<boolean> {
    const devices = await m.getRepository(DeviceRow).find({
      where: { identityId },
      select: { id: true },
    });
    if (devices.length !== 1 || devices[0].id !== deviceId) return false;
    if (await m.getRepository(MessageRow).countBy({ authorIdentityId: identityId })) return false;
    return !(await m.getRepository(RoleRow).countBy({ identityId }));
  }

  /**
   * Влезет ли в личность ещё одно устройство. Ноль — предела нет, и это
   * сегодняшнее поведение: до настройки число устройств не ограничивал никто.
   *
   * Считаем только действующие: отозванное устройство остаётся строкой в
   * списке навсегда (это факт, и человек должен его видеть), но занимать место
   * живого оно не должно — иначе связка ломалась бы тем чаще, чем аккуратнее
   * человек отзывает потерянные ключи.
   */
  private async roomForDevice(m: EntityManager, identityId: string): Promise<boolean> {
    const limit = this.settings.get<number>('access.maxDevicesPerIdentity');
    if (limit <= 0) return true;
    const live = await m.getRepository(DeviceRow).countBy({ identityId, revokedAt: IsNull() });
    return live < limit;
  }

  private freeCode(): string {
    for (let i = 0; i < 100; i += 1) {
      const code = newPairCode();
      if (!this.waiting.has(code)) return code;
    }
    // Сто занятых подряд при потолке в тысячу — это не совпадение, а сломанный
    // генератор. Пусть падает здесь, а не выдаёт человеку чужую связку.
    throw new Error('не удалось выдать свободный код связки');
  }

  private blocked(identityId: string): boolean {
    return this.misses.count(identityId, this.now()) >= MAX_MISSES;
  }

  private miss(identityId: string): void {
    if (this.misses.hit(identityId, this.now()) === MAX_MISSES)
      this.logger.warn(`перебор кодов связки от ${identityId}`);
  }

  private sweep(): void {
    const now = this.now();
    for (const [code, w] of this.waiting) if (w.expiresAt < now) this.waiting.delete(code);
    this.misses.forgetExpired(now);
  }
}
