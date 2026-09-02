import { describe, expect, it } from 'vitest';
import { missed, settled, step, type Ring, type RingEvent, type RingState } from './ring';

/**
 * Вызов — это гонки, и разбираются они здесь, а не на живых сокетах.
 *
 * Двое звонят друг другу в одну секунду; сокет рвётся между вызовом и приёмом;
 * «принять» приходит после таймаута; «отбой» — в ту же миллисекунду, что и
 * «принять». Каждый такой случай на сервере воспроизводится раз в месяц и
 * только у пользователя, а тут — строкой. Поэтому проверяем не счастливый путь
 * (он одной строкой и кончается), а именно то, что событие не к месту не
 * делает НИЧЕГО.
 */

const A = 'a1b2-c3d4-e5f6-7890';
const B = '0987-6f5e-4d3c-2b1a';

/** Вызов, который уже звонит: с этого места начинаются почти все гонки. */
function ringing(startedAt = 1): Ring {
  return { id: 'ring-1', from: A, to: B, state: 'ringing', startedAt };
}

/** Вызов, которого ещё нет: собран, но «позвонить» не нажато. */
function fresh(): Ring {
  return { id: 'ring-1', from: A, to: B, state: 'idle', startedAt: 0 };
}

const ALL_STATES: RingState[] = [
  'idle',
  'ringing',
  'accepted',
  'declined',
  'no-answer',
  'busy',
  'cancelled',
  'failed',
];

const EVENT_TYPES: RingEvent['type'][] = [
  'call',
  'accept',
  'decline',
  'cancel',
  'timeout',
  'busy',
  'peer-gone',
];

/** Все события разом — ими проверяется «не значит ничего» без выборочности. */
const allEvents = (at: number): RingEvent[] =>
  EVENT_TYPES.map((type) => ({ type, at }) as RingEvent);

describe('машина вызова', () => {
  it('вызов начинается со звонка и кончается принятием', () => {
    const live = step(fresh(), { type: 'call', at: 10 });
    expect(live.state).toBe('ringing');
    // Часы дозвона заводятся звонком: по ним считается таймаут и длительность.
    expect(live.startedAt).toBe(10);
    expect(live.endedAt).toBeUndefined();
    expect(settled(live.state)).toBe(false);

    const accepted = step(live, { type: 'accept', at: 14_000 });
    expect(accepted.state).toBe('accepted');
    expect(accepted.endedAt).toBe(14_000);
    expect(settled(accepted.state)).toBe(true);
    expect(missed(accepted.state)).toBe(false);
  });

  it('после конечного состояния события ничего не меняют', () => {
    const declined = step(ringing(), { type: 'decline', at: 2 });
    expect(step(declined, { type: 'accept', at: 3 })).toEqual(declined);
  });

  it('таймаут после принятия ничего не значит', () => {
    const accepted = step(ringing(), { type: 'accept', at: 5 });
    expect(step(accepted, { type: 'timeout', at: 30_000 })).toBe(accepted);
  });

  it('отбой и принятие в одну миллисекунду дают один исход, а не оба', () => {
    const live = ringing(10);
    const acceptFirst = step(step(live, { type: 'accept', at: 20 }), { type: 'cancel', at: 20 });
    const cancelFirst = step(step(live, { type: 'cancel', at: 20 }), { type: 'accept', at: 20 });

    // Одинаковый `at` не решает ничего: выигрывает тот, кто первым дошёл до
    // владельца вызова. Оба исхода конечны, и ни один не «оба сразу».
    expect(acceptFirst.state).toBe('accepted');
    expect(cancelFirst.state).toBe('cancelled');
    expect(acceptFirst.endedAt).toBe(20);
    expect(cancelFirst.endedAt).toBe(20);
  });

  it('пропущенным считается «не ответили» и «не в сети», но не «отклонён»', () => {
    expect(missed('no-answer')).toBe(true);
    expect(missed('failed')).toBe(true);
    expect(missed('declined')).toBe(false);
  });

  it('обрыв у собеседника до ответа — «не в сети», после ответа — конец разговора', () => {
    const live = ringing(10);

    const gone = step(live, { type: 'peer-gone', at: 20 });
    expect(gone.state).toBe('failed');
    expect(missed(gone.state)).toBe(true);

    // После ответа обрыв — это конец РАЗГОВОРА, а вызов уже кончился приёмом.
    // Машина не притворяется, что владеет разговором: она молчит.
    const accepted = step(live, { type: 'accept', at: 15 });
    expect(step(accepted, { type: 'peer-gone', at: 40 })).toBe(accepted);
  });
});

describe('переходы из «звонит»', () => {
  it('каждое событие ведёт ровно в свой исход и ставит время конца', () => {
    const table: [RingEvent['type'], RingState][] = [
      ['accept', 'accepted'],
      ['decline', 'declined'],
      ['cancel', 'cancelled'],
      ['timeout', 'no-answer'],
      ['busy', 'busy'],
      ['peer-gone', 'failed'],
    ];
    for (const [type, expected] of table) {
      const out = step(ringing(10), { type, at: 20 } as RingEvent);
      expect([type, out.state, out.endedAt]).toEqual([type, expected, 20]);
      expect(out.startedAt).toBe(10);
    }
  });

  it('повторный звонок по идущему вызову ничего не перезапускает', () => {
    // Иначе второй `call-start` сдвинул бы startedAt, и таймаут уехал бы на
    // столько же — вызов, который «звонит» вечно.
    const live = ringing(10);
    expect(step(live, { type: 'call', at: 50 })).toBe(live);
  });

  it('исход несёт тех же участников и то же начало', () => {
    const out = step(ringing(10), { type: 'decline', at: 20 });
    expect(out.state).toBe('declined');
    expect(out.id).toBe('ring-1');
    expect(out.from).toBe(A);
    expect(out.to).toBe(B);
    expect(out.startedAt).toBe(10);
  });

  it('переход не трогает вызов, который ему дали', () => {
    const live = ringing(10);
    const before = { ...live };
    step(live, { type: 'accept', at: 20 });
    expect(live).toEqual(before);
  });
});

describe('до звонка и после исхода', () => {
  it('до звонка не значит ничего, кроме самого звонка', () => {
    const before = fresh();
    for (const event of allEvents(5)) {
      if (event.type === 'call') continue;
      expect(step(before, event)).toBe(before);
    }
    expect(step(before, { type: 'call', at: 5 }).state).toBe('ringing');
  });

  it('ни одно событие не трогает ни один конечный исход', () => {
    for (const state of ALL_STATES.filter(settled)) {
      const done: Ring = { ...ringing(10), state, endedAt: 20 };
      for (const event of allEvents(30)) expect(step(done, event)).toBe(done);
    }
  });

  it('«ничего не случилось» видно по ссылке, а не сравнением полей', () => {
    // Владелец вызова на сервере проверяет исход именно так: не изменилось —
    // значит рассылать нечего.
    const live = ringing(10);
    expect(step(live, { type: 'call', at: 20 })).toBe(live);
    expect(step(live, { type: 'accept', at: 20 })).not.toBe(live);
  });

  it('время конца ставится один раз и не сдвигается', () => {
    const declined = step(ringing(10), { type: 'decline', at: 20 });
    expect(step(declined, { type: 'timeout', at: 45 }).endedAt).toBe(20);
  });
});

describe('исходы', () => {
  it('конечны все исходы, но ни «до звонка», ни «звонит»', () => {
    expect(ALL_STATES.filter(settled)).toEqual([
      'accepted',
      'declined',
      'no-answer',
      'busy',
      'cancelled',
      'failed',
    ]);
  });

  it('отметку в переписке оставляют только «не ответили» и «не в сети»', () => {
    // «Отклонён» отметки не оставляет по брифу; «отбой» — это звонивший
    // передумал, и метка о собственной секундной ошибке была бы шумом;
    // «занято» — собеседник в разговоре, а не мимо.
    expect(ALL_STATES.filter(missed)).toEqual(['no-answer', 'failed']);
  });
});
