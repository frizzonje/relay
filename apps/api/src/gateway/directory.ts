import type { AppServer, AppSocket } from './socket-data';
import type { Perimeter } from './perimeter';
import type { ChatService } from './chat.service';
import type { RegistryService } from './registry.service';
import { type PublicChannel, type PublicServer, publicChannel } from './ownership';

/**
 * Окно коалесцирования рассылок «на всех». Правки реестра ходят пачками
 * (создание сервера — это сразу servers + channels, удаление — каналы следом за
 * сервером), реплики в чате — тем более. Без коалесцирования работа растёт как
 * квадрат числа сокетов: каждое сообщение с каждого сокета — обход всех
 * остальных. 80 мс задержки в сайдбаре не видит никто.
 */
export const BROADCAST_DEBOUNCE_MS = 80;

/**
 * Витрина реестра: каким этот сокет видит список серверов и каналов и как эта
 * картинка расходится по всем.
 *
 * Сам реестр (кто владелец, какие каналы существуют, запись на диск) живёт в
 * `registry.service.ts` и сюда не переезжает. Здесь — ровно то, чего там быть
 * не может: **у каждого сокета своя витрина**. Она зависит от введённых
 * паролей, от собственных записей и от банов, а раз так — рассылка не может
 * быть одним `emit` в общую комнату, и вся её цена (обход сокетов, сборка
 * payload на каждого) лежит именно тут.
 *
 * Поэтому же здесь и таймер дебаунса: он — состояние, и владеть им должен тот,
 * чью рассылку он откладывает.
 */
export class Directory {
  private channelsTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly registry: RegistryService,
    private readonly chat: ChatService,
    private readonly perimeter: Perimeter,
    private readonly serverOf: () => AppServer,
  ) {}

  private get server(): AppServer {
    return this.serverOf();
  }

  /**
   * Публичная форма реестра серверов: без хэша пароля, с флагом `locked` и с
   * `mine` — «этой записью управляешь ты». Наружу уходит именно флаг, а не
   * clientId владельца: рассылать id значило бы раздавать всем то единственное,
   * чем правило владения и держится (см. ./ownership).
   */
  serversFor(client: AppSocket): PublicServer[] {
    const banned = this.perimeter.bannedFrom(client);
    const all = this.registry.publicServers(this.perimeter.claimant(client));
    return banned?.size ? all.filter((s) => !banned.has(s.id)) : all;
  }

  /**
   * Каналы, видимые сокету: из закрытых серверов — только если он их
   * разблокировал. Текстовым подмешиваем время последнего сообщения: по нему
   * клиент зажигает «непрочитано» сразу после загрузки, не дожидаясь живого
   * `chat-activity`.
   */
  channelsFor(client: AppSocket): PublicChannel[] {
    const who = this.perimeter.claimant(client);
    return this.registry.channels
      .filter((c) => this.perimeter.canSee(client, c))
      .map((c) => publicChannel(c, who, c.type === 'text' ? this.chat.lastTs(c.slug) : 0));
  }

  /**
   * Реестр серверов почти одинаков для всех: различает сокеты ровно один бит —
   * `mine` у записей, созданных этим устройством. Поэтому и группируем по
   * владению: у кого в реестре ничего своего нет (подавляющее большинство),
   * получают один и тот же payload, а отдельная сборка достаётся только тем,
   * кто прямо сейчас онлайн и чем-то владеет.
   *
   * Гости пропускаются, как и в рассылке каналов: по инвайту человек пришит к
   * своему эфиру и реестра не получает вовсе — ни на подключении, ни правкой.
   * Сама рассылка идёт на создание/удаление сервера, то есть считанные разы за
   * сессию: обход сокетов здесь ничего не стоит (в отличие от каналов и
   * активности чата, где он и разгонялся до квадрата — см. S4).
   */
  broadcastServers(): void {
    const owners = this.registry.ownerIds(this.registry.servers);
    const byOwner = new Map<string, PublicServer[]>();
    for (const sock of this.server.sockets.sockets.values()) {
      if (this.perimeter.isGuest(sock)) continue;
      const key = this.ownerKey(sock, owners);
      let payload = byOwner.get(key);
      if (!payload) {
        payload = this.serversFor(sock);
        byOwner.set(key, payload);
      }
      sock.emit('servers', payload);
    }
  }

  /**
   * Каналы у каждого свои (закрытые серверы скрыты до пароля), поэтому рассылка
   * пер-сокетная — и потому же она была самой дорогой в гейтвее: на каждую
   * правку реестра полный обход сокетов, а внутри на каждый — фильтр всех
   * каналов с поиском сервера по id.
   *
   * Считаем иначе. Набор каналов зависит ровно от двух вещей — какие закрытые
   * серверы этот сокет разблокировал и какие каналы созданы им самим. Сокеты с
   * одинаковой парой получают одинаковый ответ, и подавляющее большинство
   * сидит в одной группе (ничего не разблокировано, ничем не владеет).
   * Плюс дебаунс: правки реестра ходят пачками.
   */
  broadcastChannels(): void {
    if (this.channelsTimer) return;
    this.channelsTimer = setTimeout(() => {
      this.channelsTimer = null;
      const owners = this.registry.ownerIds(this.registry.channels);
      const byGroup = new Map<string, PublicChannel[]>();
      for (const sock of this.server.sockets.sockets.values()) {
        if (this.perimeter.isGuest(sock)) continue;
        const key =
          this.registry.visibilityKey(this.perimeter.unlockedOf(sock)) +
          '\u0001' +
          this.ownerKey(sock, owners);
        let payload = byGroup.get(key);
        if (!payload) {
          payload = this.channelsFor(sock);
          byGroup.set(key, payload);
        }
        sock.emit('channels', payload);
      }
    }, BROADCAST_DEBOUNCE_MS);
    this.channelsTimer.unref?.();
  }

  /**
   * Чем этот сокет отличается от прочих с точки зрения реестра: своими записями
   * и своими банами. Пустая строка — общая группа «не владелец, не забанен», в
   * ней сидит подавляющее большинство. Владелец инсталляции — своя группа на
   * всех: ему принадлежит всё, и второй такой на инсталляции невозможен.
   *
   * Баны обязаны быть в ключе: два сокета с одинаковым владением, но разными
   * банами получают РАЗНЫЕ реестры, и общая группа отдала бы забаненному
   * сервер, с которого его выгнали.
   */
  private ownerKey(client: AppSocket, owners: Set<string>): string {
    const who = this.perimeter.claimant(client);
    const banned = [...(this.perimeter.bannedFrom(client) ?? [])].sort().join('\u0004');
    const mine = who.owner
      ? '\u0003owner'
      : [who.identityId, who.clientId].filter((id) => id && owners.has(id)).join('\u0002');
    return banned ? `${mine}\u0005${banned}` : mine;
  }
}
