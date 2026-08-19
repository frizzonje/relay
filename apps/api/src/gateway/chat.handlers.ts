import type { AppServer, AppSocket } from './socket-data';
import type { ChatSessions } from './chat-sessions';
import type { Directory } from './directory';
import type { Mentions } from './mentions';
import type { Moderation } from './moderation';
import type { Perimeter } from './perimeter';
import type { RegistryService } from './registry.service';
import type { UploadsService } from '../uploads';
import { BROADCAST_DEBOUNCE_MS } from './directory';
import { ChatService, MENTION_SUGGEST_LIMIT, searchTerms } from './chat.service';
import {
  LIMIT,
  str,
  trimmed,
  type ChatAroundPayload,
  type ChatDeletePayload,
  type ChatEditPayload,
  type ChatHistoryAfterPayload,
  type ChatHistoryMorePayload,
  type ChatHistoryMoreResult,
  type ChatPayload,
  type ChatPinPayload,
  type ChatPinResult,
  type ChatPinsPayload,
  type ChatPinsResult,
  type ChatReactPayload,
  type ChatSearchPayload,
  type ChatSearchResult,
  type ChatWindowResult,
  type MentionSuggestPayload,
  type MentionSuggestResult,
} from './protocol';

/**
 * Обработчики текстового канала: вход в ленту, страницы истории, поиск,
 * реплики, правки, закрепление, реакции.
 *
 * Хранение здесь ни при чём — оно в `chat.service.ts`, — и принадлежность
 * сокета к ленте тоже: её держит `ChatSessions`. Что осталось, то и видно в
 * каждом обработчике одинаковой первой строкой: спросить у ленты, где сокет
 * сидит, и работать с ТЕМ каналом. Ни один из них не принимает слаг канала из
 * тела сообщения — иначе прочитать чужую переписку можно было бы, не входя в
 * неё.
 */
export class ChatHandlers {
  // slug -> время последней реплики и сервер, под паролем которого канал лежит
  // (null — открытый или неизвестный). Видимость решаем в момент отправки
  // сообщения, а не при сбросе: канал за эти 80 мс могут удалить, и тогда его
  // слаг — уже «неизвестный» — уехал бы посторонним.
  private readonly pendingActivity = new Map<string, { ts: number; locked: string | null }>();
  private activityTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly registry: RegistryService,
    private readonly chat: ChatService,
    private readonly chats: ChatSessions,
    private readonly uploads: UploadsService,
    private readonly perimeter: Perimeter,
    private readonly directory: Directory,
    private readonly moderation: Moderation,
    private readonly mentions: Mentions,
    private readonly serverOf: () => AppServer,
  ) {}

  private get server(): AppServer {
    return this.serverOf();
  }

  // ===== Текстовый канал =====
  async join(client: AppSocket, payload: ChatPayload) {
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return;
    const slug = trimmed(payload?.room, LIMIT.slug);
    if (!slug) return;
    // Как и в голосовом: имя личности называет сервер (см. nameOf).
    const name = this.perimeter.nameFor(client, trimmed(payload?.name, LIMIT.tag));

    // В несуществующий канал не пускаем: комната-призрак принимала бы сообщения
    // и заново копила историю под удалённым слагом. Случая два, и они разные.
    // Канала нет ни у кого (удалили, пока клиент переподключался) — так и
    // отвечаем, `chat-closed`. Канал есть, но не виден (закрытый сервер, пароль
    // ещё не введён) — молча не пускаем: вводить пароль никто не запрещал, и
    // выгонять из ленты тут не за что. Проверяем ДО выхода из прежней комнаты —
    // неудачный вход не должен выбрасывать из той, где человек уже сидит.
    const known = this.registry.channels.some((c) => c.type === 'text' && c.slug === slug);
    const visible =
      known && this.directory.channelsFor(client).some((c) => c.type === 'text' && c.slug === slug);
    if (!visible) {
      if (!known) client.emit('chat-closed', { slug });
      return;
    }

    // Уже сидел в другом текстовом канале — сначала выходим
    this.chats.leave(client);

    const room = this.chat.room(slug);
    this.chats.enter(client, room, name);

    // Новичку — последняя страница канала. Не вся история: она больше не
    // помещается в один снимок, и остальное он подтянет вверх сам. Вместе с ней
    // — сколько здесь закреплено: число рисуется в шапке сразу, а сам список
    // спрашивают, только когда его открывают.
    const [page, pins] = await Promise.all([this.chat.history(slug), this.chat.pinCount(slug)]);
    client.emit('chat-history', { slug, ...page, pins });
    this.chats.emitRoster(room);
  }

  /**
   * Страница выше уже показанной. Курсор клиент присылает свой — время и id
   * самой верхней реплики, которую он держит; сервер по нему ничего не хранит.
   * Ответ уходит ack'ом, а не событием: страницу ждёт конкретный запрос, и
   * рассылать её в комнату незачем.
   */
  async older(client: AppSocket, payload: ChatHistoryMorePayload): Promise<ChatHistoryMoreResult> {
    const empty = { ok: true as const, messages: [], more: false };
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return empty;
    const room = this.chats.roomOf(client);
    if (!room) return empty;
    const beforeTs = typeof payload?.beforeTs === 'number' ? payload.beforeTs : 0;
    const beforeId = str(payload?.beforeId);
    if (!beforeTs || !beforeId) return empty;
    return { ok: true, ...(await this.chat.older(this.chat.slug(room), beforeTs, beforeId)) };
  }

  /**
   * Страница ниже показанной. Спрашивается только после перехода из поиска: у
   * живого конца канала ниже ничего нет, и обычное чтение сюда не приходит.
   */
  async newer(client: AppSocket, payload: ChatHistoryAfterPayload): Promise<ChatWindowResult> {
    const empty = { ok: true as const, messages: [], more: false, moreAfter: false };
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return empty;
    const room = this.chats.roomOf(client);
    if (!room) return empty;
    const afterTs = typeof payload?.afterTs === 'number' ? payload.afterTs : 0;
    const afterId = str(payload?.afterId);
    if (!afterTs || !afterId) return empty;
    return { ok: true, ...(await this.chat.newer(this.chat.slug(room), afterTs, afterId)) };
  }

  /**
   * Окно вокруг реплики — то, чем заканчивается переход из результатов поиска.
   *
   * Канал не называется: берём тот, в котором сокет сидит. Клиент, идущий в
   * чужой канал, сперва входит в него обычным `chat-join` (и там же проверяются
   * права), а socket.io держит порядок событий одного сокета, так что к моменту
   * этого запроса комната уже та.
   */
  async around(client: AppSocket, payload: ChatAroundPayload): Promise<ChatWindowResult> {
    const empty = { ok: true as const, messages: [], more: false, moreAfter: false };
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return empty;
    const room = this.chats.roomOf(client);
    const id = str(payload?.id);
    if (!room || !id) return empty;
    return { ok: true, ...(await this.chat.around(this.chat.slug(room), id)) };
  }

  /**
   * Поиск по истории.
   *
   * Область называет клиент, но каналы по ней собирает сервер: «по серверу»
   * значит «по тем его текстовым каналам, которые видно этому сокету», и решать
   * это клиенту не дают нигде. Пустой набор каналов — пустой результат, а не
   * отказ: искать в закрытом сервере, пароль от которого не введён, не
   * запрещено, там просто нечего найти.
   */
  async search(client: AppSocket, payload: ChatSearchPayload): Promise<ChatSearchResult> {
    const empty = { ok: true as const, hits: [], more: false, terms: [] };
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return empty;
    const room = this.chats.roomOf(client);
    if (!room) return empty;
    const here = this.registry.channels.find(
      (c) => c.type === 'text' && c.slug === this.chat.slug(room),
    );
    if (!here || !this.perimeter.canSee(client, here)) return empty;

    const query = trimmed(payload?.query, LIMIT.search);
    const terms = searchTerms(query);
    if (!terms.length) return empty;

    const scope = payload?.scope === 'server' ? 'server' : 'channel';
    const channels =
      scope === 'server'
        ? this.registry.channels.filter(
            (c) =>
              c.type === 'text' && c.serverId === here.serverId && this.perimeter.canSee(client, c),
          )
        : [here];

    const beforeTs = typeof payload?.beforeTs === 'number' ? payload.beforeTs : 0;
    const beforeId = str(payload?.beforeId);
    const cursor = beforeTs && beforeId ? { ts: beforeTs, id: beforeId } : undefined;

    const { hits, more } = await this.chat.search(
      channels.map((c) => c.id),
      query,
      cursor,
    );
    return { ok: true, hits, more, terms };
  }

  /**
   * Кого предложить после набранного `@`.
   *
   * Список собирает сервер, и в него попадают только те, кому этот канал виден:
   * подсказать человека, который не может прочитать канал, значит предложить
   * позвать его в комнату за запертой дверью. Себя в подсказке нет — позвать
   * себя нельзя, и место в списке из восьми имён этим не тратится.
   */
  async mentionSuggest(
    client: AppSocket,
    payload: MentionSuggestPayload,
  ): Promise<MentionSuggestResult> {
    const empty = { ok: true as const, people: [] };
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return empty;
    const room = this.chats.roomOf(client);
    if (!room) return empty;
    const here = this.registry.channels.find(
      (c) => c.type === 'text' && c.slug === this.chat.slug(room),
    );
    if (!here || !this.perimeter.canSee(client, here)) return empty;

    const prefix = trimmed(payload?.prefix, LIMIT.tag).toLowerCase();
    const me = this.perimeter.speaker(client)?.fingerprint;
    const seen = new Set<string>();
    const people: MentionSuggestResult['people'] = [];

    // Сначала те, кто сейчас на связи: для них упоминание — не запись в
    // историю, а обращение, которое они увидят сию минуту.
    for (const sock of this.server.sockets.sockets.values()) {
      const who = this.perimeter.speaker(sock);
      if (!who || who.fingerprint === me || seen.has(who.fingerprint)) continue;
      if (this.perimeter.isGuest(sock) || !this.perimeter.canSee(sock, here)) continue;
      if (prefix && !who.nick.toLowerCase().startsWith(prefix)) continue;
      seen.add(who.fingerprint);
      people.push({ fingerprint: who.fingerprint, nick: who.nick, online: true });
    }

    // Затем — говорившие на этом сервере, в тех его каналах, что видно
    // спрашивающему: звать через канал человека, о котором ты знаешь только по
    // соседнему каналу, — обычное дело.
    const channels = this.registry.channels.filter(
      (c) => c.type === 'text' && c.serverId === here.serverId && this.perimeter.canSee(client, c),
    );
    const spoke = await this.chat.mentionCandidates(
      channels.map((c) => c.id),
      prefix,
    );
    for (const person of spoke) {
      if (person.fingerprint === me || seen.has(person.fingerprint)) continue;
      seen.add(person.fingerprint);
      people.push({ ...person, online: false });
    }

    return { ok: true, people: people.slice(0, MENTION_SUGGEST_LIMIT) };
  }
  leave(client: AppSocket) {
    this.chats.leave(client);
  }
  async message(client: AppSocket, payload: ChatPayload) {
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return;
    const room = this.chats.roomOf(client);
    if (!room) return;
    const text = trimmed(payload?.text, LIMIT.message);

    // Вложение называется id'ом загрузки, а не url'ом и не mime: подставить
    // себе чужой файл или соврать про его тип клиент не может — метаданные
    // берутся из таблицы вложений (см. chat.service).
    const uploadId = str(payload?.uploadId);
    if (!text && !(await this.uploads.exists(uploadId))) return;

    const mentions = await this.mentions.resolve(text, payload?.mentions);

    // Снимок цитаты, вложение и время назначает хранилище: время — потому что
    // по нему же строится курсор ленты, и оно обязано быть одних часов с ней.
    const msg = await this.chat.add(this.chat.slug(room), {
      name: this.chats.nameOf(client),
      // Авторство пишется рядом с именем, а не вместо: имя — снимок момента,
      // личность — то, по чему потом сверяются правка, удаление и модерация.
      identityId: this.perimeter.speaker(client)?.id,
      text,
      uploadId,
      spoiler: payload?.spoiler === true,
      replyToId: str(payload?.replyTo),
      mentions,
    });
    // Канал удалили, пока сообщение шло, — писать его некуда.
    if (!msg) return;

    this.server.to(room).emit('chat', msg);
    this.mentions.ping(client, mentions, this.chat.slug(room), msg.ts);
    // Лёгкий пинг активности: сайдбар зажигает «непрочитано» на закрытых сейчас
    // каналах. Только слаг и время, без содержимого. Рассылаем не всем подряд, а
    // тем, кому канал виден: слаг канала закрытого сервера — часть секрета, и
    // «в тайном канале сейчас пишут» посторонним знать неоткуда.
    const slug = this.chat.slug(room);
    const channel = this.registry.channels.find((c) => c.type === 'text' && c.slug === slug);
    const srv = channel ? this.registry.servers.find((s) => s.id === channel.serverId) : undefined;
    this.queueChatActivity(slug, msg.ts, srv?.passwordHash ? srv.id : null);
  }

  /**
   * Пинг активности — это состояние («в канале писали в такой-то момент»), а не
   * событие, поэтому его можно копить: из десяти реплик подряд смысл несёт
   * последняя. Без этого каждое сообщение каждого участника означало обход всех
   * сокетов — та самая квадратичная работа при живом разговоре.
   */
  private queueChatActivity(slug: string, ts: number, locked: string | null) {
    this.pendingActivity.set(slug, { ts, locked });
    if (this.activityTimer) return;
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null;
      const batch = [...this.pendingActivity];
      this.pendingActivity.clear();
      for (const sock of this.server.sockets.sockets.values()) {
        if (this.perimeter.isGuest(sock)) continue; // гостю реестр не положен вовсе
        const unlocked = this.perimeter.unlockedOf(sock);
        for (const [slug, { ts, locked }] of batch) {
          if (locked && !unlocked?.has(locked)) continue;
          sock.emit('chat-activity', { slug, ts });
        }
      }
    }, BROADCAST_DEBOUNCE_MS);
    this.activityTimer.unref?.();
  }

  /**
   * Своё ли это сообщение. У реплики с личностью сверяется отпечаток — тот
   * самый, что нарисован рядом с ней в ленте: подписаться чужим именем теперь
   * нельзя, а значит и правку чужого именем не открыть.
   *
   * Без личности остаётся прежнее сравнение имён (audit S1): так подписаны
   * реплики гостей и всё, что написано до 1.0. Строгость там взять не из чего —
   * зато и не притворяемся, что она есть.
   */
  private ownsMessage(client: AppSocket, msg: { name: string; fingerprint?: string }): boolean {
    if (msg.fingerprint) return this.perimeter.speaker(client)?.fingerprint === msg.fingerprint;
    return msg.name === this.chats.nameOf(client);
  }

  // Правка своего сообщения — автора сверяет ownsMessage.
  // Системные и сообщения-вложения без текста не редактируем.
  async edit(client: AppSocket, payload: ChatEditPayload) {
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return;
    const room = this.chats.roomOf(client);
    if (!room) return;
    const id = str(payload?.id);
    const text = trimmed(payload?.text, LIMIT.message);
    if (!id || !text) return;

    const msg = await this.chat.find(this.chat.slug(room), id);
    if (!msg) return;
    if (!this.ownsMessage(client, msg)) return;

    const mentions = await this.mentions.resolve(text, payload?.mentions);
    const editedTs = await this.chat.edit(id, text, mentions);
    this.server.to(room).emit('chat-edited', { id, text, editedTs, mentions });

    // Позвали правкой — значит позвали. Молчать здесь означало бы, что имя,
    // дописанное через минуту после отправки, увидит только тот, кто и так
    // читает канал, — то есть ровно не тот, кого звали. Уже названным второй
    // раз не звоним: правка опечатки — не повод повторить вызов.
    const already = new Set((msg.mentions ?? []).map((m) => m.fingerprint));
    this.mentions.ping(
      client,
      mentions.filter((m) => !already.has(m.fingerprint)),
      this.chat.slug(room),
      editedTs,
    );
  }

  // Удаление сообщения: своего — автором, любого — модератором сервера, которому
  // принадлежит канал (и владельцем инсталляции поверх него). Убираем из истории
  // и просим всех снять из ленты. Цитаты в чужих ответах не трогаем — они хранят
  // собственный снимок.
  //
  // Правка чужого при этом остаётся невозможной, и это не недосмотр: удалить
  // сказанное — модерация, переписать сказанное чужим именем — подлог.
  async remove(client: AppSocket, payload: ChatDeletePayload) {
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return;
    const room = this.chats.roomOf(client);
    if (!room) return;
    const id = str(payload?.id);
    if (!id) return;

    const slug = this.chat.slug(room);
    const msg = await this.chat.find(slug, id);
    if (!msg) return;
    if (!this.ownsMessage(client, msg) && !this.moderation.moderatesRoom(client, room)) return;

    if (!(await this.chat.remove(id))) return;
    this.server.to(room).emit('chat-deleted', { id });

    // Удалили закреплённое — закрепление ушло вместе с ним (ON DELETE CASCADE),
    // а число в шапке про это не знает. Считать его клиенту самому значило бы
    // требовать, чтобы каждый держал у себя список закреплённого целиком — ради
    // одного вычитания.
    if (msg.pinned) {
      this.server
        .to(room)
        .emit('chat-pinned', { id, pinned: false, count: await this.chat.pinCount(slug) });
    }
  }

  /**
   * Закрепить или открепить реплику.
   *
   * Право то же, что и на удаление чужого, — модерация сервера, и это не
   * строгость ради строгости. Закрепление меняет канал для всех, кто в него
   * зайдёт, и вдобавок вынимает реплику из-под ретенции: это единственный
   * способ оставить сказанное жить дольше четырнадцати дней. Раздай мы его
   * каждому вошедшему — и срок хранения перестал бы что-либо значить, а шапка
   * канала стала бы доской объявлений для случайного гостя.
   */
  async pin(client: AppSocket, payload: ChatPinPayload): Promise<ChatPinResult> {
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client))
      return { ok: false, error: 'forbidden' };
    const room = this.chats.roomOf(client);
    if (!room) return { ok: false, error: 'forbidden' };
    const id = str(payload?.id);
    if (!id) return { ok: false, error: 'not-found' };
    if (!this.moderation.moderatesRoom(client, room)) return { ok: false, error: 'forbidden' };

    const slug = this.chat.slug(room);
    // «Закрепить» приходит явно, а не выводится из того, что клиент видит у
    // себя: его лента бывает старше действительности на одно чужое действие,
    // и «переключить» сняло бы то, что человек только что хотел поставить.
    const on = payload?.on === true;

    if (on) {
      const res = await this.chat.pin(slug, id, this.perimeter.speaker(client)?.id ?? null);
      if (res === 'gone') return { ok: false, error: 'not-found' };
      if (res === 'limit') return { ok: false, error: 'limit' };
    } else if (!(await this.chat.unpin(slug, id))) {
      return { ok: false, error: 'not-found' };
    }

    const count = await this.chat.pinCount(slug);
    this.server.to(room).emit('chat-pinned', { id, pinned: on, count });
    return { ok: true, pinned: on, count };
  }

  /**
   * Закреплённое канала списком — по запросу, а не в снимке при входе:
   * закреплённых бывает полсотни, и слать их каждому входящему в канал ради
   * поповера, который откроют однажды, незачем.
   */
  async pins(client: AppSocket, payload: ChatPinsPayload): Promise<ChatPinsResult> {
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return { ok: false };
    const room = this.chats.roomOf(client);
    if (!room) return { ok: false };
    const slug = this.chat.slug(room);
    // Спросили про другой канал — значит спрашивавший уже не здесь: отвечаем
    // отказом, а не списком того канала, где сокет оказался.
    const asked = trimmed(payload?.slug, LIMIT.slug);
    if (asked && asked !== slug) return { ok: false };
    return { ok: true, slug, pins: await this.chat.pinned(slug) };
  }

  // «Печатает…»: клиент шлёт с троттлингом, релеим остальным в канале (себе — нет).
  // Тег берём с сокета, тело клиента не нужно. allow() гасит перебор.
  typing(client: AppSocket) {
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return;
    const room = this.chats.roomOf(client);
    if (!room) return;
    const name = this.chats.nameOf(client);
    client.to(room).emit('chat-typing', { name });
  }

  // Тогл реакции на сообщение: тег добавляется/снимается из набора по эмодзи.
  // Состояние храним в истории канала и рассылаем всем читающим — как и сами сообщения.
  async react(client: AppSocket, payload: ChatReactPayload) {
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return;
    const room = this.chats.roomOf(client);
    if (!room) return;
    const id = str(payload?.id);
    const emoji = str(payload?.emoji);
    if (!id || !this.chat.knownReaction(emoji)) return;

    const msg = await this.chat.findAny(this.chat.slug(room), id);
    if (!msg) return;

    const name = this.chats.nameOf(client);
    const reactions = this.chat.toggleReaction(msg, name, emoji);
    await this.chat.saveReactions(id, reactions);

    this.server.to(room).emit('chat-reaction', { id, reactions });
  }
}
