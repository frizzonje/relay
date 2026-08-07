import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sfuHealthy = vi.hoisted(() => vi.fn(async () => false));
vi.mock('./sfu/sfu-health', () => ({ sfuHealthy }));

import { ConfigController } from './config.controller';

/**
 * ICE-конфиг — единственное, что решает, соберётся ли звонок за строгим NAT.
 * Ошибиться здесь можно молча: отдать TURN без учётки (бесполезен), забыть
 * turns: на 5349 (сеть с DPI останется без звонка) или пообещать медиасервер,
 * которого нет. Всё это видно только в бою, поэтому проверяем на столе.
 */

const ENV = [
  'TURN_CREDENTIAL',
  'TURN_USERNAME',
  'TURN_URLS',
  'STUN_URLS',
  'SERVER_HOST',
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

describe('признак медиасервера', () => {
  it('не поднят — клиент честно узнаёт об этом и остаётся на p2p', async () => {
    expect((await read()).sfu).toEqual({ available: false });
  });

  it('живой health-пинг — только тогда available', async () => {
    sfuHealthy.mockResolvedValue(true);
    expect((await read()).sfu).toEqual({ available: true });
  });
});
