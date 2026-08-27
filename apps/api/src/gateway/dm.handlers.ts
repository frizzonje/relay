import type { AppSocket } from './socket-data';
import type { ChatSessions } from './chat-sessions';
import type { ChatService } from './chat.service';
import { DM_PEOPLE_LIMIT, type DmService } from './dm.service';
import type { Perimeter } from './perimeter';
import {
  LIMIT,
  str,
  trimmed,
  type DmJoinPayload,
  type DmJoinResult,
  type DmListResult,
  type DmOpenPayload,
  type DmOpenResult,
  type DmPeoplePayload,
  type DmPeopleResult,
} from './protocol';

/**
 * Дверь в личную переписку.
 *
 * Обработчиков реплик здесь нет и не будет: сев в комнату беседы, сокет пишет
 * теми же `chat-message` / `chat-edit` / `chat-react`, что и в канале, — лента
 * у них одна на двоих (см. `chat.service`). Здесь ровно то, чем беседа от
 * канала отличается: **как в неё попасть**.
 *
 * Отличие в одном вопросе. Канал пускает по видимости в реестре: он существует
 * для всех, кому виден. Беседа не видна никому, кроме двоих, и вопрос к ней
 * другой — «ты одна из сторон?». Спутать эти два вопроса значило бы либо отдать
 * чужую переписку тому, кто угадал адрес, либо не пустить в свою собственную.
 */
export class DmHandlers {
  constructor(
    private readonly dm: DmService,
    private readonly chat: ChatService,
    private readonly chats: ChatSessions,
    private readonly perimeter: Perimeter,
  ) {}

  /**
   * Кто вправе пользоваться ЛС. Полноценная личность, и только она: у гостя по
   * инвайту личность живёт внутри одного приглашения, адресовать её потом
   * некому и незачем.
   */
  private me(client: AppSocket): string | undefined {
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return undefined;
    return this.perimeter.speaker(client)?.id;
  }

  async open(client: AppSocket, payload: DmOpenPayload): Promise<DmOpenResult> {
    const meId = this.me(client);
    if (!meId) return { ok: false, error: 'forbidden' };
    const fingerprint = trimmed(payload?.fingerprint, LIMIT.dmQuery);
    if (!fingerprint) return { ok: false, error: 'unknown' };

    const res = await this.dm.open(meId, fingerprint);
    if (!res.ok) return { ok: false, error: res.reason };
    return { ok: true, conversation: res.view };
  }

  async list(client: AppSocket): Promise<DmListResult> {
    const meId = this.me(client);
    if (!meId) return { ok: false, error: 'forbidden' };
    return { ok: true, conversations: await this.dm.list(meId) };
  }

  /**
   * Сесть в ленту беседы. Из прежней ленты выходим только после проверки: не
   * пустивший вход не должен выкидывать человека оттуда, где он уже сидел, —
   * ровно как в `chat-join`.
   */
  async join(client: AppSocket, payload: DmJoinPayload): Promise<DmJoinResult> {
    const meId = this.me(client);
    if (!meId) return { ok: false, error: 'forbidden' };
    const slug = str(payload?.slug);
    if (!slug || !this.dm.isDm(slug)) return { ok: false, error: 'unknown' };
    if (!this.dm.isMember(slug, meId)) return { ok: false, error: 'forbidden' };

    this.chats.leave(client);
    const room = this.chat.room(slug);
    this.chats.enter(client, room, this.perimeter.nameFor(client, undefined));

    // Ленту отдаём тем же событием, что и каналу: клиент отличает беседу от
    // канала по адресу, а не по форме страницы. Закреплений в ЛС нет (см.
    // задачу 7), поэтому их счётчик всегда ноль.
    const page = await this.chat.history(slug);
    client.emit('chat-history', { slug, ...page, pins: 0 });
    this.chats.emitRoster(room);
    return { ok: true };
  }

  async people(client: AppSocket, payload: DmPeoplePayload): Promise<DmPeopleResult> {
    const meId = this.me(client);
    if (!meId) return { ok: false, error: 'forbidden' };
    const query = trimmed(payload?.query, LIMIT.dmQuery);
    return { ok: true, people: await this.dm.people(meId, query, DM_PEOPLE_LIMIT) };
  }
}
