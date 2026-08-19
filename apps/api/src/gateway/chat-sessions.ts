import type { AppServer, AppSocket } from './socket-data';
import { ANON_NAME, type RosterPerson } from './protocol';

/** Что чат-сессия спрашивает у того, чем не владеет. */
export interface ChatSurroundings {
  /** Отпечаток ключа — если сокет предъявил личность. По нему склеивается ростер. */
  fingerprintOf(sock: AppSocket): string | undefined;
}

/**
 * Владелец чат-сессии: в какой ленте сидит сокет и под каким именем пишет.
 *
 * Хранение реплик тут ни при чём — оно давно в `chat.service.ts`. Здесь
 * переезжает только принадлежность сокета к ленте: `chatRoom` был самым
 * затёртым полем на сокете (двадцать одно обращение — больше, чем у любого
 * другого), и каждое из них само решало, что делать с его отсутствием.
 *
 * Пара `chatRoom` + `chatName` живёт и умирает вместе. Разъехаться им нельзя:
 * имя без комнаты попадает в ростер канала, из которого человек уже вышел, а
 * комната без имени — это участник, которого ростер молча пропускает (см.
 * `roster`), то есть человек, сидящий в канале невидимкой.
 */
export class ChatSessions {
  constructor(
    private readonly serverOf: () => AppServer,
    private readonly around: ChatSurroundings,
  ) {}

  private get server(): AppServer {
    return this.serverOf();
  }

  /** Лента, которую читает этот сокет, — или `undefined`, если он ни в какой. */
  roomOf(client: AppSocket): string | undefined {
    return client.data.chatRoom;
  }

  /**
   * Подпись этого сокета в текстовом канале. Имя самоназванное (см. S1
   * ревизии), но по нему же сверяется авторство правки и удаления, поэтому
   * читается оно в одном месте и с одним запасным вариантом.
   */
  nameOf(client: AppSocket): string {
    return client.data.chatName || ANON_NAME;
  }

  /**
   * Сокет садится в ленту. Из прежней он к этому моменту уже вышел.
   *
   * Ростер отсюда НЕ рассылаем: новичку сначала уходит страница истории, и
   * только потом остальным — обновлённый состав. Порядок этих двух сообщений
   * виден снаружи, поэтому решает его обработчик, а не мы.
   */
  enter(client: AppSocket, room: string, name: string | undefined): void {
    client.join(room);
    client.data.chatRoom = room;
    client.data.chatName = name || ANON_NAME;
  }

  /**
   * Сокет выходит из ленты. Пусто — значит его там и не было: `leave` зовут и
   * вслепую (обрыв, бан, вход в другой канал), и вслепую он обязан быть
   * безопасным.
   */
  leave(client: AppSocket): void {
    const room = client.data.chatRoom;
    if (!room) return;
    client.leave(room);
    client.data.chatRoom = undefined;
    client.data.chatName = undefined;
    // Системку о выходе не шлём: вход тоже не объявляем — ростер сам покажет уход.
    this.emitRoster(room);
  }

  /**
   * Канал удалили — распускаем его комнату. Каждому читателю говорим об этом
   * прямо (`chat-closed`), а не оставляем догадываться по новому реестру:
   * закрытые серверы делают реестр неполным, и клиент имеет право не считать
   * пропажу канала удалением. После выписки писать в канал уже нечем — каждый
   * обработчик ленты начинается с вопроса `roomOf`.
   */
  close(room: string, slug: string): void {
    const ids = this.server.sockets.adapter.rooms.get(room);
    if (!ids) return;
    for (const id of [...ids]) {
      const sock = this.server.sockets.sockets.get(id);
      if (!sock) continue;
      sock.leave(room);
      sock.data.chatRoom = undefined;
      sock.data.chatName = undefined;
      sock.emit('chat-closed', { slug });
    }
  }

  /**
   * Человек переименовался, и он читает ленту: подпись в ростере рисуется по
   * имени ТОГО сокета, что в комнате сидит. Возвращает комнату, чей ростер
   * из-за этого устарел, — или `undefined`, если ничего не изменилось.
   */
  rename(sock: AppSocket, name: string): string | undefined {
    const room = sock.data.chatRoom;
    if (!room || sock.data.chatName === name) return undefined;
    sock.data.chatName = name;
    return room;
  }

  /**
   * Состав текстового канала — рассылаем всем участникам.
   *
   * Список людей, а не сокетов: 1.0 разрешает одной личности войти с телефона и
   * с ноутбука разом, и без склейки по отпечатку она стояла бы в составе дважды
   * — двумя строками с одинаковым лицом и одинаковым именем. Гостей по инвайту
   * склеивать нечем и не нужно: у них нет ключа, и каждый сам по себе.
   */
  emitRoster(room: string): void {
    this.server.to(room).emit('chat-roster', this.roster(room));
  }

  private roster(room: string): RosterPerson[] {
    const ids = this.server.sockets.adapter.rooms.get(room) ?? new Set<string>();
    const people: RosterPerson[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const sock = this.server.sockets.sockets.get(id);
      const nick = sock?.data.chatName;
      if (!nick) continue;
      const fingerprint = sock ? this.around.fingerprintOf(sock) : undefined;
      if (fingerprint) {
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
      }
      people.push(fingerprint ? { nick, fingerprint } : { nick });
    }
    return people;
  }
}
