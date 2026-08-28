import type { AppSocket } from './socket-data';
import type { ChatSessions } from './chat-sessions';
import type { ChatService } from './chat.service';
import { DM_PEOPLE_LIMIT, type DmService } from './dm.service';
import type { Perimeter } from './perimeter';
import type { SettingsService } from '../settings/settings.service';
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
  /**
   * Кому и когда открывали новые беседы. Счёт «писем незнакомцу» ведётся здесь,
   * в памяти процесса, — ровно как счёт неудачных паролей и пауза выгнанному
   * гостю: рестарт api прощает всех, и это честно. В базе этому места нет:
   * строка «в котором часу он открыл беседу» переживала бы саму беседу и
   * рассказывала бы о человеке больше, чем сама переписка.
   */
  private readonly started = new Map<string, number[]>();

  constructor(
    private readonly dm: DmService,
    private readonly chat: ChatService,
    private readonly chats: ChatSessions,
    private readonly perimeter: Perimeter,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Кто вправе пользоваться ЛС. Полноценная личность, и только она: у гостя по
   * инвайту личность живёт внутри одного приглашения, адресовать её потом
   * некому и незачем.
   *
   * Выключенные ЛС отвечают здесь же и всем четырём событиям сразу: выключить
   * их наполовину — оставить список переписок без двери в них — значит показать
   * человеку то, чего он больше не может открыть.
   */
  private me(client: AppSocket): string | undefined {
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return undefined;
    if (!this.settings.get<boolean>('direct.enabled')) return undefined;
    return this.perimeter.speaker(client)?.id;
  }

  /**
   * Вправе ли этот человек завести НОВУЮ беседу с тем, кто ему не отвечал.
   * Спрашивается только на заведении: правило про «писать первым» не должно
   * обрывать разговор, который уже идёт.
   */
  private async mayStart(meId: string, peerId: string): Promise<boolean> {
    const who = this.settings.get<string>('direct.whoCanStart');
    if (who === 'nobody') return false;
    if (who === 'seen-together' && !(await this.dm.seenTogether(meId, peerId))) return false;
    return this.withinFirstMessageQuota(meId);
  }

  /**
   * Не слишком ли много незнакомцев за последний час. Окно скользящее, а не
   * «час с полуночи»: разослав сотню приглашений в 12:59, к 13:01 можно было бы
   * разослать вторую.
   */
  private withinFirstMessageQuota(meId: string): boolean {
    const perHour = this.settings.get<number>('direct.firstMessagesPerHour');
    // Ноль — без предела (см. каталог): «совсем нельзя» говорит `whoCanStart`.
    if (perHour <= 0) return true;
    const since = Date.now() - 60 * 60_000;
    const mine = (this.started.get(meId) ?? []).filter((ts) => ts > since);
    // Подчищаем на месте: карта живёт всю жизнь процесса, а заводить таймер
    // ради десятка записей незачем (см. паузу выгнанному гостю в периметре).
    if (mine.length) this.started.set(meId, mine);
    else this.started.delete(meId);
    return mine.length < perHour;
  }

  async open(client: AppSocket, payload: DmOpenPayload): Promise<DmOpenResult> {
    const meId = this.me(client);
    if (!meId) return { ok: false, error: 'forbidden' };
    const fingerprint = trimmed(payload?.fingerprint, LIMIT.dmQuery);
    if (!fingerprint) return { ok: false, error: 'unknown' };

    const res = await this.dm.open(meId, fingerprint, {
      blockBanned: this.settings.get<boolean>('direct.blockFromBanned'),
      previewLimit: this.settings.get<number>('messages.replyPreviewLength'),
      mayStart: (peerId) => this.mayStart(meId, peerId),
    });
    // «Нельзя писать первым» — это отказ в праве, а не «такого человека нет»:
    // спрашивавший видит собеседника в списке и обязан понять, почему беседа не
    // открылась.
    if (!res.ok)
      return { ok: false, error: res.reason === 'not-allowed' ? 'forbidden' : res.reason };
    // Счётчик пополняется по факту заведения, а не по попытке: неудачная
    // (незнакомый отпечаток, свой собственный) не должна тратить час.
    if (res.created) this.started.set(meId, [...(this.started.get(meId) ?? []), Date.now()]);
    return { ok: true, conversation: res.view };
  }

  async list(client: AppSocket): Promise<DmListResult> {
    const meId = this.me(client);
    if (!meId) return { ok: false, error: 'forbidden' };
    const previewLimit = this.settings.get<number>('messages.replyPreviewLength');
    return { ok: true, conversations: await this.dm.list(meId, previewLimit) };
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
