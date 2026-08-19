import type { AppServer, AppSocket } from './socket-data';
import type { ChatService } from './chat.service';
import type { Perimeter } from './perimeter';
import type { RegistryService } from './registry.service';
import { mentionedIn } from './chat.service';
import { LIMIT, trimmed, type MentionRef } from './protocol';

/**
 * Упоминания: кого назвали, кому об этом сказать и сколько раз назвали, пока
 * человека не было.
 *
 * Три действия вокруг одного вопроса, и живут они вместе потому, что вместе же
 * и ломаются. Общего у них ровно одно правило: **упоминание не должно
 * рассказывать о канале больше, чем человеку видно**. Слаг канала закрытого
 * сервера сам по себе часть секрета — по нему заходят, — поэтому и вызов, и
 * счётчик режутся по видимости, а не по факту, что имя написано.
 */
export class Mentions {
  constructor(
    private readonly registry: RegistryService,
    private readonly chat: ChatService,
    private readonly perimeter: Perimeter,
    private readonly serverOf: () => AppServer,
  ) {}

  /**
   * Кого назвали в этом тексте: клиент присылает отпечатки выбранных им людей,
   * сервер оставляет тех, чьё имя в тексте и правда написано.
   *
   * Ник в снимок берётся из базы, а не из тела сообщения: иначе рядом с чужим
   * лицом можно было бы написать любое имя.
   */
  async resolve(text: string, claimed: unknown): Promise<MentionRef[]> {
    if (!text || !Array.isArray(claimed) || !claimed.length) return [];
    const fingerprints = [
      ...new Set(
        claimed
          .slice(0, LIMIT.mentions)
          .map((value) => trimmed(value, LIMIT.fingerprint))
          .filter(Boolean),
      ),
    ];
    if (!fingerprints.length) return [];
    return mentionedIn(text, await this.chat.peopleByFingerprint(fingerprints));
  }

  /**
   * Сказать названным, что их назвали. Летит на все устройства человека — тем
   * же порядком, что и отметки чтения: канал, в котором тебя позвали, обязан
   * загореться и на телефоне.
   *
   * Себе не звоним (написать собственное имя — не вызов), гостю по инвайту
   * тоже: у него нет личности, а значит и счётчика, который это зажигает.
   * Тому, кому канал не виден, — тем более: событие несёт слаг.
   */
  ping(from: AppSocket, mentions: MentionRef[], slug: string, ts: number): void {
    if (!mentions.length) return;
    const channel = this.registry.channels.find((c) => c.type === 'text' && c.slug === slug);
    if (!channel) return;
    const author = this.perimeter.speaker(from)?.fingerprint;
    const targets = new Set(mentions.map((m) => m.fingerprint));
    for (const sock of this.serverOf().sockets.sockets.values()) {
      const who = this.perimeter.speaker(sock)?.fingerprint;
      if (!who || who === author || !targets.has(who)) continue;
      if (this.perimeter.isGuest(sock) || !this.perimeter.canSee(sock, channel)) continue;
      sock.emit('mention', { slug, ts });
    }
  }

  /**
   * Снимок непрочитанных упоминаний по каналам. Считается в базе, а не
   * копится в памяти: счётчик обязан пережить и рестарт api, и смену
   * устройства, — иначе «тебя звали» существовало бы ровно до перезагрузки
   * страницы.
   */
  async sendSnapshot(client: AppSocket): Promise<void> {
    const me = this.perimeter.speaker(client);
    if (!me) return;
    const counts = await this.chat.mentionCounts(me.id, me.fingerprint);
    const bySlug: Record<string, number> = {};
    for (const channel of this.registry.channels) {
      const n = counts.get(channel.id);
      if (n && this.perimeter.canSee(client, channel)) bySlug[channel.slug] = n;
    }
    client.emit('mentions', { counts: bySlug });
  }
}
