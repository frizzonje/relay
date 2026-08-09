import { describe, expect, it } from 'vitest';
import { normalizeClientId, ownedBy, publicChannel, publicServer } from './ownership';
import type { Channel, ServerEntry } from './registry';

/**
 * Владение реестровыми записями (audit B2). Проверяем два обещания, которые
 * ломаются молча и потому обязаны быть под тестом:
 *
 *   1. право правки — только у создателя, а у записей без создателя оно общее;
 *   2. наружу не уходит ни хэш пароля, ни clientId владельца. Второе не менее
 *      важно первого: получив id владельца в рассылке, назваться им — вопрос
 *      одной копипасты, и правило владения перестаёт значить что-либо.
 */

const server = (over: Partial<ServerEntry> = {}): ServerEntry => ({
  id: 's1',
  name: 'переговорка',
  removable: true,
  ...over,
});

const channel = (over: Partial<Channel> = {}): Channel => ({
  id: 'c1',
  serverId: 's1',
  type: 'voice',
  name: 'эфир',
  slug: 'efir',
  removable: true,
  ...over,
});

describe('ownedBy', () => {
  it('создатель правит свою запись', () => {
    expect(ownedBy(server({ creatorId: 'dev-1' }), 'dev-1')).toBe(true);
  });

  it('чужое устройство — нет', () => {
    expect(ownedBy(server({ creatorId: 'dev-1' }), 'dev-2')).toBe(false);
  });

  it('клиент без id чужую запись не правит', () => {
    expect(ownedBy(server({ creatorId: 'dev-1' }), undefined)).toBe(false);
  });

  it('запись без создателя (до правила владения) остаётся общей', () => {
    expect(ownedBy(server(), 'dev-2')).toBe(true);
    expect(ownedBy(server(), undefined)).toBe(true);
  });

  it('пустой creatorId — это отсутствие владельца, а не владелец с пустым id', () => {
    expect(ownedBy(server({ creatorId: '' }), undefined)).toBe(true);
  });
});

describe('normalizeClientId', () => {
  it('режет пробелы и длину', () => {
    expect(normalizeClientId('  dev-1  ')).toBe('dev-1');
    expect(normalizeClientId('x'.repeat(100))).toHaveLength(64);
  });

  it('пустое и не-строка — владельца нет', () => {
    expect(normalizeClientId('   ')).toBeUndefined();
    expect(normalizeClientId(undefined)).toBeUndefined();
    expect(normalizeClientId(42)).toBeUndefined();
    expect(normalizeClientId({ toString: () => 'dev-1' })).toBeUndefined();
  });
});

describe('publicServer', () => {
  it('хэш пароля и id владельца наружу не уходят', () => {
    const out = publicServer(server({ creatorId: 'dev-1', passwordHash: 'salt:hash' }), 'dev-1');
    expect(out).not.toHaveProperty('passwordHash');
    expect(out).not.toHaveProperty('creatorId');
    expect(JSON.stringify(out)).not.toContain('dev-1');
    expect(JSON.stringify(out)).not.toContain('salt:hash');
  });

  it('закрытый сервер отдаётся с флагом locked', () => {
    expect(publicServer(server({ passwordHash: 'salt:hash' }), undefined)).toMatchObject({
      locked: true,
    });
  });

  it('mine — только своему устройству', () => {
    const entry = server({ creatorId: 'dev-1' });
    expect(publicServer(entry, 'dev-1').mine).toBe(true);
    expect(publicServer(entry, 'dev-2').mine).toBeUndefined();
  });

  it('запись без владельца — mine у всех: правила прежние', () => {
    expect(publicServer(server(), 'dev-2').mine).toBe(true);
  });

  it('поля витрины на месте', () => {
    expect(publicServer(server({ emoji: '🛰' }), undefined)).toEqual({
      id: 's1',
      name: 'переговорка',
      emoji: '🛰',
      removable: true,
      mine: true,
    });
  });
});

describe('publicChannel', () => {
  it('id владельца наружу не уходит', () => {
    const out = publicChannel(channel({ creatorId: 'dev-1' }), 'dev-1');
    expect(out).not.toHaveProperty('creatorId');
    expect(JSON.stringify(out)).not.toContain('dev-1');
  });

  it('mine — только своему устройству, у записи без владельца — всем', () => {
    expect(publicChannel(channel({ creatorId: 'dev-1' }), 'dev-1').mine).toBe(true);
    expect(publicChannel(channel({ creatorId: 'dev-1' }), 'dev-2').mine).toBeUndefined();
    expect(publicChannel(channel(), 'dev-2').mine).toBe(true);
  });

  it('режим и метка активности едут, когда есть', () => {
    expect(publicChannel(channel({ mode: 'sfu' }), undefined, 1700)).toMatchObject({
      mode: 'sfu',
      lastTs: 1700,
    });
    const bare = publicChannel(channel(), undefined, 0);
    expect(bare).not.toHaveProperty('mode');
    expect(bare).not.toHaveProperty('lastTs');
  });

  it('новое поле реестра само наружу не просочится', () => {
    // Витрина собирается поимённо: поле, добавленное в запись реестра, попадёт
    // клиенту только правкой publicChannel — а не потому, что его забыли убрать.
    const out = publicChannel({ ...channel(), secret: 'не для клиента' } as Channel, undefined);
    expect(out).not.toHaveProperty('secret');
  });
});
