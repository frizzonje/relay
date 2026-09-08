import { beforeEach, describe, expect, it, vi } from 'vitest';
import { issueGuestToken } from '../auth/auth';
import { asSocket, type FakeServer, type FakeSocket } from './testkit';
import { MessageRow } from '../db/entities';
import { DmService } from './dm.service';
import { callRoom } from './voice-sessions';
import {
  connect,
  connectAs,
  database,
  disconnect,
  makeGateway,
  personCookie,
  settle,
  tune,
  until,
  useGatewayStand,
} from './gateway.testkit';
import type { SignalingGateway } from './signaling.gateway';

/**
 * Дозвон: состояние между двумя людьми, живущее до ответа.
 *
 * Разбор гонок проверяется не здесь, а в машине состояний (она чистая, и
 * прогнать её можно сотней случаев за миллисекунду). Здесь — ровно то, чего
 * машина знать не может, потому что для каждого случая нужно видеть всю
 * инсталляцию сразу: что вызов принадлежит ЛИЧНОСТИ, а не сокету; что двое,
 * набравшие друг друга в одну секунду, не остаются в двух вызовах; и что
 * правила дома (кому можно, как часто, включено ли вообще) спрашиваются в
 * момент набора, а не при сборке.
 */

useGatewayStand();

let gw: SignalingGateway;
let server: FakeServer;
let settings: Awaited<ReturnType<typeof makeGateway>>['settings'];

beforeEach(async () => {
  ({ gw, server, settings } = await makeGateway());
  // Умолчание каталога — «звонить можно тому, с кем есть переписка». Заводить
  // беседу в каждом тесте значило бы проверять ЛС, а не дозвон; правило это
  // проверяется своим тестом ниже.
  await tune(settings, 'calls.whoCanCall', 'everyone');
});

/** Двое вошедших: у каждого личность и по одному устройству. */
async function pair() {
  const anya = await personCookie('Аня');
  const boris = await personCookie('Боря');
  const hers = await connectAs(gw, server, anya.cookie, { id: 'аня' });
  const his = await connectAs(gw, server, boris.cookie, { id: 'боря' });
  settle();
  server.clearAll();
  return { anya, boris, hers, his };
}

/** Позвонить отпечатку — так, как это делает клиент. */
function call(from: FakeSocket, fingerprint: string, video = false) {
  return gw.handleCallStart(asSocket(from), { fingerprint, video });
}

/** Что за вызов приехал этому сокету последним событием такого рода. */
function last(sock: FakeSocket, event: string): Record<string, unknown> | undefined {
  return sock.last(event) as Record<string, unknown> | undefined;
}

describe('дозвон', () => {
  it('звонок доходит до всех устройств собеседника', async () => {
    const { anya, boris, hers, his: laptop } = await pair();
    // Второе устройство Бори: звонят человеку, а не выбранной вкладке.
    const phone = await connectAs(gw, server, boris.cookie, { id: 'боря-телефон' });
    settle();
    server.clearAll();

    const res = await call(hers, boris.fingerprint, true);
    expect(res.ok).toBe(true);
    const ringId = res.ok ? res.ringId : '';

    // Оба устройства перечислены поимённо, а не отобраны условием: отбор по id
    // фикстуры позеленел бы впустую в тот день, когда id поменяются, — тело
    // цикла просто не выполнилось бы ни разу.
    for (const sock of [laptop, phone]) {
      expect([sock.id, last(sock, 'call-incoming')]).toEqual([
        sock.id,
        {
          ringId,
          from: { fingerprint: anya.fingerprint, nick: 'Аня' },
          at: Date.now(),
          video: true,
        },
      ]);
    }
    // Звонящему — свой же дозвон, и тоже на все его устройства.
    expect(last(hers, 'call-state')).toMatchObject({
      ringId,
      state: 'ringing',
      peer: { fingerprint: boris.fingerprint, nick: 'Боря' },
      video: true,
    });
    // Собеседнику `call-state` про «звонит» не шлётся: тот же факт уже уехал
    // входящим, и второе событие о нём было бы шумом.
    expect(phone.got('call-state')).toBe(false);
  });

  it('принявшее устройство гасит входящий на остальных', async () => {
    const { anya, boris, hers } = await pair();
    const phone = await connectAs(gw, server, boris.cookie, { id: 'боря-телефон' });
    settle();
    server.clearAll();

    const res = await call(hers, boris.fingerprint);
    const ringId = res.ok ? res.ringId : '';
    const laptop = server.all.get('боря')!;
    laptop.clear();
    phone.clear();

    expect(gw.handleCallAccept(asSocket(phone), { ringId })).toEqual({ ok: true });

    // Ноутбук, на котором не отвечали, обязан узнать, что входящий кончился, —
    // иначе он звонит в пустой комнате до самого таймаута.
    expect(last(laptop, 'call-state')).toMatchObject({ ringId, state: 'accepted' });
    expect(last(hers, 'call-state')).toMatchObject({
      ringId,
      state: 'accepted',
      peer: { fingerprint: boris.fingerprint, nick: 'Боря' },
    });
    expect(last(phone, 'call-state')).toMatchObject({
      peer: { fingerprint: anya.fingerprint, nick: 'Аня' },
    });
    // Вызов принят — владелец его больше не держит: обоим можно звонить снова.
    expect((await call(hers, boris.fingerprint)).ok).toBe(true);
  });

  it('вызов не в сети отвечает offline и оставляет отметку о пропущенном', async () => {
    const { boris, hers, his } = await pair();
    disconnect(gw, server, his);
    settle();

    // Ушедший ещё числится «недавно» у присутствия, но звонить ему уже некуда:
    // живых устройств нет ни одного.
    expect(await call(hers, boris.fingerprint)).toEqual({ ok: false, error: 'offline' });
    // Вызова не случилось вовсе — значит и рассказывать о нём нечего.
    expect(hers.got('call-state')).toBe(false);

    // А вот когда собеседник пропадает уже ПОСЛЕ начала дозвона, вызов доходит
    // до конца и оставляет след: исход `failed`, помеченный `missed`. Саму
    // строку в переписку пишет чат (задача 8) — здесь считается только флаг.
    const back = await connectAs(gw, server, boris.cookie, { id: 'боря-снова' });
    settle();
    server.clearAll();
    const res = await call(hers, boris.fingerprint);
    disconnect(gw, server, back);

    expect(last(hers, 'call-ended')).toMatchObject({
      ringId: res.ok ? res.ringId : '',
      state: 'failed',
      missed: true,
    });
  });

  it('вызов занятому отвечает busy', async () => {
    const { anya, boris, hers, his } = await pair();
    const vera = await personCookie('Вера');
    const hers2 = await connectAs(gw, server, vera.cookie, { id: 'вера' });
    settle();
    server.clearAll();

    // Занят вызовом: Аня уже дозванивается до Бори.
    expect((await call(hers, boris.fingerprint)).ok).toBe(true);
    expect(await call(hers2, boris.fingerprint)).toEqual({ ok: false, error: 'busy' });
    // И сама Аня занята тем же вызовом — с другой стороны.
    expect(await call(hers2, anya.fingerprint)).toEqual({ ok: false, error: 'busy' });

    // Занят разговором: сидящего в голосовом канале инсталляция считает занятым
    // (`calls.busyWhenInVoice`).
    // Освобождаем обоих: пока вызов жив, «занято» отвечало бы по инварианту
    // «один живой вызов на личность», а проверить надо голосовой канал.
    expect(
      gw.handleCallDecline(asSocket(his), { ringId: last(his, 'call-incoming')!.ringId as string }),
    ).toEqual({ ok: true });
    gw.handleJoin(asSocket(his), { room: 'voice-obshchii', name: 'Боря' });
    settle();
    expect(await call(hers2, boris.fingerprint)).toEqual({ ok: false, error: 'busy' });

    // Выключенное правило возвращает его в число доступных, не тронув эфира.
    await tune(settings, 'calls.busyWhenInVoice', false);
    expect((await call(hers2, boris.fingerprint)).ok).toBe(true);
  });

  it('таймаут закрывает вызов и обеим сторонам говорит «не ответили»', async () => {
    const { boris, hers, his } = await pair();
    await tune(settings, 'calls.ringTimeoutSeconds', 10);

    const res = await call(hers, boris.fingerprint);
    const ringId = res.ok ? res.ringId : '';
    hers.clear();
    his.clear();

    vi.advanceTimersByTime(9_000);
    expect(hers.got('call-ended')).toBe(false);
    vi.advanceTimersByTime(1_500);

    // Обеим сторонам, а не только звонившему: у собеседника иначе просто молча
    // пропадает входящий, и он не узнаёт, что звонок был.
    for (const sock of [hers, his]) {
      expect([sock.id, last(sock, 'call-ended')]).toMatchObject([
        sock.id,
        { ringId, state: 'no-answer', missed: true },
      ]);
    }
    // Таймер снят вместе с вызовом: обоим снова можно звонить.
    expect((await call(hers, boris.fingerprint)).ok).toBe(true);
  });

  it('обрыв сокета звонящего до ответа отменяет вызов', async () => {
    const { anya, boris, hers, his } = await pair();
    // Второе устройство звонящей: пока оно живо, вызов не отменяется — вызов
    // принадлежит личности, а не вкладке.
    const phone = await connectAs(gw, server, anya.cookie, { id: 'аня-телефон' });
    settle();
    server.clearAll();

    const res = await call(hers, boris.fingerprint);
    const ringId = res.ok ? res.ringId : '';
    disconnect(gw, server, hers);
    expect(his.got('call-ended')).toBe(false);

    disconnect(gw, server, phone);
    expect(last(his, 'call-ended')).toMatchObject({ ringId, state: 'cancelled', missed: false });
    // Отбой звонящего отметки о пропущенном не оставляет: собеседник и не успел
    // ничего пропустить.
    expect(await call(his, anya.fingerprint)).toEqual({ ok: false, error: 'offline' });
  });

  it('двое, позвонившие друг другу одновременно, не остаются в двух вызовах', async () => {
    const { anya, boris, hers, his } = await pair();

    const first = await call(hers, boris.fingerprint);
    const second = await call(his, anya.fingerprint);

    // Правило симметрично: уцелевает тот вызов, который дошёл до владельца
    // первым, а набравший вторым видит входящий от первого и может его принять.
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, error: 'busy' });
    const ringId = first.ok ? first.ringId : '';
    expect(last(his, 'call-incoming')).toMatchObject({ ringId });
    expect(gw.handleCallAccept(asSocket(his), { ringId })).toEqual({ ok: true });
    expect(last(hers, 'call-state')).toMatchObject({ ringId, state: 'accepted' });
  });

  it('whoCanCall=conversation не даёт позвонить тому, с кем нет переписки', async () => {
    const { anya, boris, hers, his } = await pair();
    await tune(settings, 'calls.whoCanCall', 'conversation');

    expect(await call(hers, boris.fingerprint)).toEqual({ ok: false, error: 'forbidden' });

    // Заведённая беседа — и только она — открывает дверь. «Виделись в одном
    // канале» тут ни при чём: это правило первого сообщения, а не звонка.
    await gw.handleDmOpen(asSocket(hers), { fingerprint: boris.fingerprint });
    expect((await call(hers, boris.fingerprint)).ok).toBe(true);
    // И в обратную сторону: беседа одна на двоих.
    gw.handleCallDecline(asSocket(his), { ringId: last(his, 'call-incoming')!.ringId as string });
    expect((await call(his, anya.fingerprint)).ok).toBe(true);

    await tune(settings, 'calls.whoCanCall', 'nobody');
    gw.handleCallCancel(asSocket(his), { ringId: last(his, 'call-state')!.ringId as string });
    expect(await call(hers, boris.fingerprint)).toEqual({ ok: false, error: 'forbidden' });
  });

  it('calls.enabled=false отвечает disabled', async () => {
    const { boris, hers, his } = await pair();
    await tune(settings, 'calls.enabled', false);

    expect(await call(hers, boris.fingerprint)).toEqual({ ok: false, error: 'disabled' });
    expect(his.got('call-incoming')).toBe(false);

    // Гостю по инвайту и клиенту без личности дозвон не положен ни при каком
    // выключателе: адресовать их нечем.
    await tune(settings, 'calls.enabled', true);
    const guest = connect(gw, server, { guest: 'токен' });
    expect(await call(guest, boris.fingerprint)).toEqual({ ok: false, error: 'forbidden' });
    const anon = connect(gw, server, { clientId: 'устройство' });
    expect(await call(anon, boris.fingerprint)).toEqual({ ok: false, error: 'forbidden' });
  });

  it('видео зажимается настройкой, а отметка о пропущенном — своей', async () => {
    const { boris, hers, his } = await pair();
    await tune(settings, 'calls.videoAllowed', false);

    // Не отказ, а звонок без камеры: инсталляция без видео не должна оставлять
    // человека вовсе без связи — она лишь снимает камеру.
    const res = await call(hers, boris.fingerprint, true);
    expect(res.ok).toBe(true);
    expect(last(his, 'call-incoming')).toMatchObject({ video: false });
    expect(last(hers, 'call-state')).toMatchObject({ state: 'ringing', video: false });

    // А выключенная отметка гасит флаг, не трогая самого исхода: «не ответили»
    // остаётся «не ответили», просто следа в переписке не будет.
    await tune(settings, 'calls.missedMarkEnabled', false);
    await tune(settings, 'calls.ringTimeoutSeconds', 10);
    gw.handleCallCancel(asSocket(hers), { ringId: res.ok ? res.ringId : '' });
    const second = await call(hers, boris.fingerprint);
    vi.advanceTimersByTime(11_000);

    expect(last(hers, 'call-ended')).toMatchObject({
      ringId: second.ok ? second.ringId : '',
      state: 'no-answer',
      missed: false,
    });
  });

  it('гость с кукой личности не становится ни целью звонка, ни её устройством', async () => {
    const { anya, boris, hers, his } = await pair();
    // Вкладка, в которой Боря открыл чужую инвайт-ссылку: кука личности при нём,
    // но контур пускает его гостем. Личности у такого сокета нет ни для дозвона,
    // ни для присутствия — иначе состав инсталляции утекал бы за приглашение.
    const { token } = issueGuestToken('voice-obshchii');
    const invited = await connectAs(gw, server, boris.cookie, {
      id: 'боря-инвайт',
      guest: token,
    });
    settle();
    server.clearAll();

    // Сам он звонить не может: личности у него нет.
    expect(await call(invited, anya.fingerprint)).toEqual({ ok: false, error: 'forbidden' });

    // Пока живо настоящее устройство, вызов до Бори доходит — но НЕ на вкладку
    // приглашения.
    const res = await call(hers, boris.fingerprint);
    expect(res.ok).toBe(true);
    expect(his.got('call-incoming')).toBe(true);
    expect(invited.got('call-incoming')).toBe(false);

    // И вкладка приглашения не держит вызов живым за ушедшего хозяина: ушло его
    // настоящее устройство — вызов сорвался.
    disconnect(gw, server, his);
    expect(last(hers, 'call-ended')).toMatchObject({
      ringId: res.ok ? res.ringId : '',
      state: 'failed',
    });
    // И целью звонка он больше не считается, хотя вкладка с его кукой открыта.
    expect(await call(hers, boris.fingerprint)).toEqual({ ok: false, error: 'offline' });
  });

  it('лимит звонков в час срабатывает и не мешает принимать входящие', async () => {
    const { anya, boris, hers, his } = await pair();
    await tune(settings, 'calls.maxRingsPerHour', 2);

    for (let i = 0; i < 2; i += 1) {
      const res = await call(hers, boris.fingerprint);
      expect([i, res.ok]).toEqual([i, true]);
      gw.handleCallCancel(asSocket(hers), { ringId: res.ok ? res.ringId : '' });
    }
    his.clear();
    expect(await call(hers, boris.fingerprint)).toEqual({ ok: false, error: 'rate' });
    // Отказ час не тратит и, что важнее, не задевает собеседника: до него
    // ничего не дошло.
    expect(his.got('call-incoming')).toBe(false);

    // Исчерпавшая предел Аня остаётся ДОСТУПНОЙ: предел считает исходящие.
    // Иначе заслон от назойливости отключал бы человека от связи.
    const res = await call(his, anya.fingerprint);
    expect(res.ok).toBe(true);
    const ringId = res.ok ? res.ringId : '';
    expect(gw.handleCallAccept(asSocket(hers), { ringId })).toEqual({ ok: true });

    // Час скользящий: он проходит — и звонить снова можно.
    vi.advanceTimersByTime(60 * 60_000 + 1);
    expect((await call(hers, boris.fingerprint)).ok).toBe(true);
  });
});

describe('принятый вызов становится разговором', () => {
  it('принятие называет обоим комнату беседы — вывести её клиент не может', async () => {
    const { anya, boris, hers, his } = await pair();
    const res = await call(hers, boris.fingerprint);
    const ringId = res.ok ? res.ringId : '';
    hers.clear();
    his.clear();

    expect(gw.handleCallAccept(asSocket(his), { ringId })).toEqual({ ok: true });

    // Адрес беседы считается из id двух личностей, а id в протоколе не
    // появляется вовсе (§9.3): назвать комнату обязан сервер. Не назови он —
    // клиенту неоткуда узнать, куда садиться, и «принято» не стало бы
    // разговором ни у одного из двоих.
    const room = callRoom(DmService.address(anya.identityId, boris.identityId));
    for (const sock of [hers, his]) {
      expect([sock.id, last(sock, 'call-state')]).toEqual([
        sock.id,
        expect.objectContaining({ ringId, state: 'accepted', room }),
      ]);
    }
  });

  it('комната беседы не приезжает с тем, что разговором не стало', async () => {
    const { boris, hers, his } = await pair();
    const res = await call(hers, boris.fingerprint);
    const ringId = res.ok ? res.ringId : '';

    // «Звонит» — ещё не разговор: комнаты в этот момент нет, и обещать её
    // клиенту значило бы дать ему войти туда до ответа собеседника.
    expect(last(hers, 'call-state')).toMatchObject({ state: 'ringing' });
    expect((last(hers, 'call-state') as { room?: string }).room).toBeUndefined();

    hers.clear();
    gw.handleCallDecline(asSocket(his), { ringId });
    expect((last(hers, 'call-ended') as { room?: string }).room).toBeUndefined();
  });
});

/**
 * Задача 7 плана B (веб — входящий) требует, чтобы второй входящий во время
 * разговора отвечал «занято» САМ, без клиентской машины, которая бы это
 * перепроверяла. Утверждение из протокола (§4.2): личность занята, если она
 * говорит в голосовом канале, а разговор двоих — обычный голосовой канал
 * (`voice:<адрес>`), в который клиент садится сам, приняв вызов (см. `Задача
 * 5`, `voice-sessions.test.ts` → «комната беседы»). Значит присутствие видит
 * их «в голосе» тем же путём, что и обычный канал, и `Rings.busy` (через
 * `calls.busyWhenInVoice`, умолчание true) откажет третьему до того, как
 * `call-incoming` вообще возникнет.
 *
 * Тест ничего не чинит — он ДОКАЗЫВАЕТ существующую гарантию, соединяя
 * `Rings`, `Presence` и `VoiceSessions` так, как их соединяет живой разговор,
 * а не заглушкой. Обратный случай (выключенный `calls.busyWhenInVoice`
 * разрешает звонить поверх разговора) уже покрыт в `voice-sessions.test.ts`
 * («переоткрытая комната не теряет мест уже идущего разговора») — здесь
 * проверяется умолчание, а не исключение.
 */
describe('второй входящий во время разговора', () => {
  it('отвечает занятостью сам — client-side машина ему не нужна', async () => {
    const { anya, boris, hers, his } = await pair();
    const vera = await personCookie('Вера');
    const third = await connectAs(gw, server, vera.cookie, { id: 'вера' });
    settle();

    // Дозвон Ани до Бори принят и стал разговором — оба сели в его комнату
    // ровно так же, как в voice-sessions.test.ts (`talk()`/`accept()`).
    const res = await call(hers, boris.fingerprint);
    const ringId = res.ok ? res.ringId : '';
    expect(gw.handleCallAccept(asSocket(his), { ringId })).toEqual({ ok: true });
    const room = callRoom(DmService.address(anya.identityId, boris.identityId));
    gw.handleJoin(asSocket(hers), { room, name: 'Аня' });
    gw.handleJoin(asSocket(his), { room, name: 'Боря' });
    settle();
    server.clearAll();

    // Третья звонит собеседнику Бори — тому, кому трубку не поднимали,
    // список присутствия видит его «в голосе» через тот же голосовой канал.
    expect(await call(third, boris.fingerprint)).toEqual({ ok: false, error: 'busy' });
    expect(his.got('call-incoming')).toBe(false);

    // И симметрично — со стороны позвонившей: занята и она, хотя это она
    // набирала, а не отвечала.
    expect(await call(third, anya.fingerprint)).toEqual({ ok: false, error: 'busy' });
    expect(hers.got('call-incoming')).toBe(false);
  });
});

/**
 * Отметка о пропущенном (задача 8 плана B).
 *
 * Проверяется здесь, а не в чате, потому что доказывать надо СТЫК: флаг
 * `missed` в `call-ended` и строка в переписке обязаны быть одним решением, а
 * не двумя похожими. Форму самой строки (что она переживает рестарт, что её не
 * находит поиск) проверяет `chat.service.test.ts` — там она пишется напрямую и
 * без сокетов.
 *
 * Отсутствие строки доказывается не паузой, а СЛЕДУЮЩИМ вызовом, который
 * отметку оставляет: «подождали и ничего не приехало» зеленело бы и на
 * сломанной записи, просто не дождавшись её.
 */
describe('отметка о пропущенном', () => {
  /** Строки в переписке этих двоих — прямо из базы, как их увидит перезагрузка. */
  async function marks(a: string, b: string): Promise<MessageRow[]> {
    return database()
      .getRepository(MessageRow)
      .find({ where: { channelId: DmService.address(a, b) }, order: { createdAt: 'ASC' } });
  }

  it('остановка сервиса дожидается начатой отметки', async () => {
    const { boris, hers } = await pair();
    await tune(settings, 'calls.ringTimeoutSeconds', 10);
    // Тишина до начала: подключения стенда тоже заводят фоновую работу (личное
    // первого кадра), и без этой строки проверка ниже держалась бы на ней, а не
    // на отметке — то есть зеленела бы и с потерянной записью.
    await gw.onModuleDestroy();

    // Держим запись за руку: пока обещание не разрешено, отметка не доехала —
    // и остановка не имеет права закончиться.
    let release!: () => void;
    const writing = new Promise<void>((r) => (release = r));
    const chatHandlers = (
      gw as unknown as { chatHandlers: { noteMissedCall: () => Promise<void> } }
    ).chatHandlers;
    vi.spyOn(chatHandlers, 'noteMissedCall').mockReturnValue(writing);

    await call(hers, boris.fingerprint);
    vi.advanceTimersByTime(11_000);

    let stopped = false;
    const stopping = gw.onModuleDestroy().then(() => (stopped = true));
    // Крутим цикл щедро и выходим раньше, если остановка всё-таки закончилась:
    // проверка обязана падать на потерянной записи, а не просто не успевать её
    // заметить. Часы поддельные, поэтому оборот цикла даётся самими таймерами.
    for (let i = 0; i < 40 && !stopped; i++) await vi.advanceTimersByTimeAsync(5);
    // Вот ради этой строки всё и написано: сервис, остановленный посреди
    // записи, ждёт её. Иначе отметка о звонке, случившемся за секунду до
    // рестарта, упиралась бы в закрытую базу — а на стенде тестов брошенная
    // запись встречала бы TRUNCATE следующего теста (см. gateway.testkit).
    expect(stopped).toBe(false);

    release();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('«не ответили» оставляет в переписке отметку с длительностью дозвона', async () => {
    const { anya, boris, hers, his } = await pair();
    await tune(settings, 'calls.ringTimeoutSeconds', 10);

    await call(hers, boris.fingerprint);
    vi.advanceTimersByTime(11_000);

    // Ждём не строку в базе, а её доставку: список переписок обеих сторон
    // обязан узнать о пропущенном — иначе человек с закрытой вкладкой беседы
    // так и не поймёт, что ему звонили.
    await until(() => hers.got('dm-activity'), 'отметка доехала до списка переписок');
    expect(his.got('dm-activity')).toBe(true);

    const rows = await marks(anya.identityId, boris.identityId);
    expect(rows.map((r) => [r.system, r.call, r.authorIdentityId])).toEqual([
      // Длительность — ровно таймаут дозвона, а не время до срабатывания
      // будильника: часы события ставит машина, а не тот, кто её разбудил.
      [true, { state: 'no-answer', ms: 10_000 }, anya.identityId],
    ]);

    // Находка ревью: `dm-activity` обязан нести `call` рядом с `preview`, а не
    // только строка в базе, — иначе список переписок и тост активности так и
    // остались бы рисовать непереведённую серверную запаску `preview`
    // (`ChatMessage.call` — единственный способ клиенту узнать, что это
    // отметка, а не обычная реплика).
    expect(last(hers, 'dm-activity')).toMatchObject({ call: { state: 'no-answer', ms: 10_000 } });
    expect(last(his, 'dm-activity')).toMatchObject({ call: { state: 'no-answer', ms: 10_000 } });
  });

  it('отклонённый вызов отметки не оставляет', async () => {
    const { anya, boris, hers, his } = await pair();
    await tune(settings, 'calls.ringTimeoutSeconds', 10);

    const declined = await call(hers, boris.fingerprint);
    expect(
      gw.handleCallDecline(asSocket(his), { ringId: declined.ok ? declined.ringId : '' }),
    ).toEqual({ ok: true });

    // Второй вызов — тот, что отметку оставляет: по его приезду видно, что
    // запись вообще работает, а значит единственная строка в переписке
    // принадлежит ему, и от отклонённого не осталось ничего.
    await call(hers, boris.fingerprint);
    vi.advanceTimersByTime(11_000);
    await until(() => hers.got('dm-activity'), 'отметка второго вызова');

    const rows = await marks(anya.identityId, boris.identityId);
    expect(rows.map((r) => r.call)).toEqual([{ state: 'no-answer', ms: 10_000 }]);
  });

  it('живёт по своей настройке, а не по выключателю системных строк', async () => {
    const { anya, boris, hers, his } = await pair();
    await tune(settings, 'calls.ringTimeoutSeconds', 10);
    // Выключатель join/leave-уведомлений. Отметку о пропущенном он не касается:
    // «Аня вошла в канал» и «вам звонили» — разные обещания, и владелец,
    // убравший болтовню из ленты, не отказывался узнавать о звонках.
    await tune(settings, 'messages.systemMessages', false);

    await call(hers, boris.fingerprint);
    vi.advanceTimersByTime(11_000);
    await until(() => hers.got('dm-activity'), 'отметка при выключенных системных строках');
    expect((await marks(anya.identityId, boris.identityId)).length).toBe(1);

    // А своя настройка её гасит — и целиком: ни строки, ни рассылки.
    await tune(settings, 'calls.missedMarkEnabled', false);
    hers.clear();
    his.clear();
    await call(hers, boris.fingerprint);
    vi.advanceTimersByTime(11_000);
    // Решение «писать ли» принимается в тот же миг, что и рассылка `call-ended`
    // (одно и то же вычисление, см. `Rings.announce`), — дождавшись её, мы
    // дождались и записи, если бы она была.
    await until(() => hers.got('call-ended'), 'конец второго вызова');
    expect(hers.got('dm-activity')).toBe(false);
    expect((await marks(anya.identityId, boris.identityId)).length).toBe(1);
  });

  it('заводит переписку, если её ещё не было: звонок был позволен, а следа иначе не останется', async () => {
    const { anya, boris, hers } = await pair();
    await tune(settings, 'calls.ringTimeoutSeconds', 10);
    // `everyone` (его ставит `pair`) — звонить можно и тому, с кем не переписывались.
    expect(await marks(anya.identityId, boris.identityId)).toEqual([]);

    await call(hers, boris.fingerprint);
    vi.advanceTimersByTime(11_000);
    await until(() => hers.got('dm-activity'), 'отметка в только что заведённой переписке');

    expect((await marks(anya.identityId, boris.identityId)).map((r) => r.call)).toEqual([
      { state: 'no-answer', ms: 10_000 },
    ]);
  });
});
