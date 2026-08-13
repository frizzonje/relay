import { Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DeviceRow, IdentityRow, MessageRow, RoleRow } from '../db/entities';
import {
  certificateMessage,
  fingerprint,
  isPairCode,
  newPairCode,
  verifySignature,
} from './crypto';

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
  | 'self';

export type PairResult<T> = ({ ok: true } & T) | { ok: false; reason: PairFailure };

/** Просьба, ждущая подтверждения. Живёт в памяти и три минуты. */
interface Waiting {
  identityId: string;
  deviceId: string;
  publicKey: string;
  deviceName: string;
  expiresAt: number;
}

/** Что донор видит перед тем, как впустить. Ключ — чтобы было чем подписать. */
export interface PairView {
  publicKey: string;
  fingerprint: string;
  deviceName: string;
  /**
   * Сколько коду жить, в миллисекундах, — а не когда он умрёт. Метка времени
   * потребовала бы, чтобы часы телефона и сервера совпадали, а они расходятся
   * на минуты сплошь и рядом: обратный отсчёт на экране показывал бы чушь.
   */
  expiresIn: number;
}

@Injectable()
export class PairingService {
  private readonly logger = new Logger('pairing');
  private readonly waiting = new Map<string, Waiting>();
  private readonly misses = new Map<string, { count: number; until: number }>();

  constructor(
    private readonly db: DataSource,
    @Optional() private readonly now: () => number = Date.now,
  ) {}

  /**
   * «Впустите меня»: устройство просит связки и получает код, который покажет
   * человеку. Проверка на прожитую жизнь стоит здесь, а не в подтверждении, —
   * человек узнает о невозможности до того, как побежит за вторым устройством.
   */
  async ask(device: DeviceRow): Promise<PairResult<{ code: string; expiresIn: number }>> {
    const { id: deviceId, identityId } = device;
    if (!(await this.stillborn(identityId, deviceId))) return { ok: false, reason: 'has-history' };

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
  look(code: unknown, donorIdentityId: string): PairResult<{ view: PairView }> {
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

    const message = certificateMessage(donor.identityId, waiting.publicKey);
    if (!(await verifySignature(donor.publicKey, message, signature)))
      return { ok: false, reason: 'bad-signature' };

    // Проверка та же, что и при просьбе, но за три минуты человек мог успеть
    // сказать в чат — а сказанное держит личность, которую мы собрались снести.
    if (!(await this.stillborn(waiting.identityId, waiting.deviceId)))
      return { ok: false, reason: 'has-history' };

    const guest = waiting.identityId;
    await this.db.transaction(async (m) => {
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
    });

    this.waiting.delete(code as string);
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
  private async stillborn(identityId: string, deviceId: string): Promise<boolean> {
    const devices = await this.db.getRepository(DeviceRow).find({
      where: { identityId },
      select: { id: true },
    });
    if (devices.length !== 1 || devices[0].id !== deviceId) return false;
    if (await this.db.getRepository(MessageRow).countBy({ authorIdentityId: identityId }))
      return false;
    return !(await this.db.getRepository(RoleRow).countBy({ identityId }));
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
    const seen = this.misses.get(identityId);
    if (!seen || seen.until < this.now()) return false;
    return seen.count >= MAX_MISSES;
  }

  private miss(identityId: string): void {
    const now = this.now();
    const seen = this.misses.get(identityId);
    if (!seen || seen.until < now) {
      this.misses.set(identityId, { count: 1, until: now + MISS_WINDOW_MS });
      return;
    }
    seen.count += 1;
    if (seen.count === MAX_MISSES) this.logger.warn(`перебор кодов связки от ${identityId}`);
  }

  private sweep(): void {
    const now = this.now();
    for (const [code, w] of this.waiting) if (w.expiresAt < now) this.waiting.delete(code);
    for (const [id, seen] of this.misses) if (seen.until < now) this.misses.delete(id);
  }
}
