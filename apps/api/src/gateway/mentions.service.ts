import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { IdentityRow, MessageRow } from '../db/entities';
import { LIMIT } from './protocol';
import type { Person } from '@relay/shared';

/**
 * Упоминания в базе: кто стоит за отпечатком, кого предложить после `@` и
 * сколько раз человека назвали, пока его не было.
 *
 * Отдельно от ленты (`chat.service.ts`), потому что меняются они по разным
 * причинам: лента — про то, как реплики хранятся и листаются, упоминания — про
 * то, кого и как зовут. Сами упоминания при этом лежат в реплике (колонка
 * `mentions`), и пишет их лента; здесь — только чтение. Кому и что из этого
 * можно знать, решает гейтвейная половина (`mentions.ts`), а не этот файл.
 */

/** Сколько имён показываем в подсказке после `@`. Список читают глазами. */
export const MENTION_SUGGEST_LIMIT = 8;

/**
 * Кого из названных клиентом действительно назвали в этом тексте.
 *
 * Проверка ровно одна и она про видимость: упоминание обязано быть написано.
 * Клиент присылает отпечатки — то есть адресатов, — и без этой сверки любой
 * смог бы позвать человека, не написав его имени: беззвучный вызов, которого в
 * ленте не видно ни ему, ни остальным. Ищем подстроку `@ник`, а не слово по
 * границам: ники свободные, в них бывают и пробелы, и точки, и разбор «где тут
 * кончается имя» дал бы второе место с правилами и вечное расхождение с тем,
 * что человек выбрал в подсказке.
 *
 * Регистр не важен: написавший «@аня» позвал Аню и знает об этом.
 *
 * Сколько имён носит одна реплика, решает вызывающий: с этапа C это настройка
 * (`moderation.maxMentionsPerMessage`), а `LIMIT.mentions` — её умолчание.
 */
export function mentionedIn(
  text: string,
  people: Person[],
  limit: number = LIMIT.mentions,
): Person[] {
  const haystack = text.toLowerCase();
  const out: Person[] = [];
  const seen = new Set<string>();
  for (const person of people) {
    if (!person.nick || seen.has(person.fingerprint)) continue;
    if (!haystack.includes('@' + person.nick.toLowerCase())) continue;
    seen.add(person.fingerprint);
    out.push({ fingerprint: person.fingerprint, nick: person.nick });
    if (out.length >= limit) break;
  }
  return out;
}

@Injectable()
export class MentionsService {
  constructor(private readonly db: DataSource) {}

  /**
   * Личности по отпечаткам ключей — то, чем клиент называет упомянутых.
   *
   * Ник берётся отсюда, а не из тела сообщения: иначе рядом с чужим лицом можно
   * было бы написать любое имя, и снимок упоминания врал бы про того, кого
   * адресует.
   */
  async peopleByFingerprint(fingerprints: string[]): Promise<Person[]> {
    if (!fingerprints.length) return [];
    const rows = await this.db
      .getRepository(IdentityRow)
      .createQueryBuilder('i')
      .select(['i.fingerprint AS fingerprint', 'i.nick AS nick'])
      .where('i.fingerprint IN (:...fingerprints)', { fingerprints })
      .getRawMany<Person>();
    return rows;
  }

  /**
   * Кого предложить после набранного `@`: те, кто говорил в этих каналах, — от
   * недавних к давним.
   *
   * Список людей берётся из сказанного, а не из таблицы личностей целиком, и
   * это не оптимизация. Личности в relay не состоят в сервере (членства нет
   * вовсе — см. роли), поэтому «все, кто есть в инсталляции» означало бы
   * подсказку из посторонних, а заодно раздачу всякому вошедшему полного
   * списка людей. Кто здесь говорил — тот здесь и есть.
   */
  async candidates(channelIds: string[], prefix: string): Promise<Person[]> {
    if (!channelIds.length) return [];
    // ILIKE — искать по началу имени, не различая регистр. Спецсимволы шаблона
    // экранируем: `%` в набранном человеком префиксе иначе означал бы «любой
    // хвост», то есть подсказку из всех подряд.
    const pattern = prefix.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    return this.db
      .getRepository(MessageRow)
      .createQueryBuilder('m')
      .innerJoin(IdentityRow, 'i', 'i.id = m.author_identity_id')
      .select(['i.fingerprint AS fingerprint', 'i.nick AS nick'])
      .where('m.channel_id IN (:...channelIds)', { channelIds })
      .andWhere('i.nick ILIKE :pattern', { pattern })
      .groupBy('i.fingerprint')
      .addGroupBy('i.nick')
      .orderBy('MAX(m.created_at)', 'DESC')
      .limit(MENTION_SUGGEST_LIMIT)
      .getRawMany<Person>();
  }

  /**
   * Непрочитанные упоминания: id канала → сколько раз человека там назвали
   * после того, как он этот канал дочитал.
   *
   * Своё не считается. Написать собственное имя не значит позвать себя, а
   * счётчик, который человек зажигает себе сам, — это ошибка, о которой он
   * подумает на тебя.
   */
  async unreadCounts(identityId: string, fingerprint: string): Promise<Map<string, number>> {
    if (!identityId || !fingerprint) return new Map();
    const rows: { channel_id: string; n: string }[] = await this.db.query(
      `SELECT m."channel_id" AS channel_id, count(*) AS n
         FROM "messages" m
         LEFT JOIN "reads" r ON r."channel_id" = m."channel_id" AND r."identity_id" = $1
        WHERE m."mentions" @> $2::jsonb
          AND m."author_identity_id" IS DISTINCT FROM $1
          AND (r."read_at" IS NULL OR m."created_at" > r."read_at")
        GROUP BY m."channel_id"`,
      [identityId, JSON.stringify([{ fingerprint }])],
    );
    return new Map(rows.map((row) => [row.channel_id, Number(row.n)]));
  }
}
