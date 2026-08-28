import { beforeEach, describe, expect, it } from 'vitest';
import { issueGuestToken } from '../auth/auth';
import { asSocket } from './testkit';
import {
  connect,
  connectAs,
  makeGateway,
  makeOwner,
  ownServer,
  personCookie,
  putUpload,
  say,
  settle,
  slugOf,
  tune,
  until,
  useGatewayStand,
} from './gateway.testkit';
import type { SignalingGateway } from './signaling.gateway';
import type { FakeServer } from './testkit';

useGatewayStand();

let gw: SignalingGateway;
let server: FakeServer;
let roles: Awaited<ReturnType<typeof makeGateway>>['roles'];
let owner: Awaited<ReturnType<typeof makeGateway>>['owner'];
let settings: Awaited<ReturnType<typeof makeGateway>>['settings'];

beforeEach(async () => {
  ({ gw, server, roles, owner, settings } = await makeGateway());
});

describe('открытие переписки', () => {
  it('двое приходят к одной беседе', async () => {
    const me = await personCookie('я');
    const you = await personCookie('ты');
    const mine = await connectAs(gw, server, me.cookie);
    const yours = await connectAs(gw, server, you.cookie);

    const a = await gw.handleDmOpen(asSocket(mine), { fingerprint: you.fingerprint });
    const b = await gw.handleDmOpen(asSocket(yours), { fingerprint: me.fingerprint });

    expect(a.ok && b.ok).toBe(true);
    expect(a.ok && b.ok && a.conversation.slug).toBe(b.ok ? b.conversation.slug : '');
    expect(a.ok && a.conversation.peer.nick).toBe('ты');
  });

  it('гостю по инвайту ЛС не положены', async () => {
    const guest = connect(gw, server, { guest: 'токен' });
    const you = await personCookie('ты');
    const res = await gw.handleDmOpen(asSocket(guest), { fingerprint: you.fingerprint });
    expect(res).toEqual({ ok: false, error: 'forbidden' });
  });

  it('без личности ЛС не положены', async () => {
    const anon = connect(gw, server, { clientId: 'устройство' });
    const you = await personCookie('ты');
    const res = await gw.handleDmOpen(asSocket(anon), { fingerprint: you.fingerprint });
    expect(res).toEqual({ ok: false, error: 'forbidden' });
  });

  it('с собой беседу не открыть', async () => {
    const me = await personCookie('я');
    const mine = await connectAs(gw, server, me.cookie);
    const res = await gw.handleDmOpen(asSocket(mine), { fingerprint: me.fingerprint });
    expect(res).toEqual({ ok: false, error: 'self' });
  });

  it('забаненному на инсталляции не написать', async () => {
    const me = await personCookie('я');
    const you = await personCookie('ты');
    const mine = await connectAs(gw, server, me.cookie);
    // Бан на всю инсталляцию — та же строка ролей, по которой забаненного не
    // видно в списке людей (`dm-people`). Отпечаток при этом никуда не делся, и
    // до этой проверки беседа заводилась: доставить в неё нечего, а строка в
    // списке навсегда выглядела бы как живой человек.
    const boss = await personCookie('Хозяин');
    await makeOwner(owner, boss.identityId);
    await roles.ban(you.identityId, null, boss.identityId);

    const res = await gw.handleDmOpen(asSocket(mine), { fingerprint: you.fingerprint });

    // Отвечаем как на незнакомый отпечаток: кто забанен, из чужого интерфейса
    // видно быть не должно.
    expect(res).toEqual({ ok: false, error: 'unknown' });
  });

  it('незнакомый отпечаток беседу не открывает', async () => {
    const me = await personCookie('я');
    const mine = await connectAs(gw, server, me.cookie);
    const res = await gw.handleDmOpen(asSocket(mine), { fingerprint: 'aa'.repeat(32) });
    expect(res).toEqual({ ok: false, error: 'unknown' });
  });
});

describe('дверь одна на всех', () => {
  it('без личности не открыть список, не войти в беседу и не искать собеседника', async () => {
    const anon = connect(gw, server, { clientId: 'устройство' });
    expect(await gw.handleDmList(asSocket(anon))).toEqual({ ok: false, error: 'forbidden' });
    expect(await gw.handleDmJoin(asSocket(anon), { slug: 'dm-ffffffffffffffffffffffff' })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await gw.handleDmPeople(asSocket(anon), {})).toEqual({ ok: false, error: 'forbidden' });
  });
});

describe('вход в беседу', () => {
  it('пускает сторону и отдаёт ей ленту', async () => {
    const me = await personCookie('я');
    const you = await personCookie('ты');
    const mine = await connectAs(gw, server, me.cookie);
    const opened = await gw.handleDmOpen(asSocket(mine), { fingerprint: you.fingerprint });
    const slug = opened.ok ? opened.conversation.slug : '';

    mine.clear();
    const res = await gw.handleDmJoin(asSocket(mine), { slug });

    expect(res).toEqual({ ok: true });
    expect(mine.got('chat-history')).toBe(true);
    expect((mine.last('chat-history') as { slug: string }).slug).toBe(slug);
  });

  it('не пускает третьего', async () => {
    const me = await personCookie('я');
    const you = await personCookie('ты');
    const third = await personCookie('третий');
    const mine = await connectAs(gw, server, me.cookie);
    const theirs = await connectAs(gw, server, third.cookie);
    const opened = await gw.handleDmOpen(asSocket(mine), { fingerprint: you.fingerprint });
    const slug = opened.ok ? opened.conversation.slug : '';

    const res = await gw.handleDmJoin(asSocket(theirs), { slug });

    expect(res).toEqual({ ok: false, error: 'forbidden' });
    expect(theirs.got('chat-history')).toBe(false);
  });

  it('отвечает «нет такой» на выдуманный адрес', async () => {
    const me = await personCookie('я');
    const mine = await connectAs(gw, server, me.cookie);
    const res = await gw.handleDmJoin(asSocket(mine), {
      slug: 'dm-ffffffffffffffffffffffff',
    });
    expect(res).toEqual({ ok: false, error: 'unknown' });
  });
});

describe('переписка после входа', () => {
  it('реплика доходит до второй стороны обычным chat-message', async () => {
    const me = await personCookie('я');
    const you = await personCookie('ты');
    const mine = await connectAs(gw, server, me.cookie);
    const yours = await connectAs(gw, server, you.cookie);
    const opened = await gw.handleDmOpen(asSocket(mine), { fingerprint: you.fingerprint });
    const slug = opened.ok ? opened.conversation.slug : '';
    await gw.handleDmJoin(asSocket(mine), { slug });
    await gw.handleDmJoin(asSocket(yours), { slug });
    yours.clear();

    await gw.handleChatMessage(asSocket(mine), { text: 'привет' });

    expect((yours.last('chat') as { text: string }).text).toBe('привет');
  });
});

describe('список и люди', () => {
  it('переписка появляется в списке обеих сторон', async () => {
    const me = await personCookie('я');
    const you = await personCookie('ты');
    const mine = await connectAs(gw, server, me.cookie);
    const yours = await connectAs(gw, server, you.cookie);
    await gw.handleDmOpen(asSocket(mine), { fingerprint: you.fingerprint });

    const forMe = await gw.handleDmList(asSocket(mine));
    const forYou = await gw.handleDmList(asSocket(yours));

    expect(forMe.ok && forMe.conversations[0].peer.nick).toBe('ты');
    expect(forYou.ok && forYou.conversations[0].peer.nick).toBe('я');
  });

  it('в списке людей нет меня самого', async () => {
    const me = await personCookie('я');
    await personCookie('ты');
    const mine = await connectAs(gw, server, me.cookie);
    const res = await gw.handleDmPeople(asSocket(mine), {});
    expect(res.ok && res.people.map((p) => p.nick)).toEqual(['ты']);
  });
});

describe('активность беседы', () => {
  it('уходит двоим и не уходит третьему', async () => {
    const me = await personCookie('я');
    const you = await personCookie('ты');
    const third = await personCookie('третий');
    const mine = await connectAs(gw, server, me.cookie);
    const yours = await connectAs(gw, server, you.cookie);
    const theirs = await connectAs(gw, server, third.cookie);
    const opened = await gw.handleDmOpen(asSocket(mine), { fingerprint: you.fingerprint });
    const slug = opened.ok ? opened.conversation.slug : '';
    await gw.handleDmJoin(asSocket(mine), { slug });
    yours.clear();
    theirs.clear();

    await gw.handleChatMessage(asSocket(mine), { text: 'привет' });
    settle();

    const relay = yours.last('dm-activity') as {
      slug: string;
      preview: string;
      previewMine: boolean;
    };
    expect(relay.slug).toBe(slug);
    expect(relay.preview).toBe('привет');
    // Для второй стороны реплика не «моя».
    expect(relay.previewMine).toBe(false);
    // Никакой глобальной активности с адресом беседы.
    expect(theirs.got('dm-activity')).toBe(false);
    expect(theirs.got('chat-activity')).toBe(false);
    expect(mine.all('chat-activity')).toEqual([]);
  });

  it('на гостевой сокет той же личности превью не уходит', async () => {
    const me = await personCookie('я');
    const you = await personCookie('ты');
    const mine = await connectAs(gw, server, me.cookie);
    const yours = await connectAs(gw, server, you.cookie);

    // Тот же человек открыл ссылку-приглашение: сокет и с его кукой личности, и
    // с гостевым токеном. Гостевой контур урезан намеренно (страница инвайта,
    // часто чужое устройство), и текст личной переписки на него ехать не должен
    // — ровно как туда не уходит реестр и упоминания.
    const { token } = issueGuestToken('voice-obshchii');
    const guest = server.connect({ cookie: you.cookie, auth: { guest: token } });
    await server.run(guest);
    gw.handleConnection(asSocket(guest));
    guest.clear();

    const opened = await gw.handleDmOpen(asSocket(mine), { fingerprint: you.fingerprint });
    const slug = opened.ok ? opened.conversation.slug : '';
    await gw.handleDmJoin(asSocket(mine), { slug });
    yours.clear();

    await gw.handleChatMessage(asSocket(mine), { text: 'секрет' });
    settle();

    // Обычный сокет собеседника — получил; гостевой — нет.
    expect((yours.last('dm-activity') as { preview: string }).preview).toBe('секрет');
    expect(guest.got('dm-activity')).toBe(false);
  });
});

describe('отметки чтения', () => {
  it('беседа дочитывается и отметка возвращается на другое устройство', async () => {
    const me = await personCookie('я');
    const you = await personCookie('ты');
    const mine = await connectAs(gw, server, me.cookie);
    const opened = await gw.handleDmOpen(asSocket(mine), { fingerprint: you.fingerprint });
    const slug = opened.ok ? opened.conversation.slug : '';
    await gw.handleDmJoin(asSocket(mine), { slug });
    const msg = (await gw.handleChatMessage(asSocket(mine), { text: 'привет' }),
    mine.last('chat')) as { ts: number };

    // Часы стенда фальшивые и застыли в момент старта теста, а `msg.ts` —
    // настоящее время базы, которое успело уйти вперёд за несколько
    // реальных обращений к ней. `reads.mark` не даёт дочитать канал «из
    // будущего» (см. `reads.service`), так что без этого их надо сперва
    // догнать — иначе отметка молча срежется до часов стенда.
    await until(() => Date.now() >= msg.ts, 'часы стенда догнали время реплики');
    await gw.handleReadMark(asSocket(mine), { slug, ts: msg.ts });

    // Второе устройство подключается уже после отметки — снимок личного он
    // получает не сразу (см. `handleConnection`: `send()` не дожидаются), и
    // без этого ожидания проверка ловила бы момент до того, как база успела
    // ответить, а не отсутствие самой отметки. Ждём именно `mentions` —
    // последнее, что шлёт `send()`: иначе следующий тест мог бы застать
    // хвост этого запроса ещё в полёте.
    const second = await connectAs(gw, server, me.cookie, { id: 'второе', keep: true });
    await until(() => second.got('mentions'), 'снимок личного для второго устройства');
    const reads = second.last('reads') as { marks: Record<string, number> };
    expect(reads.marks[slug]).toBe(msg.ts);
  });
});

/**
 * Беседа с уже сказанным «привет»: заводит двоих, открывает переписку, вводит
 * обе стороны в ленту и говорит. С этого начинается каждый тест о том, чего в
 * беседе нет, — закрепления, чужого поиска и счётчика упоминаний.
 */
async function conversationWithMessage() {
  const me = await personCookie('я');
  const you = await personCookie('ты');
  const mine = await connectAs(gw, server, me.cookie);
  const yours = await connectAs(gw, server, you.cookie);
  const opened = await gw.handleDmOpen(asSocket(mine), { fingerprint: you.fingerprint });
  const slug = opened.ok ? opened.conversation.slug : '';
  await gw.handleDmJoin(asSocket(mine), { slug });
  await gw.handleDmJoin(asSocket(yours), { slug });
  await gw.handleChatMessage(asSocket(mine), { text: 'привет' });
  const id = (mine.last('chat') as { id: string }).id;
  return { slug, mine, yours, id, peerFingerprint: you.fingerprint };
}

describe('чего в беседе нет', () => {
  it('закрепить нельзя', async () => {
    const { id, mine } = await conversationWithMessage();
    const res = await gw.handleChatPin(asSocket(mine), { id, on: true });
    expect(res).toEqual({ ok: false, error: 'forbidden' });
  });

  it('поиск не выходит за пределы переписки и находит своё', async () => {
    const { slug, mine } = await conversationWithMessage();
    // На сервере есть канал с тем же словом — он не должен попасть в выдачу.
    const owner = connect(gw, server, { id: 'поиск-владелец' });
    await ownServer(gw, owner);
    await say(gw, owner, slugOf('болталка'), 'привет');

    const res = await gw.handleChatSearch(asSocket(mine), { query: 'привет', scope: 'server' });
    expect(res.ok && res.hits.every((h) => h.slug === slug)).toBe(true);
    // Не вакуумная проверка на пустом множестве: своя реплика беседы и правда
    // находится, и слаг у находки — адрес беседы. Ровно здесь id канала беседы
    // переводится в её адрес через `ChatService.slugOf`.
    expect(res.ok && res.hits).toHaveLength(1);
    expect(res.ok && res.hits[0]?.slug).toBe(slug);
  });

  it('поиск из канала не достаёт беседу', async () => {
    const { slug: dmSlug } = await conversationWithMessage();
    const owner = connect(gw, server, { id: 'канал-владелец' });
    await ownServer(gw, owner);
    await say(gw, owner, slugOf('болталка'), 'привет');

    const res = await gw.handleChatSearch(asSocket(owner), { query: 'привет', scope: 'server' });
    expect(res.ok && res.hits.some((h) => h.slug === dmSlug)).toBe(false);
    expect(res.ok && res.hits).toHaveLength(1);
  });

  it('устаревший вопрос о закреплённом получает отказ, а не чужой слаг', async () => {
    // Спросили про канал, из которого уже ушли в беседу. Ответ `ok` со слагом
    // беседы — это ответ не про то, о чём спрашивали: клиент нарисовал бы
    // пустой список закреплённого над той лентой, о которой не спрашивал.
    const me = await personCookie('я');
    const you = await personCookie('ты');
    const mine = await connectAs(gw, server, me.cookie);
    const opened = await gw.handleDmOpen(asSocket(mine), { fingerprint: you.fingerprint });
    const slug = opened.ok ? opened.conversation.slug : '';
    await gw.handleDmJoin(asSocket(mine), { slug });

    expect(await gw.handleChatPins(asSocket(mine), { slug: 'obshchii' })).toEqual({ ok: false });
    // А вопрос про саму беседу по-прежнему получает честный пустой список.
    expect(await gw.handleChatPins(asSocket(mine), { slug })).toEqual({ ok: true, slug, pins: [] });
  });

  it('список закреплённого в беседе всегда пуст', async () => {
    const { mine, slug } = await conversationWithMessage();
    const res = await gw.handleChatPins(asSocket(mine), {});
    expect(res).toEqual({ ok: true, slug, pins: [] });
  });

  it('упоминание в беседе не растит счётчик', async () => {
    const { mine, yours, peerFingerprint } = await conversationWithMessage();
    yours.clear();
    // Отпечаток пришлось назвать явно (как называет его настоящий клиент,
    // выбравший имя в подсказке): без него `resolve` вернул бы пустой список
    // ещё до всякой проверки на беседу, и тест не отличил бы «упоминание
    // погашено» от «упоминания и не было».
    await gw.handleChatMessage(asSocket(mine), {
      text: 'эй @ты',
      mentions: [peerFingerprint],
    });
    expect(yours.got('mention')).toBe(false);
  });
});

// ── Настройки инсталляции ─────────────────────────────────────────────────

describe('настройки личной переписки', () => {
  /** Двое с ключами: минимум, на котором ЛС вообще что-то значат. */
  async function pair() {
    const me = await personCookie('я');
    const you = await personCookie('ты');
    const mine = await connectAs(gw, server, me.cookie, { id: 'mine' });
    const yours = await connectAs(gw, server, you.cookie, { id: 'yours' });
    return { me, you, mine, yours };
  }

  it('выключенные ЛС отвечают forbidden на все четыре двери сразу', async () => {
    const { you, mine } = await pair();
    await tune(settings, 'direct.enabled', false);
    const forbidden = { ok: false, error: 'forbidden' };
    expect(await gw.handleDmOpen(asSocket(mine), { fingerprint: you.fingerprint })).toEqual(
      forbidden,
    );
    expect(await gw.handleDmList(asSocket(mine))).toEqual(forbidden);
    expect(await gw.handleDmPeople(asSocket(mine), { query: '' })).toEqual(forbidden);
    // Список без двери в него — это показать человеку то, чего он не откроет.
    expect(await gw.handleDmJoin(asSocket(mine), { slug: 'dm-000000000000000000000000' })).toEqual(
      forbidden,
    );
  });

  it('«писать первым нельзя никому» не заводит новую переписку, но не мешает старой', async () => {
    const { me, you, mine, yours } = await pair();
    // Беседа заведена, пока правило ещё разрешало.
    const opened = await gw.handleDmOpen(asSocket(mine), { fingerprint: you.fingerprint });
    expect(opened.ok).toBe(true);

    await tune(settings, 'direct.whoCanStart', 'nobody');
    // Уже заведённая открывается обеими сторонами как прежде: правило про
    // «первым» не обрывает разговор, который уже идёт.
    expect((await gw.handleDmOpen(asSocket(mine), { fingerprint: you.fingerprint })).ok).toBe(true);
    expect((await gw.handleDmOpen(asSocket(yours), { fingerprint: me.fingerprint })).ok).toBe(true);

    // А новая — нет, и это отказ в праве, а не «такого человека нет».
    const third = await personCookie('третий');
    expect(await gw.handleDmOpen(asSocket(mine), { fingerprint: third.fingerprint })).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });

  it('«только тем, с кем пересекался» считает по сказанному в общем канале', async () => {
    const { you, mine, yours } = await pair();
    await tune(settings, 'direct.whoCanStart', 'seen-together');
    expect(await gw.handleDmOpen(asSocket(mine), { fingerprint: you.fingerprint })).toEqual({
      ok: false,
      error: 'forbidden',
    });

    // Оба сказали по слову в одном канале — этого и довольно.
    await say(gw, mine, 'obshchii', 'привет всем');
    await say(gw, yours, 'obshchii', 'и тебе');
    expect((await gw.handleDmOpen(asSocket(mine), { fingerprint: you.fingerprint })).ok).toBe(true);
  });

  it('без настройки первых сообщений никто не считает', async () => {
    // Умолчание — ноль, и ноль значит «без предела»: до панели переписку с
    // незнакомцем не ограничивало ничто, и день обновления не повод это менять.
    const { you, mine } = await pair();
    const third = await personCookie('третий-без-квоты');
    expect((await gw.handleDmOpen(asSocket(mine), { fingerprint: you.fingerprint })).ok).toBe(true);
    expect((await gw.handleDmOpen(asSocket(mine), { fingerprint: third.fingerprint })).ok).toBe(
      true,
    );
  });

  it('счёт первых сообщений в час ограничивает только новые переписки', async () => {
    const { you, mine } = await pair();
    const third = await personCookie('третий');
    await tune(settings, 'direct.firstMessagesPerHour', 1);

    expect((await gw.handleDmOpen(asSocket(mine), { fingerprint: you.fingerprint })).ok).toBe(true);
    expect(await gw.handleDmOpen(asSocket(mine), { fingerprint: third.fingerprint })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    // Открыть уже заведённую квота не мешает: считаются незнакомцы, а не входы.
    expect((await gw.handleDmOpen(asSocket(mine), { fingerprint: you.fingerprint })).ok).toBe(true);
  });

  it('вложение в беседе выключается отдельно от вложений в каналах', async () => {
    const { you, mine } = await pair();
    const opened = await gw.handleDmOpen(asSocket(mine), { fingerprint: you.fingerprint });
    const slug = opened.ok ? opened.conversation.slug : '';
    await gw.handleDmJoin(asSocket(mine), { slug });
    await putUpload('файл-1');
    await tune(settings, 'direct.attachmentsAllowed', false);
    mine.clear();

    await gw.handleChatMessage(asSocket(mine), { uploadId: 'файл-1' });
    expect(mine.got('chat')).toBe(false);
    expect(mine.last('chat-refused')).toEqual({ reason: 'attachments-off' });

    // В обычном канале тот же файл проезжает: настройка про личное, а не про
    // вложения вообще.
    await gw.handleChatJoin(asSocket(mine), { room: 'obshchii', name: 'я' });
    await gw.handleChatMessage(asSocket(mine), { uploadId: 'файл-1' });
    expect(mine.got('chat')).toBe(true);
  });
});
