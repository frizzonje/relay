import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sfuHealthy = vi.hoisted(() => vi.fn(async () => false));
vi.mock('./sfu/sfu-health', () => ({ sfuHealthy }));

import { ConfigController } from './config.controller';
import { signTurnUsername } from './turn';

/**
 * ICE-конфиг — единственное, что решает, соберётся ли звонок за строгим NAT.
 * Ошибиться здесь можно молча: отдать TURN без учётки (бесполезен), забыть
 * turns: на 5349 (сеть с DPI останется без звонка) или пообещать медиасервер,
 * которого нет. Всё это видно только в бою, поэтому проверяем на столе.
 */

const ENV = [
  'TURN_SECRET',
  'TURN_TTL_SECONDS',
  'TURN_CREDENTIAL',
  'TURN_USERNAME',
  'TURN_URLS',
  'STUN_URLS',
  'SERVER_HOST',
  'RELAY_VERSION',
] as const;

beforeEach(() => {
  for (const key of ENV) delete process.env[key];
  sfuHealthy.mockResolvedValue(false);
});
afterEach(() => {
  for (const key of ENV) delete process.env[key];
  vi.restoreAllMocks();
});

const read = () => new ConfigController().getConfig();

describe('STUN', () => {
  it('без настроек — публичные Google, чтобы звонок собрался «из коробки»', async () => {
    const { iceServers } = await read();
    expect(iceServers).toHaveLength(1);
    expect(iceServers[0].urls).toEqual([
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
    ]);
  });

  it('свой coturn встаёт первым, публичные остаются резервом', async () => {
    process.env.TURN_CREDENTIAL = 'секрет';
    process.env.SERVER_HOST = 'relay.example';
    const { iceServers } = await read();
    expect(iceServers[0].urls[0]).toBe('stun:relay.example:3478');
    expect(iceServers[0].urls).toContain('stun:stun.l.google.com:19302');
  });

  it('явный список STUN отменяет всё остальное', async () => {
    process.env.STUN_URLS = ' stun:a.example:3478 , , stun:b.example:3478 ';
    process.env.TURN_CREDENTIAL = 'секрет';
    process.env.SERVER_HOST = 'relay.example';
    const { iceServers } = await read();
    expect(iceServers[0].urls).toEqual(['stun:a.example:3478', 'stun:b.example:3478']);
  });
});

describe('TURN', () => {
  it('учётка + публичный хост дают udp, tcp и turns на 5349', async () => {
    process.env.TURN_CREDENTIAL = 'секрет';
    process.env.SERVER_HOST = 'relay.example';
    const { iceServers } = await read();
    const turn = iceServers.find((s) => s.credential)!;
    expect(turn.urls).toEqual([
      'turn:relay.example:3478?transport=udp',
      'turn:relay.example:3478?transport=tcp',
      // Сеть с DPI, где ходит только TLS, собирается лишь через этот адрес.
      'turns:relay.example:5349?transport=tcp',
    ]);
    expect(turn.username).toBe('webrtc');
    expect(turn.credential).toBe('секрет');
  });

  it('своё имя пользователя перекрывает дефолт', async () => {
    process.env.TURN_CREDENTIAL = 'секрет';
    process.env.SERVER_HOST = 'relay.example';
    process.env.TURN_USERNAME = 'свой';
    const { iceServers } = await read();
    expect(iceServers.find((s) => s.credential)!.username).toBe('свой');
  });

  it('localhost за свой coturn не считается — снаружи туда никто не дозвонится', async () => {
    process.env.TURN_CREDENTIAL = 'секрет';
    process.env.SERVER_HOST = 'localhost';
    const { iceServers } = await read();
    expect(iceServers.some((s) => s.credential)).toBe(false);
    expect(iceServers[0].urls[0]).toBe('stun:stun.l.google.com:19302');
  });

  it('TURN без учётки не отдаём вовсе: он всё равно бесполезен', async () => {
    process.env.TURN_URLS = 'turn:чужой.example:3478';
    const { iceServers } = await read();
    expect(iceServers.some((s) => s.urls.some((u) => u.startsWith('turn')))).toBe(false);
  });

  it('явный список TURN перекрывает собранный из хоста', async () => {
    process.env.TURN_CREDENTIAL = 'секрет';
    process.env.SERVER_HOST = 'relay.example';
    process.env.TURN_URLS = 'turn:чужой.example:3478';
    const { iceServers } = await read();
    expect(iceServers.find((s) => s.credential)!.urls).toEqual(['turn:чужой.example:3478']);
  });
});

/**
 * Временные учётки. Главное, что здесь проверяется, — что пара действительно
 * разная и что срок уезжает клиенту: без срока вкладка не может знать, когда
 * её пара скиснет, и тихо звонила бы мимо ретранслятора.
 */
describe('TURN: временные учётки', () => {
  beforeEach(() => {
    process.env.TURN_SECRET = 'ключ подписи';
    process.env.SERVER_HOST = 'relay.example';
  });

  it('логин со сроком, пароль — подпись, и срок отдельным полем', async () => {
    const cfg = await read();
    const turn = cfg.iceServers.find((s) => s.credential)!;
    expect(turn.username).toMatch(/^\d{10}:[0-9a-f]{8}$/);
    expect(turn.credential).toBe(signTurnUsername('ключ подписи', turn.username!));
    expect(cfg.iceExpiresAt).toBe(Number(turn.username!.split(':')[0]));
  });

  it('двум запросам — две разные пары: отозвать одну не значит оборвать всех', async () => {
    const first = (await read()).iceServers.find((s) => s.credential)!;
    const second = (await read()).iceServers.find((s) => s.credential)!;
    expect(first.username).not.toBe(second.username);
  });

  it('секрет наружу не уходит ни в каком виде', async () => {
    expect(JSON.stringify(await read())).not.toContain('ключ подписи');
  });

  /**
   * Статическая пара — это чужой TURN-сервер, у которого нашего секрета нет.
   * Своему секрету она уступает: иначе включивший TURN_SECRET получил бы пару,
   * которую его же coturn отвергнет, — и звонки пропали бы после «улучшения».
   */
  it('при своём секрете прежняя статическая пара не отдаётся', async () => {
    process.env.TURN_CREDENTIAL = 'старый пароль';
    process.env.TURN_USERNAME = 'webrtc';
    const turn = (await read()).iceServers.find((s) => s.credential)!;
    expect(turn.credential).not.toBe('старый пароль');
    expect(turn.username).not.toBe('webrtc');
  });

  it('без секрета срок не выдумывается — статической паре его взять неоткуда', async () => {
    delete process.env.TURN_SECRET;
    process.env.TURN_CREDENTIAL = 'секрет';
    const cfg = await read();
    expect(cfg.iceServers.find((s) => s.credential)!.credential).toBe('секрет');
    expect(cfg.iceExpiresAt).toBeUndefined();
  });
});

describe('признак медиасервера', () => {
  it('не поднят — клиент честно узнаёт об этом и остаётся на p2p', async () => {
    expect((await read()).sfu).toEqual({ available: false });
  });

  it('живой health-пинг — только тогда available', async () => {
    sfuHealthy.mockResolvedValue(true);
    expect((await read()).sfu).toEqual({ available: true });
  });
});

/**
 * Версия живёт здесь, а не в публичном `/api/health`: сверять её с клиентом
 * нужно тому, кто уже вошёл, а раздавать номер сборки всем подряд незачем.
 */
describe('версия сервера', () => {
  it('уходит клиенту той, с какой собран образ', async () => {
    process.env.RELAY_VERSION = '1.0.0';
    expect((await read()).version).toBe('1.0.0');
  });

  it('сборка из исходников отдаёт пустую строку, а не выдуманный номер', async () => {
    expect((await read()).version).toBe('');
  });
});

describe('ретенция наружу', () => {
  it('дни едут числом и режимом сразу — по числу одному их не различить', async () => {
    process.env.RETENTION_DAYS = '30';
    const cfg = await read();
    expect(cfg).toMatchObject({ retentionDays: 30, retentionMode: 'days' });
    delete process.env.RETENTION_DAYS;
  });

  it('«без срока» и «не хранить» — разные режимы при одинаковом нуле дней', async () => {
    process.env.RETENTION_DAYS = 'forever';
    expect(await read()).toMatchObject({ retentionDays: 0, retentionMode: 'forever' });
    process.env.RETENTION_DAYS = 'ephemeral';
    expect(await read()).toMatchObject({ retentionDays: 0, retentionMode: 'ephemeral' });
    delete process.env.RETENTION_DAYS;
  });
});
