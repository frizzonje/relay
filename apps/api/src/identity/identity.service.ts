import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { DeviceRow, IdentityRow } from '../db/entities';
import {
  authMessage,
  fingerprint,
  isPublicKey,
  newNonce,
  sanitizeNick,
  verifySignature,
} from './crypto';

/**
 * Личность на ключах: вход без регистрации, без пароля и без восстановления.
 *
 * Ворота на инсталляцию остаются прежними (`SITE_PASSWORD` → `relay_pass`);
 * здесь начинается второй вопрос — не «пустить ли вообще», а «кто это». Ответ
 * даёт челлендж-ответ: сервер шлёт нонс, устройство подписывает его своим
 * приватным ключом, сервер сверяет с публичным. Приватный ключ сервер не видит
 * никогда, поэтому и утечь с него нечему.
 *
 * Нонсы живут в памяти и одну-две минуты: хранить их в базе значило бы писать
 * строку на каждый вход и подметать её ретенцией — ради значения, которое
 * ценно ровно до следующего запроса. Процесс один на инсталляцию (см. коммент
 * в `session.ts`), так что делить их не с кем.
 */

/** Сколько живёт выданный нонс. Больше не нужно: клиент подписывает сразу. */
const NONCE_TTL_MS = 2 * 60 * 1000;

/**
 * Потолок незакрытых челленджей. Каждый — это 32 байта и таймштамп, но без
 * потолка любой, кто прошёл ворота, может попросить их миллион.
 */
const MAX_PENDING = 10_000;

export type VerifyFailure =
  /** Ключ не той формы. Клиент сломан или это вообще не наш клиент. */
  | 'bad-key'
  /** Нонса нет, он протух или уже был использован. */
  | 'bad-nonce'
  /** Подпись не сошлась: ключ не тот, за который себя выдают. */
  | 'bad-signature'
  /** Устройство отозвано владельцем личности. */
  | 'revoked';

export type VerifyResult =
  | { ok: true; identity: IdentityRow; device: DeviceRow; created: boolean }
  | { ok: false; reason: VerifyFailure };

export interface VerifyInput {
  publicKey: unknown;
  nonce: unknown;
  signature: unknown;
  nick?: unknown;
  deviceName?: unknown;
}

interface Pending {
  publicKey: string;
  expiresAt: number;
}

@Injectable()
export class IdentityService {
  private readonly logger = new Logger('identity');
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly db: DataSource,
    @Optional() private readonly now: () => number = Date.now,
  ) {}

  /**
   * Нонс для этого ключа. Привязан к ключу намеренно: нонс, выданный одному,
   * не должен закрываться подписью другого — иначе «докажи, что ты владеешь
   * ключом» превращается в «докажи, что кто-то владеет каким-то ключом».
   */
  challenge(publicKey: unknown): { nonce: string; expiresAt: number } | null {
    if (!isPublicKey(publicKey)) return null;
    this.sweep();
    if (this.pending.size >= MAX_PENDING) {
      this.logger.warn('слишком много незакрытых челленджей — новый не выдан');
      return null;
    }
    const nonce = newNonce();
    const expiresAt = this.now() + NONCE_TTL_MS;
    this.pending.set(nonce, { publicKey, expiresAt });
    return { nonce, expiresAt };
  }

  /**
   * Закрыть челлендж подписью. Успех означает одно из двух: это устройство уже
   * известно (тогда мы просто узнали человека) или оно новое — и тогда рядом
   * рождается личность, у которой это устройство корневое.
   */
  async verify(input: VerifyInput): Promise<VerifyResult> {
    if (!isPublicKey(input.publicKey)) return { ok: false, reason: 'bad-key' };
    if (typeof input.nonce !== 'string') return { ok: false, reason: 'bad-nonce' };

    // Съедаем нонс до всякой проверки подписи: одноразовый — значит одноразовый
    // и для неудачной попытки тоже. Иначе подпись можно подбирать бесконечно на
    // одном и том же нонсе.
    const issued = this.pending.get(input.nonce);
    this.pending.delete(input.nonce);
    if (!issued || issued.expiresAt < this.now() || issued.publicKey !== input.publicKey)
      return { ok: false, reason: 'bad-nonce' };

    if (!(await verifySignature(input.publicKey, authMessage(input.nonce), input.signature)))
      return { ok: false, reason: 'bad-signature' };

    const known = await this.db.getRepository(DeviceRow).findOne({
      where: { publicKey: input.publicKey },
      relations: { identity: true },
    });

    if (known) {
      if (known.revokedAt) return { ok: false, reason: 'revoked' };
      await this.touch(known);
      return { ok: true, identity: known.identity, device: known, created: false };
    }

    return this.create(input.publicKey, input.nick, input.deviceName);
  }

  /** Личность по сессии. `null` — сессия есть, а личности за ней уже нет. */
  async whoIs(identityId: string, deviceId: string): Promise<VerifyResult> {
    const device = await this.db.getRepository(DeviceRow).findOne({
      where: { id: deviceId, identityId },
      relations: { identity: true },
    });
    if (!device) return { ok: false, reason: 'bad-key' };
    // Отзыв обязан действовать сразу, а не со следующей сессии: это его смысл.
    if (device.revokedAt) return { ok: false, reason: 'revoked' };
    await this.touch(device);
    return { ok: true, identity: device.identity, device, created: false };
  }

  /** Сменить ник. Он свободный и не уникальный — сверять не с чем. */
  async rename(identityId: string, nick: unknown): Promise<string | null> {
    const clean = sanitizeNick(nick);
    if (!clean) return null;
    const res = await this.db
      .getRepository(IdentityRow)
      .update({ id: identityId }, { nick: clean });
    return res.affected ? clean : null;
  }

  private async create(
    publicKey: string,
    nick: unknown,
    deviceName: unknown,
  ): Promise<VerifyResult> {
    const print = fingerprint(publicKey);
    const identity: IdentityRow = {
      id: randomUUID(),
      publicKey,
      fingerprint: print,
      // Ник спрашивает первый экран, но обойтись без него сервер обязан:
      // клиент бывает не наш, а личность без имени — это пустое место в ленте.
      // Отпечаток в этой роли честнее выдумки: он и так показан рядом.
      nick: sanitizeNick(nick) || print.slice(0, 4),
      createdAt: new Date(),
      lastSeenAt: null,
    };
    const device: DeviceRow = {
      id: randomUUID(),
      identityId: identity.id,
      identity,
      publicKey,
      name: sanitizeNick(deviceName) || 'устройство',
      // Корневое устройство никем не подписано: оно и есть корень доверия.
      certificate: null,
      parentDeviceId: null,
      createdAt: new Date(),
      lastSeenAt: new Date(),
      revokedAt: null,
    };

    // Одной транзакцией: личность без устройства войти не сможет никогда, а
    // строка о ней останется навсегда — в базе нет никого, кто бы её убрал.
    await this.db.transaction(async (m) => {
      await m.getRepository(IdentityRow).insert(identity);
      await m.getRepository(DeviceRow).insert({ ...device, identity: undefined });
    });

    this.logger.log(`новая личность ${print} («${identity.nick}»)`);
    return { ok: true, identity, device, created: true };
  }

  /**
   * Отметить, что устройство сейчас на связи. Не ждём: «последний вход» на
   * минуту устаревший стоит дешевле, чем вход, ждущий записи в базу.
   */
  private async touch(device: DeviceRow): Promise<void> {
    const at = new Date();
    device.lastSeenAt = at;
    device.identity.lastSeenAt = at;
    try {
      await this.db.transaction(async (m) => {
        await m.getRepository(DeviceRow).update({ id: device.id }, { lastSeenAt: at });
        await m.getRepository(IdentityRow).update({ id: device.identityId }, { lastSeenAt: at });
      });
    } catch (e) {
      this.logger.error(`не удалось отметить вход устройства: ${e}`);
    }
  }

  private sweep(): void {
    const now = this.now();
    for (const [nonce, p] of this.pending) if (p.expiresAt < now) this.pending.delete(nonce);
  }
}
