import { Logger } from '@nestjs/common';
import { randomUUID, webcrypto } from 'node:crypto';
import type { Request, Response } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { ChannelRow, DeviceRow, MessageRow, ServerRow } from '../db/entities';
import type { SignalingGateway } from '../gateway/signaling.gateway';
import { resetDatabase, testDatabase } from '../db/testing';
import { SIGN_ALGORITHM, authMessage, certificateMessage } from './crypto';
import { DevicesController } from './devices.controller';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';
import { PairingService } from './pairing.service';
import { IDENTITY_COOKIE } from './session';

/**
 * Связка второго устройства, список и отзыв — с настоящей базой и настоящими
 * подписями.
 *
 * Проверяется обещание слоя 2 целиком: человек с двух устройств — одна
 * личность. Оно держится на трёх вещах, и каждая проверяется отдельно —
 * впустить может только тот, кто уже внутри; впущенное устройство дальше
 * входит само; отозванному входа нет ни в дверь, ни через живой сокет.
 */

interface FakeRes {
  code: number;
  body: unknown;
  cookies: Record<string, { value: string; opts: Record<string, unknown> }>;
  cleared: string[];
}

function res(): Response & FakeRes {
  const r = {
    code: 200,
    body: undefined as unknown,
    cookies: {} as FakeRes['cookies'],
    cleared: [] as string[],
    status(code: number) {
      r.code = code;
      return r;
    },
    json(body: unknown) {
      r.body = body;
      return r;
    },
    cookie(name: string, value: string, opts: Record<string, unknown>) {
      r.cookies[name] = { value, opts };
      return r;
    },
    clearCookie(name: string) {
      r.cleared.push(name);
      return r;
    },
  };
  return r as unknown as Response & FakeRes;
}

const req = (cookie?: string) => ({ headers: cookie ? { cookie } : {} }) as unknown as Request;

let db: DataSource;
let identity: IdentityService;
let pairing: PairingService;
let login: IdentityController;
let devices: DevicesController;
let dropDevice: ReturnType<typeof vi.fn>;
let clock: number;

beforeAll(async () => {
  db = await testDatabase();
});

afterAll(async () => {
  await db?.destroy();
});

beforeEach(async () => {
  await resetDatabase(db);
  clock = Date.parse('2026-08-13T12:00:00Z');
  identity = new IdentityService(db);
  pairing = new PairingService(db, () => clock);
  login = new IdentityController(identity);
  dropDevice = vi.fn();
  devices = new DevicesController(identity, pairing, {
    dropDevice,
  } as unknown as SignalingGateway);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Устройство: своя пара ключей и умение подписать — как у настоящего. */
async function device() {
  const keys = (await webcrypto.subtle.generateKey({ name: SIGN_ALGORITHM }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = await webcrypto.subtle.exportKey('raw', keys.publicKey);
  return {
    publicKey: Buffer.from(raw).toString('base64url'),
    sign: async (message: string) =>
      Buffer.from(
        await webcrypto.subtle.sign(
          { name: SIGN_ALGORITHM },
          keys.privateKey,
          new TextEncoder().encode(message),
        ),
      ).toString('base64url'),
  };
}

type Device = Awaited<ReturnType<typeof device>>;

interface Signed {
  key: Device;
  cookie: string;
  identityId: string;
  deviceId: string;
  nick: string;
}

/** Войти этим ключом и получить куку, как её вернул бы браузер. */
async function signIn(key: Device, nick?: string): Promise<Signed> {
  const asked = res();
  login.challenge(asked, { publicKey: key.publicKey });
  const { nonce } = asked.body as { nonce: string };

  const out = res();
  await login.verify(req(), out, {
    publicKey: key.publicKey,
    nonce,
    signature: await key.sign(authMessage(nonce)),
    nick,
    deviceName: nick ? `${nick} · Chrome` : undefined,
  });
  const body = out.body as { id: string; nick: string; device: { id: string } };
  return {
    key,
    cookie: `${IDENTITY_COOKIE}=${out.cookies[IDENTITY_COOKIE]?.value}`,
    identityId: body.id,
    deviceId: body.device.id,
    nick: body.nick,
  };
}

/** Новичок просит связки и получает код, который покажет человеку. */
async function ask(who: Signed): Promise<string> {
  const out = res();
  await devices.ask(req(who.cookie), out);
  return (out.body as { code: string }).code;
}

/** Донор впускает: смотрит, подписывает увиденный ключ, подтверждает. */
async function confirm(donor: Signed, code: string): Promise<Response & FakeRes> {
  const seen = res();
  await devices.look(req(donor.cookie), seen, code);
  const view = seen.body as { publicKey: string };

  const out = res();
  await devices.confirm(req(donor.cookie), out, {
    code,
    signature: await donor.key.sign(certificateMessage(donor.identityId, view.publicKey)),
  });
  return out;
}

async function listOf(who: Signed) {
  const out = res();
  await devices.list(req(who.cookie), out);
  return (out.body as { devices: { id: string; name: string; current: boolean; root: boolean }[] })
    .devices;
}

describe('связка второго устройства', () => {
  it('впущенное устройство входит само и оказывается той же личностью', async () => {
    // Это и есть обещание слоя 2 целиком: человек с двух устройств — один.
    const donor = await signIn(await device(), 'Аня');
    const guest = await signIn(await device());

    expect((await confirm(donor, await ask(guest))).code).toBe(200);

    // Кука новичка больше не сходится (личности за ней нет) — клиент входит
    // заново своим ключом, ничего не спрашивая у человека.
    const again = await signIn(guest.key);
    expect(again.identityId).toBe(donor.identityId);
    expect(again.nick).toBe('Аня');
    expect(again.deviceId).toBe(guest.deviceId);

    const list = await listOf(donor);
    expect(list).toHaveLength(2);
    expect(list.filter((d) => d.root)).toHaveLength(1);
  });

  it('впустивший записан в родители, а его подпись — в сертификат', async () => {
    // Дерево устройств — не украшение: по нему видно, кто кого впустил.
    const donor = await signIn(await device(), 'Аня');
    const guest = await signIn(await device());
    await confirm(donor, await ask(guest));

    const row = await db.getRepository(DeviceRow).findOneByOrFail({ id: guest.deviceId });
    expect(row.parentDeviceId).toBe(donor.deviceId);
    expect(row.certificate).toBeTruthy();
    // Сертификат — подпись донора именно под ключом новичка.
    expect(
      await webcrypto.subtle.verify(
        { name: SIGN_ALGORITHM },
        await webcrypto.subtle.importKey(
          'raw',
          Buffer.from(donor.key.publicKey, 'base64url'),
          { name: SIGN_ALGORITHM },
          false,
          ['verify'],
        ),
        Buffer.from(row.certificate as string, 'base64url'),
        new TextEncoder().encode(certificateMessage(donor.identityId, row.publicKey)),
      ),
    ).toBe(true);
  });

  it('личность-однодневка новичка исчезает вместе со связкой', async () => {
    // Иначе человек развёлся бы со своим же вчерашним двойником: пустая
    // личность осталась бы в базе навсегда, и войти в неё было бы нечем.
    const donor = await signIn(await device(), 'Аня');
    const guest = await signIn(await device());
    const orphan = guest.identityId;

    await confirm(donor, await ask(guest));

    const gone = await identity.whoIs(orphan, guest.deviceId);
    expect(gone.ok).toBe(false);
  });

  it('код одноразовый', async () => {
    const donor = await signIn(await device(), 'Аня');
    const guest = await signIn(await device());
    const code = await ask(guest);

    await confirm(donor, code);
    const twice = res();
    await devices.confirm(req(donor.cookie), twice, { code, signature: 'x'.repeat(86) });
    expect(twice.code).toBe(400);
    expect(twice.body).toEqual({ error: 'bad-code' });
  });

  it('через три минуты код уже не код', async () => {
    const donor = await signIn(await device(), 'Аня');
    const guest = await signIn(await device());
    const code = await ask(guest);

    clock += 3 * 60 * 1000 + 1;
    const out = res();
    await devices.look(req(donor.cookie), out, code);
    expect(out.body).toEqual({ error: 'bad-code' });
  });
});

describe('впустить может только тот, кто внутри', () => {
  it('подпись чужим ключом не открывает дверь', async () => {
    // Донор ручается своим ключом; чужая подпись под тем же текстом — не он.
    const donor = await signIn(await device(), 'Аня');
    const guest = await signIn(await device());
    const outsider = await device();
    const code = await ask(guest);

    const seen = res();
    await devices.look(req(donor.cookie), seen, code);
    const { publicKey } = seen.body as { publicKey: string };

    const out = res();
    await devices.confirm(req(donor.cookie), out, {
      code,
      signature: await outsider.sign(certificateMessage(donor.identityId, publicKey)),
    });
    expect(out.code).toBe(400);
    expect(out.body).toEqual({ error: 'bad-signature' });
  });

  it('сертификат другой личности не годится', async () => {
    // Донор, состоящий в двух личностях, иначе впустил бы устройство не туда,
    // куда собирался: подпись обязана называть личность, а не только ключ.
    const donor = await signIn(await device(), 'Аня');
    const guest = await signIn(await device());
    const code = await ask(guest);
    const seen = res();
    await devices.look(req(donor.cookie), seen, code);
    const { publicKey } = seen.body as { publicKey: string };

    const out = res();
    await devices.confirm(req(donor.cookie), out, {
      code,
      signature: await donor.key.sign(certificateMessage(randomUUID(), publicKey)),
    });
    expect(out.body).toEqual({ error: 'bad-signature' });
  });

  it('без сессии не посмотреть и не впустить', async () => {
    const guest = await signIn(await device());
    const code = await ask(guest);

    const seen = res();
    await devices.look(req(), seen, code);
    expect(seen.code).toBe(401);
  });

  it('отозванное устройство впускать не может', async () => {
    // Иначе отзыв был бы бумажным: отозванный ключ заводил бы себе новый.
    const donor = await signIn(await device(), 'Аня');
    const second = await signIn(await device());
    await confirm(donor, await ask(second));
    const back = await signIn(second.key);

    await devices.revoke(req(donor.cookie), res(), { deviceId: back.deviceId });

    const out = res();
    await devices.confirm(req(back.cookie), out, { code: '000000', signature: 'x' });
    expect(out.code).toBe(403);
  });

  it('перебор кодов останавливается на десятом промахе', async () => {
    // Шесть цифр перебираются за минуты, если никто не считает промахи.
    const donor = await signIn(await device(), 'Аня');
    for (let i = 0; i < 10; i += 1) {
      const out = res();
      await devices.look(req(donor.cookie), out, String(100000 + i));
      expect(out.code).toBe(400);
    }
    const out = res();
    await devices.look(req(donor.cookie), out, '999999');
    expect(out.code).toBe(429);
    expect(out.body).toEqual({ error: 'too-many' });
  });

  it('счётчик промахов свой у каждого', async () => {
    // Иначе один перебирающий закрыл бы связку всей инсталляции.
    const donor = await signIn(await device(), 'Аня');
    const other = await signIn(await device(), 'Боря');
    for (let i = 0; i < 11; i += 1) await devices.look(req(donor.cookie), res(), '111111');

    const out = res();
    await devices.look(req(other.cookie), out, '222222');
    expect(out.code).toBe(400);
  });
});

describe('связка — не слияние', () => {
  it('личность, которая уже говорила, связать нельзя', async () => {
    // Это уже не связка, а слияние двух биографий: сказанное держит личность,
    // которую пришлось бы снести, и человек потерял бы авторство.
    const talker = await signIn(await device(), 'Боря');
    await db.getRepository(ServerRow).insert({
      id: 'main',
      name: 'main',
      emoji: null,
      removable: false,
      passwordHash: null,
      creatorId: null,
      position: 0,
    });
    await db.getRepository(ChannelRow).insert({
      id: 'general',
      serverId: 'main',
      type: 'text',
      name: 'general',
      slug: 'general',
      removable: false,
      mode: null,
      creatorId: null,
      position: 0,
    });
    await db.getRepository(MessageRow).insert({
      id: randomUUID(),
      channelId: 'general',
      authorName: 'Боря',
      authorIdentityId: talker.identityId,
      text: 'привет',
    });

    const out = res();
    await devices.ask(req(talker.cookie), out);
    expect(out.code).toBe(400);
    expect(out.body).toEqual({ error: 'has-history' });
  });

  it('второе устройство личности связать нельзя — просит только новичок', async () => {
    const donor = await signIn(await device(), 'Аня');
    const guest = await signIn(await device());
    await confirm(donor, await ask(guest));
    const back = await signIn(guest.key);

    const out = res();
    await devices.ask(req(back.cookie), out);
    expect(out.body).toEqual({ error: 'has-history' });
  });

  it('свой же код, введённый себе, — это не связка', async () => {
    // Человек вполне может ввести показанный код на том же устройстве. Молча
    // «связать» его с самим собой значило бы снести личность, которая тут же
    // и подтверждает, — то есть отобрать её у живого.
    const alone = await signIn(await device(), 'Аня');
    const code = await ask(alone);

    const out = res();
    await devices.look(req(alone.cookie), out, code);
    expect(out.code).toBe(400);
    expect(out.body).toEqual({ error: 'self' });

    expect((await identity.whoIs(alone.identityId, alone.deviceId)).ok).toBe(true);
  });
});

describe('список устройств', () => {
  it('текущее помечено, и оно ровно одно', async () => {
    const donor = await signIn(await device(), 'Аня');
    const guest = await signIn(await device());
    await confirm(donor, await ask(guest));

    const list = await listOf(donor);
    expect(list.filter((d) => d.current)).toHaveLength(1);
    expect(list.find((d) => d.current)?.id).toBe(donor.deviceId);
  });

  it('у устройств разные отпечатки — двух «Chrome · macOS» не спутать', async () => {
    const donor = await signIn(await device(), 'Аня');
    const guest = await signIn(await device());
    await confirm(donor, await ask(guest));

    const out = res();
    await devices.list(req(donor.cookie), out);
    const list = (out.body as { devices: { fingerprint: string }[] }).devices;
    expect(new Set(list.map((d) => d.fingerprint)).size).toBe(2);
  });

  it('чужих устройств в списке нет', async () => {
    const mine = await signIn(await device(), 'Аня');
    await signIn(await device(), 'Боря');
    expect(await listOf(mine)).toHaveLength(1);
  });
});

describe('отзыв', () => {
  it('отозванным ключом больше не войти', async () => {
    const donor = await signIn(await device(), 'Аня');
    const guest = await signIn(await device());
    await confirm(donor, await ask(guest));
    const back = await signIn(guest.key);

    const out = res();
    await devices.revoke(req(donor.cookie), out, { deviceId: back.deviceId });
    expect(out.code).toBe(200);

    const asked = res();
    login.challenge(asked, { publicKey: guest.key.publicKey });
    const { nonce } = asked.body as { nonce: string };
    const denied = res();
    await login.verify(req(), denied, {
      publicKey: guest.key.publicKey,
      nonce,
      signature: await guest.key.sign(authMessage(nonce)),
    });
    expect(denied.code).toBe(403);
    expect(denied.body).toEqual({ error: 'revoked' });
  });

  it('живой сокет отозванного выгоняется сразу, а не со следующего входа', async () => {
    // Личность узнаётся один раз, при подключении: без этого отозванное
    // устройство говорило бы в каналы до собственного переподключения.
    const donor = await signIn(await device(), 'Аня');
    const guest = await signIn(await device());
    await confirm(donor, await ask(guest));

    await devices.revoke(req(donor.cookie), res(), { deviceId: guest.deviceId });
    expect(dropDevice).toHaveBeenCalledWith(guest.deviceId);
  });

  it('отозванное остаётся в списке — с отметкой', async () => {
    // Пропади оно, и человек не смог бы убедиться, что отзыв случился.
    const donor = await signIn(await device(), 'Аня');
    const guest = await signIn(await device());
    await confirm(donor, await ask(guest));
    await devices.revoke(req(donor.cookie), res(), { deviceId: guest.deviceId });

    const out = res();
    await devices.list(req(donor.cookie), out);
    const list = (out.body as { devices: { id: string; revokedAt: string | null }[] }).devices;
    expect(list).toHaveLength(2);
    expect(list.find((d) => d.id === guest.deviceId)?.revokedAt).toBeTruthy();
  });

  it('своё текущее устройство не отзывается', async () => {
    // Единственный ключ, которым можно вернуться, — не кнопка «удалить себя».
    const donor = await signIn(await device(), 'Аня');
    const out = res();
    await devices.revoke(req(donor.cookie), out, { deviceId: donor.deviceId });
    expect(out.code).toBe(409);
    expect(out.body).toEqual({ error: 'current' });
  });

  it('чужое устройство не отзывается', async () => {
    // Отзыв — про свои устройства, и чужой список для него не существует.
    const mine = await signIn(await device(), 'Аня');
    const stranger = await signIn(await device(), 'Боря');

    const out = res();
    await devices.revoke(req(mine.cookie), out, { deviceId: stranger.deviceId });
    expect(out.code).toBe(404);

    const alive = await identity.whoIs(stranger.identityId, stranger.deviceId);
    expect(alive.ok).toBe(true);
  });
});
