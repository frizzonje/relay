import { describe, expect, it, vi } from 'vitest';
import type { CallEndedRelay, CallPerson, CallStartResult, DmOpenResult } from '@relay/shared';

/**
 * Экран исходящего вызова (задача 6 плана B).
 *
 * `lib/call.ts` здесь подделан целиком: он владеет живыми `mine`/`room` и
 * реальными сокет-эмитами, а этому стору нужно только то, что он ОТВЕЧАЕТ —
 * дублировать протокол вызова в подделке было бы вторым его описанием,
 * которое однажды разойдётся с первым (см. lib/call.test.ts — там же
 * проверяется настоящий `hangUp`).
 */
vi.mock('@/lib/call', () => ({
  dialCall: vi.fn(),
  hangUp: vi.fn(),
  cancelCall: vi.fn(),
  // Вызов, которым владеет ЭТА вкладка. По умолчанию пусто — то есть экран
  // открыт рассылкой с соседнего устройства; тесты своего набора говорят
  // обратное явно (см. `owning()`).
  ownedCall: vi.fn((): string | null => null),
}));
vi.mock('@/lib/channels', () => ({ ask: vi.fn() }));
vi.mock('@/stores/ui', () => ({ useUiStore: { getState: vi.fn(() => ({ openDm: vi.fn() })) } }));

const PEER: CallPerson = { fingerprint: 'ff', nick: 'Боря' };

async function fresh() {
  vi.resetModules();
  vi.clearAllMocks();
  const ring = await import('./ring');
  const call = await import('@/lib/call');
  const channels = await import('@/lib/channels');
  const ui = await import('@/stores/ui');
  ring.useRingStore.getState().reset();
  return { ring, call, channels, ui };
}

type CallModule = typeof import('@/lib/call');

/**
 * Подделать ответ ack `call-start`. Настоящий `dialCall` при `ok` объявляет
 * вызов СВОИМ (`mine` внутри lib/call.ts), и подделка обязана делать то же:
 * `hangUp` этого стора спрашивает `ownedCall()`, чтобы отличить свой набор от
 * набора на соседнем устройстве, — и всегда-ничей ответ незаметно превратил бы
 * каждый тест своего набора в тест чужого.
 */
function answers(call: CallModule, res: CallStartResult) {
  vi.mocked(call.dialCall).mockImplementation(async () => {
    if (res.ok) vi.mocked(call.ownedCall).mockReturnValue(res.ringId);
    return res;
  });
}

/** Ответ ack `call-start`, отложенный до вызова `resolve`. */
function pendingDial() {
  let resolve!: (res: CallStartResult) => void;
  const promise = new Promise<CallStartResult>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('дозвон: набор и подтверждение', () => {
  it('экран открывается сразу, «дозваниваемся», не дожидаясь ack', async () => {
    const { ring, call } = await fresh();
    const { promise } = pendingDial();
    vi.mocked(call.dialCall).mockReturnValue(promise);

    void ring.useRingStore.getState().start(PEER);

    const screen = ring.useRingStore.getState().outgoing;
    expect(screen).not.toBeNull();
    expect(screen!.peer).toEqual(PEER);
    expect(screen!.ring.state).toBe('ringing');
    expect(ring.outgoingCaption(screen!)).toEqual({
      key: 'call.state.ringing',
      color: 'text-text-muted',
    });
    expect(ring.outgoingLive(screen!)).toBe(true);
  });

  it('ack приносит id, не трогая состояние экрана', async () => {
    const { ring, call } = await fresh();
    answers(call, { ok: true, ringId: 'r1' });

    await ring.useRingStore.getState().start(PEER);

    const screen = ring.useRingStore.getState().outgoing;
    expect(screen!.ring.id).toBe('r1');
    expect(screen!.ring.state).toBe('ringing');
  });

  it('отбой раньше ack: пришедший позже номер тут же возвращают', async () => {
    const { ring, call } = await fresh();
    const { promise, resolve } = pendingDial();
    vi.mocked(call.dialCall).mockReturnValue(promise);

    const started = ring.useRingStore.getState().start(PEER);
    ring.useRingStore.getState().hangUp();
    expect(ring.useRingStore.getState().outgoing).toBeNull();
    expect(call.hangUp).toHaveBeenCalledTimes(1);

    resolve({ ok: true, ringId: 'r1' });
    await started;

    // Номер уже был — вызов, от которого отказались, не дождавшись ack, надо
    // отбить ещё раз: раньше `lib/call.ts` не знал `mine`, теперь знает.
    expect(call.hangUp).toHaveBeenCalledTimes(2);
    expect(ring.useRingStore.getState().outgoing).toBeNull();
  });
});

describe('дозвон: отказ ДО того, как что-либо зазвонило', () => {
  it.each([
    ['busy', { key: 'call.state.busy', color: 'text-warn' }],
    ['offline', { key: 'call.state.offline', color: 'text-text-faint' }],
    ['disabled', { key: 'call.refusal.disabled', color: 'text-text-faint' }],
    ['forbidden', { key: 'call.refusal.forbidden', color: 'text-text-faint' }],
    ['rate', { key: 'call.refusal.rate', color: 'text-text-faint' }],
  ] as const)('%s рисует свою подпись и гасит пульс', async (error, caption) => {
    const { ring, call } = await fresh();
    answers(call, { ok: false, error });

    await ring.useRingStore.getState().start(PEER);

    const screen = ring.useRingStore.getState().outgoing;
    expect(screen).not.toBeNull();
    expect(ring.outgoingCaption(screen!)).toEqual(caption);
    expect(ring.outgoingLive(screen!)).toBe(false);
  });

  it('«не в сети» до вызова и «пропал посреди дозвона» — одна и та же подпись', async () => {
    // Пункт 3 брифа задачи 6: два разных пути (`offline` из ack `call-start` и
    // `failed` из `call-ended`) обязаны сойтись в ОДНОЙ подписи, а не в двух
    // похожих, которым однажды случится разойтись.
    const { ring: forRefusal, call: callA } = await fresh();
    answers(callA, { ok: false, error: 'offline' });
    await forRefusal.useRingStore.getState().start(PEER);
    const viaRefusal = forRefusal.outgoingCaption(forRefusal.useRingStore.getState().outgoing!);

    const { ring: forEnded, call: callB } = await fresh();
    answers(callB, { ok: true, ringId: 'r1' });
    await forEnded.useRingStore.getState().start(PEER);
    forEnded.useRingStore.getState().applyEnded({
      ringId: 'r1',
      state: 'failed',
      peer: PEER,
      at: Date.now(),
      missed: true,
    });
    const viaEnded = forEnded.outgoingCaption(forEnded.useRingStore.getState().outgoing!);

    expect(viaRefusal).toEqual(viaEnded);
  });
});

describe('дозвон: конец, не ставший разговором', () => {
  async function ringing() {
    const stand = await fresh();
    answers(stand.call, { ok: true, ringId: 'r1' });
    await stand.ring.useRingStore.getState().start(PEER);
    return stand;
  }

  function ended(state: CallEndedRelay['state']): CallEndedRelay {
    return { ringId: 'r1', state, peer: PEER, at: Date.now(), missed: state !== 'declined' };
  }

  it.each([
    ['declined', { key: 'call.state.declined', color: 'text-danger' }],
    ['no-answer', { key: 'call.state.noAnswer', color: 'text-danger' }],
    ['busy', { key: 'call.state.busy', color: 'text-warn' }],
    ['failed', { key: 'call.state.offline', color: 'text-text-faint' }],
  ] as const)('%s переключает подпись и цвет, пульс гаснет', async (state, caption) => {
    const { ring } = await ringing();

    ring.useRingStore.getState().applyEnded(ended(state));

    const screen = ring.useRingStore.getState().outgoing;
    expect(screen).not.toBeNull();
    expect(ring.outgoingCaption(screen!)).toEqual(caption);
    expect(ring.outgoingLive(screen!)).toBe(false);
  });

  it('чужой ringId экран не трогает', async () => {
    const { ring } = await ringing();
    ring.useRingStore.getState().applyEnded({ ...ended('declined'), ringId: 'чужой' });
    expect(ring.useRingStore.getState().outgoing!.ring.state).toBe('ringing');
  });

  it('свой отбой эхом с сервера просто гасит экран — без второй подписи поверх закрытия', async () => {
    const { ring } = await ringing();
    ring.useRingStore.getState().hangUp();
    expect(ring.useRingStore.getState().outgoing).toBeNull();

    // Эхо «cancelled» приходит уже по мёртвому экрану — не должно ничего
    // воскрешать.
    ring.useRingStore.getState().applyEnded(ended('cancelled'));
    expect(ring.useRingStore.getState().outgoing).toBeNull();
  });

  it('«принято» гасит экран дозвона — разговор уже показывает другой экран', async () => {
    const { ring } = await ringing();
    ring.useRingStore.getState().applyState({
      ringId: 'r1',
      state: 'accepted',
      peer: PEER,
      at: Date.now(),
      video: false,
      room: 'voice:dm-0123456789abcdef01234567',
    });
    expect(ring.useRingStore.getState().outgoing).toBeNull();
  });
});

describe('«Написать вместо звонка»', () => {
  it('отбивает вызов РОВНО один раз и уводит в переписку', async () => {
    const { ring, call, channels, ui } = await fresh();
    answers(call, { ok: true, ringId: 'r1' });
    await ring.useRingStore.getState().start(PEER);

    const conversation: DmOpenResult = {
      ok: true,
      conversation: {
        slug: 'dm-0123456789abcdef01234567',
        peer: PEER,
        lastTs: 0,
        preview: '',
        previewMine: false,
      },
    };
    vi.mocked(channels.ask).mockResolvedValue(conversation);
    const openDm = vi.fn();
    vi.mocked(ui.useUiStore.getState).mockReturnValue({ openDm } as never);

    ring.useRingStore.getState().writeInstead();
    // Экран закрывается сразу — раньше ответа `dm-open`.
    expect(ring.useRingStore.getState().outgoing).toBeNull();
    expect(call.hangUp).toHaveBeenCalledTimes(1);

    await vi.waitFor(() =>
      expect(openDm).toHaveBeenCalledWith('dm-0123456789abcdef01234567', 'ff', 'Боря'),
    );

    // Кто-то нажал ещё раз (двойной клик, повторный Escape) — отбоя не прибавляется.
    ring.useRingStore.getState().writeInstead();
    expect(call.hangUp).toHaveBeenCalledTimes(1);
  });
});

describe('экран, открытый набором с СОСЕДНЕГО устройства', () => {
  /**
   * `call-state{ringing}` уходит на ВСЕ устройства звонящего (§4.2 протокола):
   * набрали с ноутбука — экран дозвона обязан быть и в телефоне. У этой
   * вкладки при этом нет ни своего вызова (`ownedCall()` пуст), ни комнаты, и
   * `hangUp()` из lib/call.ts тут бессилен по построению.
   */
  async function sibling() {
    const stand = await fresh();
    // Здесь не набирали: своего вызова у этой вкладки нет (в настоящем
    // `lib/call.ts` это пустой `mine`).
    vi.mocked(stand.call.ownedCall).mockReturnValue(null);
    stand.ring.useRingStore.getState().applyState({
      ringId: 'r1',
      state: 'ringing',
      peer: PEER,
      at: Date.now(),
      video: false,
    });
    expect(stand.ring.useRingStore.getState().outgoing).not.toBeNull();
    return stand;
  }

  it('«Отбой» кончает вызов по имени, а не гасит экран молча', async () => {
    const { ring, call } = await sibling();

    ring.useRingStore.getState().hangUp();

    // Молчание здесь было бы худшим из исходов: экран погас, человек уверен,
    // что положил трубку, — а у собеседника продолжает звонить.
    expect(call.cancelCall).toHaveBeenCalledWith('r1');
    expect(call.hangUp).not.toHaveBeenCalled();
    expect(ring.useRingStore.getState().outgoing).toBeNull();
  });

  it('«Написать вместо звонка» кончает вызов РОВНО один раз', async () => {
    const { ring, call, channels, ui } = await sibling();
    const conversation: DmOpenResult = {
      ok: true,
      conversation: {
        slug: 'dm-0123456789abcdef01234567',
        peer: PEER,
        lastTs: 0,
        preview: '',
        previewMine: false,
      },
    };
    vi.mocked(channels.ask).mockResolvedValue(conversation);
    const openDm = vi.fn();
    vi.mocked(ui.useUiStore.getState).mockReturnValue({ openDm } as never);

    ring.useRingStore.getState().writeInstead();

    // Бриф требует «не уронить вызов дважды»; на соседнем устройстве прежний
    // код ронял его НОЛЬ раз — что то же враньё, только тише.
    expect(call.cancelCall).toHaveBeenCalledTimes(1);
    expect(call.cancelCall).toHaveBeenCalledWith('r1');
    await vi.waitFor(() =>
      expect(openDm).toHaveBeenCalledWith('dm-0123456789abcdef01234567', 'ff', 'Боря'),
    );

    ring.useRingStore.getState().writeInstead();
    expect(call.cancelCall).toHaveBeenCalledTimes(1);
  });

  it('свой набор по-прежнему бросают через lib/call.ts — он один знает про комнату', async () => {
    const { ring, call } = await fresh();
    answers(call, { ok: true, ringId: 'r1' });
    await ring.useRingStore.getState().start(PEER);

    ring.useRingStore.getState().hangUp();

    // Принятый и уже посаженный вызов бросают выходом из комнаты, а не
    // `call-cancel`, и знает об этом только `lib/call.ts`.
    expect(call.hangUp).toHaveBeenCalledTimes(1);
    expect(call.cancelCall).not.toHaveBeenCalled();
  });
});

describe('обрыв сокета', () => {
  it('гасит экран: вызова больше нет, а эха об этом не будет', async () => {
    const { ring, call } = await fresh();
    answers(call, { ok: true, ringId: 'r1' });
    await ring.useRingStore.getState().start(PEER);

    ring.useRingStore.getState().lost();

    // Сервер кончает вызов звонящего сразу, как ушло последнее устройство, без
    // грейса (§4.2), а `call-ended{cancelled}` шлёт в уже мёртвый сокет —
    // ждать его бессмысленно, и «дозваниваемся» висело бы вечно.
    expect(ring.useRingStore.getState().outgoing).toBeNull();
    // Слать некуда: сокета нет, а вызов уже закрыт сервером.
    expect(call.hangUp).not.toHaveBeenCalled();
    expect(call.cancelCall).not.toHaveBeenCalled();
  });
});
