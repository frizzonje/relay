import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { MessageRow, PinRow } from '../db/entities';
// Значением, а не `import type` — по той же причине, что и в chat.service.ts:
// иначе `emitDecoratorMetadata` запишет в довод конструктора `Function`, и
// Nest не соберёт сервис.
import { ChatService } from './chat.service';
import { isUuid, messageQuery, toMessage } from './chat-rows';
import { PIN_LIMIT, type ChatMessage } from '@relay/shared';

/**
 * Закреплённые реплики канала.
 *
 * Отдельно от ленты, потому что и хранятся отдельно — своя таблица `pins` с
 * каскадом от реплики, — и меняются по своим причинам: потолок, порядок
 * списка, кто вправе. Пометка «закреплено» в самой ленте при этом остаётся у
 * ленты (связь `m.pins` в её запросах): она часть реплики, а не этого списка.
 *
 * Слаг в id канала переводит лента (`ChatService.channelIdOf`) — второе место,
 * где реестр и беседы сводятся в один ответ, разошлось бы с первым.
 */
@Injectable()
export class PinsService {
  constructor(
    private readonly db: DataSource,
    private readonly chat: ChatService,
  ) {}

  /**
   * Закрепить реплику. `ok` — закреплена (или уже была: повтор безвреден),
   * `limit` — в канале уже столько, сколько разрешено, `gone` — такой реплики
   * здесь нет. Потолок приходит доводом, а не берётся из константы: его задаёт
   * владелец (`messages.pinLimit`), и знать об этом хранилищу незачем.
   *
   * Системные строки не закрепляем: «история истекла» и «удалено владельцем» —
   * это следы событий, а закрепление обещает пережить ретенцию, то есть ровно
   * то событие, о котором такая строка и сообщает.
   */
  async pin(
    slug: string,
    id: string,
    by: string | null,
    limit: number = PIN_LIMIT,
  ): Promise<'ok' | 'limit' | 'gone'> {
    const channelId = this.chat.channelIdOf(slug);
    if (!channelId || !isUuid(id)) return 'gone';
    const exists = await this.db
      .getRepository(MessageRow)
      .findOne({ where: { id, channelId, system: false }, select: { id: true } });
    if (!exists) return 'gone';

    // Счёт и вставка одним запросом. Посчитай мы отдельно, между «в канале ещё
    // есть место» и самой вставкой помещалось бы чужое закрепление, и потолок
    // стал бы потолком, который иногда пропускает лишнее.
    const rows: { message_id: string }[] = await this.db.query(
      `INSERT INTO "pins" ("message_id", "channel_id", "pinned_by")
            SELECT $1, $2, $3
             WHERE (SELECT count(*) FROM "pins" WHERE "channel_id" = $2) < $4
       ON CONFLICT ("message_id") DO NOTHING
         RETURNING "message_id"`,
      [id, channelId, by, limit],
    );
    if (rows.length) return 'ok';

    // Строк ноль по одной из двух причин, и они разные: уже закреплено (тогда
    // человек получил, что хотел) или упёрлись в потолок (тогда ему есть что
    // с этим сделать).
    const already = await this.db.getRepository(PinRow).countBy({ messageId: id });
    return already ? 'ok' : 'limit';
  }

  /** Снять закрепление. `false` — его и не было. */
  async unpin(slug: string, id: string): Promise<boolean> {
    const channelId = this.chat.channelIdOf(slug);
    if (!channelId || !isUuid(id)) return false;
    const res = await this.db.getRepository(PinRow).delete({ messageId: id, channelId });
    return (res.affected ?? 0) > 0;
  }

  /** Сколько закреплено в канале — число для шапки. */
  async count(slug: string): Promise<number> {
    const channelId = this.chat.channelIdOf(slug);
    if (!channelId) return 0;
    return this.db.getRepository(PinRow).countBy({ channelId });
  }

  /**
   * Закреплённое канала целиком — страниц здесь нет и не нужно: их не больше
   * `PIN_LIMIT`. Порядок — от последнего закрепления к первому, а не по времени
   * самих реплик: закрепляют, чтобы не потерять, и последнее закреплённое почти
   * всегда и есть то, что ищут.
   */
  async list(slug: string, limit: number = PIN_LIMIT): Promise<ChatMessage[]> {
    const channelId = this.chat.channelIdOf(slug);
    if (!channelId) return [];
    const rows = await messageQuery(this.db)
      .where('m.channel_id = :channelId', { channelId })
      .andWhere('pin.message_id IS NOT NULL')
      .orderBy('pin.pinned_at', 'DESC')
      .addOrderBy('m.id', 'DESC')
      .limit(limit)
      .getMany();
    return rows.map(toMessage);
  }
}
