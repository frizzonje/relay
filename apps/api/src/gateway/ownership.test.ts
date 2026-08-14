import { describe, expect, it } from 'vitest';
import { normalizeClientId, ownedBy, publicChannel, publicServer } from './ownership';
import type { Channel, ServerEntry } from './registry';

/**
 * Владение реестровыми записями (audit B2). Проверяем три обещания, которые
 * ломаются молча и потому обязаны быть под тестом:
 *
 *   1. право правки — у создателя, а поверх него у владельца инсталляции;
 *   2. записи с личностью создателя устройством больше не открываются: clientId
 *      подделывается, и оставить его вторым ключом значило бы не переезд на
 *      личности, а лишнюю щель;
 *   3. наружу не уходит ни хэш пароля, ни id создателя — ни устройства, ни
 *      личности. Получив id в рассылке, назваться им — вопрос одной копипасты.
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

/** Гость по инвайту и клиент без ключа: ни устройства, ни личности. */
const nobody = {};

describe('ownedBy', () => {
  it('создатель правит свой сервер', () => {
    expect(ownedBy(server({ creatorIdentityId: 'anya' }), { identityId: 'anya' })).toBe(true);
  });

  it('чужая личность — нет', () => {
    expect(ownedBy(server({ creatorIdentityId: 'anya' }), { identityId: 'boris' })).toBe(false);
    expect(ownedBy(server({ creatorIdentityId: 'anya' }), nobody)).toBe(false);
  });

  it('владелец инсталляции правит чужое', () => {
    expect(
      ownedBy(server({ creatorIdentityId: 'anya' }), { identityId: 'boris', owner: true }),
    ).toBe(true);
  });

  it('устройством запись с личностью не открыть', () => {
    // Иначе clientId — подделываемая строка из localStorage — оставался бы
    // вторым ключом к серверу, у которого уже есть настоящий хозяин.
    expect(ownedBy(server({ creatorIdentityId: 'anya' }), { clientId: 'anya' })).toBe(false);
  });

  it('унаследованная запись остаётся за своим устройством', () => {
    // Переписать clientId в личность нечем: он никогда не был связан с ключом.
    expect(ownedBy(server({ creatorId: 'dev-1' }), { clientId: 'dev-1' })).toBe(true);
    expect(ownedBy(server({ creatorId: 'dev-1' }), { clientId: 'dev-2' })).toBe(false);
    expect(ownedBy(server({ creatorId: 'dev-1' }), { identityId: 'dev-1' })).toBe(false);
    expect(ownedBy(server({ creatorId: 'dev-1' }), nobody)).toBe(false);
  });

  it('запись без создателя (до правила владения) остаётся общей', () => {
    expect(ownedBy(server(), { clientId: 'dev-2' })).toBe(true);
    expect(ownedBy(server(), nobody)).toBe(true);
  });

  it('пустой creatorId — это отсутствие владельца, а не владелец с пустым id', () => {
    expect(ownedBy(server({ creatorId: '' }), nobody)).toBe(true);
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
  it('хэш пароля и id создателя наружу не уходят', () => {
    const entry = server({ creatorIdentityId: 'anya', creatorId: 'dev-1', passwordHash: 'salt:h' });
    const out = publicServer(entry, { identityId: 'anya' });
    expect(out).not.toHaveProperty('passwordHash');
    expect(out).not.toHaveProperty('creatorId');
    expect(out).not.toHaveProperty('creatorIdentityId');
    expect(JSON.stringify(out)).not.toContain('anya');
    expect(JSON.stringify(out)).not.toContain('dev-1');
    expect(JSON.stringify(out)).not.toContain('salt:h');
  });

  it('закрытый сервер отдаётся с флагом locked', () => {
    expect(publicServer(server({ passwordHash: 'salt:hash' }), nobody)).toMatchObject({
      locked: true,
    });
  });

  it('mine — создателю и владельцу инсталляции', () => {
    const entry = server({ creatorIdentityId: 'anya' });
    expect(publicServer(entry, { identityId: 'anya' }).mine).toBe(true);
    expect(publicServer(entry, { identityId: 'boris' }).mine).toBeUndefined();
    expect(publicServer(entry, { identityId: 'boris', owner: true }).mine).toBe(true);
  });

  it('запись без владельца — mine у всех: правила прежние', () => {
    expect(publicServer(server(), { clientId: 'dev-2' }).mine).toBe(true);
  });

  it('поля витрины на месте', () => {
    expect(publicServer(server({ emoji: '🛰' }), nobody)).toEqual({
      id: 's1',
      name: 'переговорка',
      emoji: '🛰',
      removable: true,
      mine: true,
    });
  });
});

describe('publicChannel', () => {
  it('id создателя наружу не уходит', () => {
    const out = publicChannel(channel({ creatorIdentityId: 'anya' }), { identityId: 'anya' });
    expect(out).not.toHaveProperty('creatorIdentityId');
    expect(JSON.stringify(out)).not.toContain('anya');
  });

  it('mine — создателю, владельцу инсталляции и всем у записи без владельца', () => {
    const own = channel({ creatorIdentityId: 'anya' });
    expect(publicChannel(own, { identityId: 'anya' }).mine).toBe(true);
    expect(publicChannel(own, { identityId: 'boris' }).mine).toBeUndefined();
    expect(publicChannel(own, { identityId: 'boris', owner: true }).mine).toBe(true);
    expect(publicChannel(channel(), { clientId: 'dev-2' }).mine).toBe(true);
  });

  it('режим и метка активности едут, когда есть', () => {
    expect(publicChannel(channel({ mode: 'sfu' }), nobody, 1700)).toMatchObject({
      mode: 'sfu',
      lastTs: 1700,
    });
    const bare = publicChannel(channel(), nobody, 0);
    expect(bare).not.toHaveProperty('mode');
    expect(bare).not.toHaveProperty('lastTs');
  });

  it('новое поле реестра само наружу не просочится', () => {
    // Витрина собирается поимённо: поле, добавленное в запись реестра, попадёт
    // клиенту только правкой publicChannel — а не потому, что его забыли убрать.
    const out = publicChannel({ ...channel(), secret: 'не для клиента' } as Channel, nobody);
    expect(out).not.toHaveProperty('secret');
  });
});
