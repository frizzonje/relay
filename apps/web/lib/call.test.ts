import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallReplyResult, CallStartResult, CallStateRelay } from '@relay/shared';

/**
 * Голосовая жизнь принятого вызова: вход в комнату беседы и выход из неё.
 *
 * Проверяется здесь ровно то, чего сервер обеспечить не может. Комнату он
 * открывает и стережёт сам, но САДИТСЯ в неё клиент: микрофон и камера живут
 * у него, и посаженная сервером вкладка сидела бы в комнате, не отдавая
 * звука. Отсюда три вопроса: садимся ли мы по принятию (а не по кнопке
 * «войти»), садится ли ровно та вкладка, которая звонила или отвечала, — и
 * встаём ли, когда собеседник ушёл.
 */

const socket = {
  on: vi.fn(),
  emit: vi.fn(),
};
const handlers: Record<string, (payload: never) => void> = {};
socket.on = vi.fn((event: string, h: (payload: never) => void) => {
  handlers[event] = h;
});

vi.mock('@/lib/socket', () => ({ getSocket: () => socket }));
// `joinVoice` отвечает, СОСТОЯЛСЯ ли вход, и подделка обязана уметь оба
// ответа: всегда-успешная прячет ровно тот случай, ради которого ответ и
// заведён (движок без WebRTC, отказ в микрофоне).
// `voiceRoom` по умолчанию пуст: эфир ничей, пока тест не скажет обратного.
//
// `leaveVoice` в подделке САМ оповещает подписчиков `onVoiceLeft` — ровно то,
// что делает настоящий дирижёр. Пустышка вместо этого показывала бы связку
// исправной при любом её устройстве: выход из голоса кнопкой (`Controls`,
// `Sidebar`, `MobileNav`, хоткей) зовёт `leaveVoice` напрямую и про
// `lib/call.ts` не знает вовсе.
vi.mock('@/lib/voice', () => {
  const watchers = new Set<(room: string) => void>();
  let current: string | null = null;
  return {
    joinVoice: vi.fn(async (newRoom: string) => {
      current = newRoom;
      return true;
    }),
    leaveVoice: vi.fn(() => {
      const left = current;
      current = null;
      if (left) for (const cb of watchers) cb(left);
    }),
    voiceRoom: vi.fn((): string | null => null),
    onVoiceLeft: vi.fn((cb: (room: string) => void) => {
      watchers.add(cb);
      return () => watchers.delete(cb);
    }),
  };
});
vi.mock('@/lib/voice/camera', () => ({
  toggleCamera: vi.fn(async () => {}),
  isCamOn: () => false,
}));

const ROOM = 'voice:dm-0123456789abcdef01234567';

/** Свежий модуль на каждый тест: вызов, которым владеет вкладка, — его состояние. */
async function fresh() {
  vi.resetModules();
  vi.clearAllMocks();
  for (const key of Object.keys(handlers)) delete handlers[key];
  const call = await import('./call');
  const voice = await import('@/lib/voice');
  const camera = await import('@/lib/voice/camera');
  call.initCall();
  return { call, voice, camera };
}

/** «Принято» так, как его присылает сервер обеим сторонам. */
function accepted(ringId: string, extra: Partial<CallStateRelay> = {}): CallStateRelay {
  return {
    ringId,
    state: 'accepted',
    peer: { fingerprint: 'ff', nick: 'Боря' },
    at: Date.now(),
    video: false,
    room: ROOM,
    ...extra,
  };
}

/** Ответить сервером на последний `emit` с подтверждением. */
function reply(res: CallStartResult | CallReplyResult) {
  const last = socket.emit.mock.calls[socket.emit.mock.calls.length - 1];
  (last[2] as (r: CallStartResult | CallReplyResult) => void)(res);
}

describe('вход в комнату беседы', () => {
  beforeEach(() => {
    socket.emit.mockReset();
  });

  it('сажает в комнату принятие, а не кнопка «войти»', async () => {
    const { call, voice } = await fresh();
    void call.dialCall('ff');
    reply({ ok: true, ringId: 'r1' });
    await Promise.resolve();

    handlers['call-state'](accepted('r1') as never);
    await vi.waitFor(() => expect(voice.joinVoice).toHaveBeenCalledWith(ROOM, 'Боря'));
  });

  it('садится та вкладка, что звонила: чужое «принято» её не касается', async () => {
    const { call, voice } = await fresh();
    void call.dialCall('ff');
    reply({ ok: true, ringId: 'r1' });
    await Promise.resolve();

    // Тот же человек ответил с другого устройства — сюда это событие приезжает
    // затем, чтобы погасить входящий, а не чтобы посадить в разговор вторую
    // вкладку: их обеих было бы слышно, и каждая слышала бы себя эхом.
    handlers['call-state'](accepted('чужой-вызов') as never);
    await Promise.resolve();
    expect(voice.joinVoice).not.toHaveBeenCalled();
  });

  it('«звонит» в комнату не сажает: комнаты до ответа ещё нет', async () => {
    const { call, voice } = await fresh();
    void call.dialCall('ff');
    reply({ ok: true, ringId: 'r1' });
    await Promise.resolve();

    handlers['call-state']({ ...accepted('r1'), state: 'ringing', room: undefined } as never);
    await Promise.resolve();
    expect(voice.joinVoice).not.toHaveBeenCalled();
  });

  it('ответивший садится, даже если «принято» обогнало ответ сервера', async () => {
    const { call, voice } = await fresh();
    // Рассылка и подтверждение идут по одному сокету, и рассылка приходит
    // первой. Заяви вкладка владение по подтверждению — «принято» приехало бы
    // в никуда, и разговор не собрался бы ровно на том устройстве, где нажали
    // «принять».
    const answered = call.answerCall('r1');
    handlers['call-state'](accepted('r1') as never);
    await vi.waitFor(() => expect(voice.joinVoice).toHaveBeenCalledWith(ROOM, 'Боря'));

    reply({ ok: true });
    expect(await answered).toEqual({ ok: true });
  });

  it('проигранная гонка владение снимает: садиться будет некуда', async () => {
    const { call, voice } = await fresh();
    const answered = call.answerCall('r1');
    reply({ ok: false, error: 'unknown' });
    expect(await answered).toEqual({ ok: false, error: 'unknown' });

    handlers['call-state'](accepted('r1') as never);
    await Promise.resolve();
    expect(voice.joinVoice).not.toHaveBeenCalled();
  });

  it('не вошли — и не считаем себя в разговоре', async () => {
    const { call, voice, camera } = await fresh();
    // Движок без WebRTC или отказ в микрофоне: `joinVoice` выходит, не отправив
    // `join`. Считай вкладка себя в комнате — экран звонка стоял бы над
    // разговором, в который она не вошла, а `hangUp` не отправил бы ничего:
    // выходить неоткуда.
    vi.mocked(voice.joinVoice).mockResolvedValueOnce(false);
    void call.dialCall('ff');
    reply({ ok: true, ringId: 'r1' });
    await Promise.resolve();

    handlers['call-state'](accepted('r1', { video: true }) as never);
    await vi.waitFor(() => expect(voice.joinVoice).toHaveBeenCalled());
    expect(call.callRoom()).toBeNull();
    expect(camera.toggleCamera).not.toHaveBeenCalled();
  });

  it('голосовой звонок камеры не открывает, видеозвонок открывает', async () => {
    const { call, camera } = await fresh();
    void call.dialCall('ff');
    reply({ ok: true, ringId: 'r1' });
    await Promise.resolve();

    handlers['call-state'](accepted('r1') as never);
    await vi.waitFor(() => expect(call.callRoom()).toBe(ROOM));
    // Голосовой договорились — голосовой и ведём: камера тут не «по умолчанию
    // выключена», её вообще не спрашивают.
    expect(camera.toggleCamera).not.toHaveBeenCalled();

    const second = await fresh();
    void second.call.dialCall('ff', true);
    reply({ ok: true, ringId: 'r2' });
    await Promise.resolve();
    handlers['call-state'](accepted('r2', { video: true }) as never);
    await vi.waitFor(() => expect(second.camera.toggleCamera).toHaveBeenCalled());
  });
});

describe('конец разговора', () => {
  beforeEach(() => {
    socket.emit.mockReset();
  });

  /** Вкладка сидит в комнате беседы — с этого начинается всякий уход. */
  async function talking() {
    const stand = await fresh();
    void stand.call.dialCall('ff');
    reply({ ok: true, ringId: 'r1' });
    await Promise.resolve();
    handlers['call-state'](accepted('r1') as never);
    await vi.waitFor(() => expect(stand.call.callRoom()).toBe(ROOM));
    return stand;
  }

  it('ушёл собеседник — встаём и мы', async () => {
    const { call, voice } = await talking();
    handlers['call-over']({ room: ROOM } as never);

    expect(voice.leaveVoice).toHaveBeenCalledWith(true);
    expect(call.callRoom()).toBeNull();
  });

  it('чужая комната нас из своей не выводит', async () => {
    const { call, voice } = await talking();
    handlers['call-over']({ room: 'voice:dm-aaaaaaaaaaaaaaaaaaaaaaaa' } as never);

    expect(voice.leaveVoice).not.toHaveBeenCalled();
    expect(call.callRoom()).toBe(ROOM);
  });

  it('вызов, не ставший разговором, владение снимает', async () => {
    const { call, voice } = await fresh();
    void call.dialCall('ff');
    reply({ ok: true, ringId: 'r1' });
    await Promise.resolve();

    handlers['call-ended']({ ringId: 'r1', state: 'declined' } as never);
    // Опоздавшее «принято» по мёртвому вызову в комнату уже не сажает.
    handlers['call-state'](accepted('r1') as never);
    await Promise.resolve();
    expect(voice.joinVoice).not.toHaveBeenCalled();
  });

  it('«это разговор двоих, и он не ваш» кончает звонок у себя, а не тостом', async () => {
    const { call, voice } = await talking();
    // Достижимо законным участником: пока висел системный запрос доступа к
    // микрофону, комнату закрыл серверный сторож, и `join` пришёл в никуда.
    // Вкладка в комнату не вошла — значит `call-over` до неё не доедет
    // никогда, и без этого разбора экран звонка стоял бы с открытым микрофоном
    // над разговором, которого нет.
    handlers['voice-refused']({ reason: 'not-in-call' } as never);

    expect(voice.leaveVoice).toHaveBeenCalledWith(true);
    expect(call.callRoom()).toBeNull();
  });

  it('прочие отказы в голосе звонок не трогают', async () => {
    const { call, voice } = await talking();
    // «Канал полон» и «камера выключена» приезжают из совсем других мест и
    // разговора не касаются: разобрать их как конец звонка значило бы гасить
    // его на ровном месте.
    handlers['voice-refused']({ reason: 'room-full' } as never);

    expect(voice.leaveVoice).not.toHaveBeenCalled();
    expect(call.callRoom()).toBe(ROOM);
  });

  it('конец разговора посреди посадки не оставляет микрофон открытым', async () => {
    const { call, voice } = await fresh();
    // Посадка, которая не доезжает, пока тест её не отпустит: ровно так висит
    // на экране первый в жизни запрос доступа к микрофону.
    let land = (_ok: boolean) => {};
    vi.mocked(voice.joinVoice).mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        land = resolve;
      }),
    );
    void call.dialCall('ff');
    reply({ ok: true, ringId: 'r1' });
    await Promise.resolve();
    handlers['call-state'](accepted('r1') as never);
    await vi.waitFor(() => expect(voice.joinVoice).toHaveBeenCalled());

    // Собеседник кладёт трубку, пока мы ещё садимся.
    handlers['call-over']({ room: ROOM } as never);
    expect(call.callRoom()).toBeNull();
    expect(voice.leaveVoice).toHaveBeenCalledTimes(1);

    // …и посадка всё-таки доезжает. Микрофон, взятый по дороге, обязан быть
    // отпущен: без этого экран звонка погашен, а человека слышно.
    land(true);
    await vi.waitFor(() => expect(voice.leaveVoice).toHaveBeenCalledTimes(2));
    expect(call.callRoom()).toBeNull();
  });

  it('уборка опоздавшей посадки не сносит канал, в который уже вошли', async () => {
    const { call, voice } = await fresh();
    let land = (_ok: boolean) => {};
    vi.mocked(voice.joinVoice).mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        land = resolve;
      }),
    );
    void call.dialCall('ff');
    reply({ ok: true, ringId: 'r1' });
    await Promise.resolve();
    handlers['call-state'](accepted('r1') as never);
    await vi.waitFor(() => expect(voice.joinVoice).toHaveBeenCalled());

    // Звонок кончился, пока на экране висел системный запрос доступа к
    // микрофону, — и человек, у которого он погас, щёлкнул обычный голосовой
    // канал. Разрешение одно на оба захода, так что заход канала ждёт его же.
    handlers['call-over']({ room: ROOM } as never);
    expect(voice.leaveVoice).toHaveBeenCalledTimes(1);
    vi.mocked(voice.voiceRoom).mockReturnValueOnce('obshchii');

    // Разрешение выдано, посадка доезжает — и убирать ей нечего: микрофон
    // держит чужой живой заход. Позови она `leaveVoice(true)`, тот сошёл бы с
    // дистанции молча, оставив открытую сцену канала без звука.
    land(false);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(voice.leaveVoice).toHaveBeenCalledTimes(1);
    // И спрошено это было у эфира, а не у себя: проверка «занят ли эфир»
    // обязана состояться, иначе тест зелен по совпадению.
    expect(voice.voiceRoom).toHaveBeenCalled();
  });

  it('трубку кладут отсюда же: сервер кончит разговор обоим', async () => {
    const { call, voice } = await talking();
    call.hangUp();

    expect(voice.leaveVoice).toHaveBeenCalledWith(true);
    expect(call.callRoom()).toBeNull();
  });

  it('отбой вызова, который ещё не стал разговором, шлёт call-cancel', async () => {
    // Раньше `hangUp` выходила по одному лишь `!room` и в этом случае не
    // делала ничего: кнопка «отбой» экрана дозвона (задача 6) не могла
    // бросить вызов, который ещё звонит или ждёт посадки. `mine` при этом уже
    // стоит (см. `dialCall`), комнаты ещё нет.
    const { call } = await fresh();
    void call.dialCall('ff');
    reply({ ok: true, ringId: 'r1' });
    await Promise.resolve();

    call.hangUp();

    expect(socket.emit).toHaveBeenLastCalledWith(
      'call-cancel',
      { ringId: 'r1' },
      expect.any(Function),
    );
    // Забытый вызов: опоздавшее «принято» по нему в комнату уже не сажает.
    handlers['call-state'](accepted('r1') as never);
    await Promise.resolve();
    expect(call.callRoom()).toBeNull();
  });

  /**
   * Разговор кончается двумя путями, и второй — обычный: человек сам жмёт
   * «Отбой»/«Выйти» в панели голоса (`Controls`, `Sidebar`, `MobileNav`) или
   * бьёт хоткей. Все они зовут `leaveVoice` напрямую и про `lib/call.ts` не
   * знают; пока тот об этом не узнавал, `room`/`mine` оставались набитыми
   * навсегда — и серверный `call-over` приезжал в комнату, которую сокет уже
   * покинул.
   */
  it('выход из голоса кнопкой кончает разговор и здесь', async () => {
    const { call, voice } = await talking();

    voice.leaveVoice(true);

    expect(call.callRoom()).toBeNull();
    expect(call.ownedCall()).toBeNull();
  });

  it('...и следующий отбой отменяет дозвон, а не выдёргивает из канала', async () => {
    const { call, voice } = await talking();
    voice.leaveVoice(true);
    vi.mocked(voice.leaveVoice).mockClear();
    socket.emit.mockReset();

    // Позже человек звонит кому-то ещё и жмёт «Отбой» до ответа. Устаревший
    // `room` уводил `hangUp` в ветку разговора: вместо отмены дозвона
    // `leaveVoice(true)` выдёргивал человека из того голосового канала, в
    // котором он на самом деле сидит.
    void call.dialCall('ff');
    reply({ ok: true, ringId: 'r2' });
    await Promise.resolve();
    call.hangUp();

    expect(voice.leaveVoice).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenLastCalledWith(
      'call-cancel',
      { ringId: 'r2' },
      expect.any(Function),
    );
  });

  it('выход из ЧУЖОЙ комнаты разговора не касается', async () => {
    const { call } = await talking();
    // Тот же хук приходит и на переезд между обычными каналами, и на мягкий
    // выход внутри захода в саму комнату беседы (`joinVoice` покидает прежний
    // канал сам). Разбери его без сверки комнаты — и посадка в разговор
    // сносила бы саму себя.
    const { onVoiceLeft } = await import('@/lib/voice');
    const notify = vi.mocked(onVoiceLeft).mock.calls[0]?.[0] as (room: string) => void;
    notify('obshchii');

    expect(call.callRoom()).toBe(ROOM);
  });

  it('без своего вызова и без комнаты отбой не шлёт ничего', async () => {
    const { call } = await fresh();
    call.hangUp();
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('вызов, набранный на СОСЕДНЕМ устройстве, бросают по имени', async () => {
    // `call-state{ringing}` уходит на все устройства звонящего (§4.2), и экран
    // дозвона открывается там, где не набирали: `mine` пуст, комнаты нет, и
    // `hangUp()` промолчал бы — вызов продолжал бы звонить у собеседника.
    // Право на отбой сервер проверяет по личности, так что назвать вызов
    // отсюда законно.
    const { call } = await fresh();

    call.cancelCall('r1');

    expect(socket.emit).toHaveBeenLastCalledWith(
      'call-cancel',
      { ringId: 'r1' },
      expect.any(Function),
    );
  });

  it('...и если вызов всё-таки был свой, владение снимается вместе с ним', async () => {
    const { call, voice } = await fresh();
    void call.dialCall('ff');
    reply({ ok: true, ringId: 'r1' });
    await Promise.resolve();

    call.cancelCall('r1');

    // Опоздавшее «принято» по брошенному вызову в комнату уже не сажает —
    // иначе микрофон открылся бы после того, как человек положил трубку.
    expect(call.ownedCall()).toBeNull();
    handlers['call-state'](accepted('r1') as never);
    await Promise.resolve();
    expect(voice.joinVoice).not.toHaveBeenCalled();
  });
});

describe('отклонить входящий', () => {
  it('шлёт call-decline и ничего не трогает у себя', async () => {
    // Отклоняющая вкладка не звонила и не отвечала — `mine` у неё и так пуст
    // (владение заявляют только `dialCall`/`answerCall`), так что отклонение
    // не обязано его снимать: снимать нечего.
    const { call } = await fresh();

    call.declineCall('r1');

    expect(socket.emit).toHaveBeenLastCalledWith(
      'call-decline',
      { ringId: 'r1' },
      expect.any(Function),
    );
    expect(call.ownedCall()).toBeNull();
  });
});
