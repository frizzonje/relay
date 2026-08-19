import type { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AppServer, AppSocket } from './socket-data';
import type { ChatSessions } from './chat-sessions';
import type { ChatService } from './chat.service';
import type { Directory } from './directory';
import type { Mentions } from './mentions';
import type { Perimeter } from './perimeter';
import type { ReadsService } from '../identity/reads.service';
import type { VoiceSessions } from './voice-sessions';
import { Channel, VoiceMode } from './registry';
import {
  MAIN_SERVER_ID,
  MAX_CHANNELS,
  MAX_SERVERS,
  RegistryService,
  slugifyChannel,
} from './registry.service';
import { ownedBy } from './ownership';
import { clientIp, hashServerPassword, issueUnlockToken } from './unlock';
import {
  LIMIT,
  str,
  trimmed,
  type ChannelCreatePayload,
  type ChannelDeletePayload,
  type ChannelDeleteResult,
  type ChannelModePayload,
  type ChannelRenamePayload,
  type ChannelRenameResult,
  type ChannelStatsPayload,
  type ChannelStatsResult,
  type ServerCreatePayload,
  type ServerDeletePayload,
  type ServerDeleteResult,
  type ServerStatsPayload,
  type ServerStatsResult,
  type ServerUnlockPayload,
} from './protocol';

/**
 * Обработчики реестра: серверы и каналы — заведение, пароль, правка, снос.
 *
 * Сам реестр (список, владельцы, запись на диск) живёт в
 * `registry.service.ts`, витрина каждого сокета — в `directory.ts`. Здесь
 * остаётся то, что не является ни тем, ни другим: **правила сноса**. Они
 * длиннее всего остального в этом файле и не случайно — почти каждая строка
 * оплачена случаем, когда что-то исчезало не вовремя:
 *
 * - канал с людьми в эфире не удаляется вовсе, и через удаление сервера это
 *   правило не обходится (иначе снос уносил бы разговор целиком);
 * - текстовый канал провожают явно: история забывается ДО того, как канал
 *   исчезнет из реестра (слаг разрешается по нему же), а читателей выписывают
 *   из комнаты — иначе они продолжают писать в канал, которого нет ни у кого;
 * - id удалённого сервера освобождается вместе со счётчиком неудачных
 *   паролей: новому серверу с тем же id чужой простой не достаётся.
 */
export class RegistryHandlers {
  constructor(
    private readonly registry: RegistryService,
    private readonly chat: ChatService,
    private readonly chats: ChatSessions,
    private readonly voice: VoiceSessions,
    private readonly reads: ReadsService,
    private readonly perimeter: Perimeter,
    private readonly directory: Directory,
    private readonly mentions: Mentions,
    private readonly serverOf: () => AppServer,
    private readonly logger: Logger,
  ) {}

  private get server(): AppServer {
    return this.serverOf();
  }

  // ===== Реестр серверов =====
  async createServer(
    client: AppSocket,
    payload: ServerCreatePayload,
  ) {
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return;
    // id генерирует клиент — принимаем как есть (санитизируем длину), чтобы он мог
    // сразу открыть новый сервер и создавать в нём каналы, не дожидаясь ответа.
    const id = trimmed(payload?.id, LIMIT.id);
    const name = trimmed(payload?.name, LIMIT.name);
    if (!id || !name) return;
    if (this.registry.servers.length >= MAX_SERVERS) return;
    // Повторный create с тем же id — не плодим дубликаты (напр. ретрай сокета).
    if (this.registry.servers.some((s) => s.id === id)) return;
    const emoji = trimmed(payload?.emoji, LIMIT.emoji) || undefined;
    // Пароль (если задан) → сервер закрытый. Хэшируем, храним только хэш.
    // Хэширование асинхронное и через тот же семафор, что и проверка: в
    // синхронном виде оно стоит десятки миллисекунд ПОЛНОЙ остановки — не пула,
    // а цикла событий, — и цикл «создать закрытый сервер, удалить, повторить»
    // укладывал бы сигналинг с одного сокета.
    const password = str(payload?.password);
    const passwordHash = password ? await hashServerPassword(password) : undefined;
    // Пока считался хэш, реестр мог измениться: тот же id мог занять другой
    // сокет, а свободное место — кончиться.
    if (this.registry.servers.length >= MAX_SERVERS) return;
    if (this.registry.servers.some((s) => s.id === id)) return;

    // Создатель — личность, и он же единственный модератор этого сервера
    // (см. ./ownership). Клиент без ключа (старый или чужой) по-прежнему
    // называется устройством: заслон от ленивого сноса лучше, чем ничего.
    this.registry.servers.push({
      id,
      name,
      emoji,
      removable: true,
      passwordHash,
      ...this.creatorOf(client),
    });
    // Создатель знает пароль — сразу разблокируем сервер для его сокета.
    if (passwordHash) this.perimeter.markUnlocked(client, id);
    this.directory.broadcastServers();
    // Раздаём каналы заново: у создателя новый сервер уже разблокирован.
    this.directory.broadcastChannels();
    await this.registry.persist();
  }
  async unlockServer(
    client: AppSocket,
    payload: ServerUnlockPayload,
  ) {
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return;
    const id = str(payload?.id);
    const password = str(payload?.password);
    const srv = this.registry.servers.find((s) => s.id === id);
    if (!srv) {
      client.emit('server-unlock-result', { id, ok: false });
      return;
    }
    // Открытый сервер — доступен и так; считаем разблокировку успешной.
    if (!srv.passwordHash) {
      client.emit('server-unlock-result', { id, ok: true });
      return;
    }
    // Этот адрес уже отстрелялся неудачами по этому серверу — до конца простоя
    // даже не считаем хэш. Проверка ДО scrypt — она же и есть то, что не даёт
    // перебору забить пул: сам семафор только ограничивает ущерб.
    if (this.perimeter.unlockBlocked(client, id)) {
      client.emit('server-unlock-result', { id, ok: false });
      return;
    }
    const ok = await this.perimeter.passwordFits(srv.passwordHash, password);
    // Пока считался хэш, сервер могли удалить — тогда разблокировать нечего.
    if (!this.registry.servers.some((s) => s.id === id)) {
      client.emit('server-unlock-result', { id, ok: false });
      return;
    }
    if (!ok) {
      // Пишем каждую неудачу, а не только превышение порога: по одной строчке
      // «превышено» не видно ни начала подбора, ни его темпа.
      const { count, until } = this.perimeter.noteUnlockFailure(client, id);
      // Адрес — только для строчки в логе: считает и помнит попытки контур, а
      // разбирают подбор по логу, и без адреса он там бесполезен.
      const ip = clientIp(client.handshake);
      const cooldown =
        until > Date.now() ? `, cooldown ${Math.round((until - Date.now()) / 1000)}s` : '';
      this.logger.warn(`server-unlock: failed attempt ${count} for "${id}" from ${ip}${cooldown}`);
    }
    if (ok) {
      this.perimeter.noteUnlockSuccess(client, id, srv.passwordHash, password);
      this.perimeter.markUnlocked(client, id);
      // Пароль подошёл — теперь этому сокету видны каналы сервера…
      client.emit('channels', this.directory.channelsFor(client));
      // …и состав их эфиров. Без этого строки каналов стоят пустыми до первого
      // чужого входа-выхода: присутствие теперь режется по видимости, и
      // прошлую рассылку этот сокет получил ещё запертым.
      client.emit('voice-presence', this.voice.snapshotFor(client));
      // …и счётчики упоминаний в них: снимок на подключении собирался, когда
      // эти каналы были ещё не видны, и «тебя звали» в них молчало бы до
      // следующего захода.
      void this.mentions.sendSnapshot(client);
      // Пропуск на будущие подключения: с ним разблокировка переживает
      // реконнект, а пароль остаётся там, где ему и место, — у человека.
      // Хэш перечитываем: пока считался scrypt, пароль могли сменить, и
      // подписать пропуск прежним значило бы выдать заведомо мёртвый.
      const fresh = this.registry.servers.find((s) => s.id === id);
      if (fresh?.passwordHash) {
        const { token } = issueUnlockToken(id, fresh.passwordHash);
        client.emit('server-unlock-result', { id, ok, token });
        return;
      }
    }
    client.emit('server-unlock-result', { id, ok });
  }
  async deleteServer(
    client: AppSocket,
    payload: ServerDeletePayload,
  ): Promise<ServerDeleteResult> {
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return { ok: false, error: 'forbidden' };
    const id = str(payload?.id);
    if (!id) return { ok: false, error: 'not-found' };
    const idx = this.registry.servers.findIndex((s) => s.id === id && s.removable);
    if (idx === -1) return { ok: false, error: 'not-found' };
    // Закрытый сервер удалить может только тот, кто ввёл пароль (разблокировал).
    const srv = this.registry.servers[idx];
    if (!this.perimeter.isOpenTo(client, srv)) return { ok: false, error: 'forbidden' };
    // Удаляет создатель сервера — или владелец инсталляции, которому
    // принадлежит всё. У записей без создателя (они старше самого правила
    // владения) владельца не существует: права прежние. Заблокировать их
    // удаление навсегда было бы хуже — чужой не нарочно удалит разве что по
    // неосторожности, а лишённый возможности хозяин не восстановит сервер
    // никак. Отказ пишем в лог: чужой снос — событие, а не шум.
    if (!ownedBy(srv, this.perimeter.claimant(client))) {
      this.logger.warn(`server-delete: "${id}" refused for ${client.id} (not the creator)`);
      return { ok: false, error: 'not-owner' };
    }
    // Живой разговор дороже уборки. Канал с людьми в эфире не удаляется
    // (channel-delete → occupied), и через удаление сервера это правило
    // обходиться не должно: он уносит все свои каналы разом, то есть выбросил
    // бы из разговора сразу всех. Ждём, пока эфир опустеет.
    const occupants = this.voiceOccupantsOfServer(id);
    if (occupants > 0) return { ok: false, error: 'occupied', occupants };
    this.registry.servers.splice(idx, 1);
    // Простой за неудачи вязался к этому id — новому серверу с тем же id он
    // достаться не должен.
    this.perimeter.forgetServer(id);
    this.directory.broadcastServers();

    // Каналы удалённого сервера уходят вместе с ним — иначе повиснут сиротами.
    // Текстовые провожаем так же, как в channel-delete: стираем историю и
    // распускаем комнату, чтобы у читателей не осталось канала-призрака.
    const before = this.registry.channels.length;
    for (let i = this.registry.channels.length - 1; i >= 0; i--) {
      const channel = this.registry.channels[i];
      if (channel.serverId !== id) continue;
      // Забываем ДО того, как канал исчезнет из реестра: слаг разрешается в
      // канал по этому же списку, и после splice забывать было бы уже нечего.
      if (channel.type === 'text') {
        this.chat.forget(channel.slug);
        this.chats.close(this.chat.room(channel.slug), channel.slug);
      }
      this.registry.channels.splice(i, 1);
    }
    if (this.registry.channels.length !== before) this.directory.broadcastChannels();
    await this.registry.persist();
    return { ok: true };
  }

  // Цена удаления сервера для диалога подтверждения: сколько каналов и сколько
  // сообщений исчезнет вместе с ним и сколько человек сидит в его эфирах
  // (пока сидят — сервер не удаляется вовсе, см. server-delete). Права те же,
  // что у server-delete: срез нужен владельцу, которому сервер покажет кнопку,
  // а раздавать его каждому значило бы рассказывать всем, сколько написано в
  // чужих каналах.
  async serverStats(
    client: AppSocket,
    payload: ServerStatsPayload,
  ): Promise<ServerStatsResult> {
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return { ok: false };
    const id = str(payload?.id);
    const srv = this.registry.servers.find((s) => s.id === id);
    if (!srv || !srv.removable) return { ok: false };
    if (!this.perimeter.isOpenTo(client, srv)) return { ok: false };
    if (!ownedBy(srv, this.perimeter.claimant(client))) return { ok: false };
    const own = this.registry.channels.filter((c) => c.serverId === id);
    const counted = await Promise.all(
      own.filter((c) => c.type === 'text').map((c) => this.chat.count(c.slug)),
    );
    return {
      ok: true,
      channels: own.length,
      messages: counted.reduce((sum, n) => sum + n, 0),
      occupants: this.voiceOccupantsOfServer(id),
    };
  }

  // Сколько человек прямо сейчас в голосовых каналах этого сервера. Один обход
  // сокетов на все каналы разом: occupantsOf считает по одному, а здесь их
  // может быть десяток.
  private voiceOccupantsOfServer(serverId: string): number {
    const rooms = new Set(
      this.registry.channels
        .filter((c) => c.serverId === serverId && c.type === 'voice')
        .map((c) => c.slug),
    );
    if (!rooms.size) return 0;
    let count = 0;
    for (const sock of this.server.sockets.sockets.values()) {
      const room = this.voice.roomOf(sock);
      if (room && rooms.has(room)) count++;
    }
    return count;
  }

  // ===== Реестр каналов =====
  async createChannel(
    client: AppSocket,
    payload: ChannelCreatePayload,
  ) {
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return;
    const type = payload?.type === 'voice' ? 'voice' : payload?.type === 'text' ? 'text' : null;
    if (!type) return;
    // Сервер-владелец должен существовать (иначе канал повиснет вне рейки).
    const serverId = str(payload?.serverId) || MAIN_SERVER_ID;
    const srv = this.registry.servers.find((s) => s.id === serverId);
    if (!srv) return;
    // Главный сервер — витрина с фиксированным набором каналов (см.
    // DEFAULT_CHANNELS). Свои каналы заводят в своих серверах; интерфейс тут
    // «+» и не показывает, но запрет держим на сервере, а не на кнопке.
    if (serverId === MAIN_SERVER_ID) return;
    // В закрытый сервер канал создаёт только разблокировавший его сокет.
    if (!this.perimeter.isOpenTo(client, srv)) return;
    const rawName = trimmed(payload?.name, LIMIT.name);
    const slug = slugifyChannel(rawName);
    if (!slug) return;
    if (this.registry.channels.length >= MAX_CHANNELS) return;
    // Слаг уникален глобально (комнаты голоса/чата ключуются по нему) — один слаг
    // на тип по всем серверам, повторное создание не плодит дубликаты.
    if (this.registry.channels.some((c) => c.type === type && c.slug === slug)) return;

    const channel: Channel = {
      id: randomUUID(),
      serverId,
      type,
      name: rawName,
      slug,
      removable: true,
      // Создатель канала — как у серверов: личность, а если ключа нет, то
      // устройство (см. handleServerCreate).
      ...this.creatorOf(client),
      // Режим — только у голосовых; p2p по умолчанию не пишем, отсутствие поля
      // и есть p2p (реестр не распухает, старые записи читаются одинаково).
      ...(type === 'voice' && payload?.mode === 'sfu' ? { mode: 'sfu' as const } : {}),
    };
    this.registry.channels.push(channel);
    this.directory.broadcastChannels();
    await this.registry.persist();
  }

  // Смена транспорта голосового канала. Права те же, что у channel-delete:
  // трогать можно только свои каналы (removable), дефолтные остаются на p2p —
  // они обязаны работать и без поднятого медиасервера.
  async channelMode(
    client: AppSocket,
    payload: ChannelModePayload,
  ) {
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return;
    const id = str(payload?.id);
    const mode: VoiceMode | null =
      payload?.mode === 'sfu' ? 'sfu' : payload?.mode === 'p2p' ? 'p2p' : null;
    if (!id || !mode) return;
    const found = this.editableChannel(client, id);
    if ('error' in found) return;
    if (found.channel.type !== 'voice') return;
    const channel = found.channel;
    const next = mode === 'sfu' ? 'sfu' : undefined;
    if (channel.mode === next) return;
    if (next) channel.mode = next;
    else delete channel.mode;
    this.directory.broadcastChannels();
    // Отдельно — тем, кто прямо сейчас в этом канале: им нужно переехать на
    // другой транспорт. Реестра каналов для этого мало — гость по инвайту его
    // не получает, а переезжать обязан вместе со всеми.
    this.server.to(channel.slug).emit('voice-mode', { room: channel.slug, mode });
    await this.registry.persist();
  }

  /**
   * Сколько человек прямо сейчас в канале: для голосового — кто в эфире, для
   * текстового — у кого он открыт (socket.io-комната `chat:<slug>`).
   */
  private occupantsOf(channel: Channel): number {
    const target = channel.type === 'voice' ? channel.slug : this.chat.room(channel.slug);
    let count = 0;
    for (const sock of this.server.sockets.sockets.values()) {
      const where = channel.type === 'voice' ? this.voice.roomOf(sock) : this.chats.roomOf(sock);
      if (where === target) count++;
    }
    return count;
  }

  /**
   * Канал, который этому сокету разрешено менять. Само правило — в реестре
   * (RegistryService.editable); здесь только распаковка сокета: чьи пароли
   * введены и кто за ним стоит.
   */
  private editableChannel(client: AppSocket, id: string) {
    return this.registry.editable(id, this.perimeter.unlockedOf(client), this.perimeter.claimant(client));
  }

  /**
   * Чьей записью станет создаваемое. Личность, если она есть; устройство, если
   * ключа нет вовсе. Обе колонки сразу не пишем: две двери в один сервер — это
   * не запасной вход, а щель, и открыта она была бы ровно тем, что подделывается
   * (см. ./ownership).
   */
  private creatorOf(client: AppSocket): { creatorIdentityId: string } | { creatorId?: string } {
    const identityId = this.perimeter.speaker(client)?.id;
    return identityId ? { creatorIdentityId: identityId } : { creatorId: this.perimeter.deviceOf(client) };
  }

  // Живой срез канала для диалога подтверждения (сколько человек внутри,
  // сколько сообщений пропадёт). Спрашивают по одному разу на открытие
  // диалога — рассылать это всем постоянно незачем. Права — как у правки:
  // срез канала с людьми и перепиской — это уже данные о нём, их не раздаём.
  async channelStats(
    client: AppSocket,
    payload: ChannelStatsPayload,
  ): Promise<ChannelStatsResult> {
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return { ok: false };
    const id = str(payload?.id);
    const found = this.editableChannel(client, id);
    if ('error' in found) return { ok: false };
    const channel = found.channel;
    return {
      ok: true,
      occupants: this.occupantsOf(channel),
      messages: channel.type === 'text' ? await this.chat.count(channel.slug) : 0,
    };
  }

  // Переименование канала. Меняем ТОЛЬКО отображаемое имя: slug остаётся
  // прежним, потому что по нему ключуются комната эфира, история чата и
  // «непрочитано» — смена имени не должна ни рвать живой звонок, ни терять
  // переписку. Права те же, что у удаления: дефолтные каналы неприкосновенны.
  async renameChannel(
    client: AppSocket,
    payload: ChannelRenamePayload,
  ): Promise<ChannelRenameResult> {
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return { ok: false, error: 'forbidden' };
    const id = str(payload?.id);
    const name = trimmed(payload?.name, LIMIT.name);
    if (!id) return { ok: false, error: 'not-found' };
    if (!name) return { ok: false, error: 'bad-name' };
    const found = this.editableChannel(client, id);
    if ('error' in found) return { ok: false, error: found.error };
    if (found.channel.name === name) return { ok: true };
    found.channel.name = name;
    this.directory.broadcastChannels();
    await this.registry.persist();
    return { ok: true };
  }
  async deleteChannel(
    client: AppSocket,
    payload: ChannelDeletePayload,
  ): Promise<ChannelDeleteResult> {
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return { ok: false, error: 'forbidden' };
    const id = str(payload?.id);
    if (!id) return { ok: false, error: 'not-found' };
    const found = this.editableChannel(client, id);
    if ('error' in found) return { ok: false, error: found.error };
    const { channel, index } = found;

    // Голосовой канал с людьми в эфире не удаляем ни при каких условиях:
    // удаление выбросило бы их из звонка посреди разговора. Текстовый — можно
    // (там теряется только история), но клиент честно предупреждает, сколько
    // человек его сейчас читают.
    if (channel.type === 'voice') {
      const occupants = this.occupantsOf(channel);
      if (occupants > 0) return { ok: false, error: 'occupied', occupants };
    }

    // История удалённого канала уходит вместе с ним (каскадом в базе), а
    // читателей выписываем сами: их клиент мог бы и не заметить пропажу канала
    // в новом реестре, а остаться в комнате — значит продолжать писать в канал,
    // которого больше нет ни у кого. Порядок важен: `forget` разрешает слаг по
    // реестру, поэтому идёт до того, как канал из него исчезнет.
    if (channel.type === 'text') {
      this.chat.forget(channel.slug);
      this.chats.close(this.chat.room(channel.slug), channel.slug);
      // Отметки чтения канала уходят вместе с ним: каскада у них нет намеренно
      // (отметка не должна запирать удаление канала), значит убрать за собой
      // некому, кроме этого места.
      await this.reads.forget(channel.id);
    }
    this.registry.channels.splice(index, 1);
    this.directory.broadcastChannels();
    await this.registry.persist();
    return { ok: true };
  }

}
