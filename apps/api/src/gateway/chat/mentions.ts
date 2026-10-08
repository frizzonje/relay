import type { AppServer, AppSocket } from '../socket-data';
import type { MentionsService } from './mentions.service';
import type { DmService } from '../dm/dm.service';
import type { Perimeter } from '../perimeter';
import type { RegistryService } from '../registry/registry.service';
import type { SettingsService } from '../../settings/settings.service';
import { MENTION_SUGGEST_LIMIT, mentionedIn } from './mentions.service';
import { LIMIT, trimmed } from '../protocol';
import type { MentionSuggestResult, Person } from '@relay/shared';

/**
 * Упоминания: кого предложить после `@`, кого назвали, кому об этом сказать и
 * сколько раз назвали, пока человека не было.
 *
 * Четыре действия вокруг одного вопроса, и живут они вместе потому, что вместе же
 * и ломаются. Общего у них ровно одно правило: **упоминание не должно
 * рассказывать о канале больше, чем человеку видно**. Слаг канала закрытого
 * сервера сам по себе часть секрета — по нему заходят, — поэтому и вызов, и
 * счётчик режутся по видимости, а не по факту, что имя написано.
 */
export class Mentions {
  constructor(
    private readonly registry: RegistryService,
    private readonly store: MentionsService,
    private readonly perimeter: Perimeter,
    private readonly dm: DmService,
    private readonly settings: SettingsService,
    private readonly serverOf: () => AppServer,
  ) {}

  /**
   * Сколько имён носит одна реплика. Спрашивается в момент разбора: число
   * задаёт владелец, и снятая на старте копия действовала бы до перезапуска.
   *
   * Читают его двое — этот разбор и `mentionedIn` в хранилище, — и оба обязаны
   * читать одно и то же. Разойдись они, клиент прислал бы десять отпечатков,
   * разбор оставил бы десять, а в снимок реплики попало бы восемь: двое
   * названных не узнали бы, что их звали, и найти это было бы негде.
   */
  private cap(): number {
    return this.settings.get<number>('moderation.maxMentionsPerMessage');
  }

  /**
   * Кого предложить после набранного `@` в этом канале.
   *
   * Список собирает сервер, и в него попадают только те, кому этот канал виден:
   * подсказать человека, который не может прочитать канал, значит предложить
   * позвать его в комнату за запертой дверью. Себя в подсказке нет — позвать
   * себя нельзя, и место в списке из восьми имён этим не тратится.
   */
  async suggest(
    client: AppSocket,
    slug: string,
    prefixRaw: unknown,
  ): Promise<MentionSuggestResult['people']> {
    const here = this.registry.channels.find((c) => c.type === 'text' && c.slug === slug);
    if (!here || !this.perimeter.canSee(client, here)) return [];

    const prefix = trimmed(prefixRaw, LIMIT.tag).toLowerCase();
    const me = this.perimeter.speaker(client)?.fingerprint;
    const seen = new Set<string>();
    const people: MentionSuggestResult['people'] = [];

    // Сначала те, кто сейчас на связи: для них упоминание — не запись в
    // историю, а обращение, которое они увидят сию минуту.
    for (const sock of this.serverOf().sockets.sockets.values()) {
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
    const spoke = await this.store.candidates(
      channels.map((c) => c.id),
      prefix,
    );
    for (const person of spoke) {
      if (person.fingerprint === me || seen.has(person.fingerprint)) continue;
      seen.add(person.fingerprint);
      people.push({ ...person, online: false });
    }

    return people.slice(0, MENTION_SUGGEST_LIMIT);
  }

  /**
   * Кого назвали в этом тексте: клиент присылает отпечатки выбранных им людей,
   * сервер оставляет тех, чьё имя в тексте и правда написано.
   *
   * Ник в снимок берётся из базы, а не из тела сообщения: иначе рядом с чужим
   * лицом можно было бы написать любое имя.
   */
  async resolve(text: string, claimed: unknown): Promise<Person[]> {
    if (!text || !Array.isArray(claimed) || !claimed.length) return [];
    const cap = this.cap();
    if (cap <= 0) return [];
    const fingerprints = [
      ...new Set(
        claimed
          .slice(0, cap)
          .map((value) => trimmed(value, LIMIT.fingerprint))
          .filter(Boolean),
      ),
    ];
    if (!fingerprints.length) return [];
    return mentionedIn(text, await this.store.peopleByFingerprint(fingerprints), cap);
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
  ping(from: AppSocket, mentions: Person[], slug: string, ts: number): void {
    if (!mentions.length) return;
    // В переписке двоих упоминание не адресует: адресат и так один, и счётчик
    // «тебя звали» дублировал бы непрочитанное.
    if (this.dm.isDm(slug)) return;
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
    const counts = await this.store.unreadCounts(me.id, me.fingerprint);
    const bySlug: Record<string, number> = {};
    for (const channel of this.registry.channels) {
      const n = counts.get(channel.id);
      if (n && this.perimeter.canSee(client, channel)) bySlug[channel.slug] = n;
    }
    client.emit('mentions', { counts: bySlug });
  }
}
