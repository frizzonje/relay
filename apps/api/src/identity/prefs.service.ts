import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PrefRow } from '../db/entities';

/**
 * Настройки, которые принадлежат человеку, а не устройству.
 *
 * Список ключей закрыт, и это единственная настоящая проверка здесь. Всё
 * остальное — размер. Причина простая: настройки человек читает только сам, и
 * защищать его от собственной кривой громкости не от кого. А вот таблица, куда
 * любой обладатель ключа пишет что угодно под каким угодно именем, — это уже не
 * настройки, а бесплатный диск, и такой в relay был бы ровно один раз, до
 * первого желающего.
 *
 * Что означают сами значения, сервер не знает и знать не должен: `sound` — это
 * список каналов со звуком, `volume` — громкости собеседников, и разбирать их
 * форму значило бы держать копию клиентской семантики в базе. Меняется
 * клиентский формат — сервер об этом не узнаёт и не должен.
 */

/** Что человеку разрешено про себя помнить. Всё прочее — отказ. */
export const PREF_KEYS = ['sound', 'volume'] as const;
export type PrefKey = (typeof PREF_KEYS)[number];

/** Потолок одной настройки в сериализованном виде. */
export const PREF_MAX_BYTES = 8 * 1024;

@Injectable()
export class PrefsService {
  constructor(private readonly db: DataSource) {}

  /** Все настройки человека одним снимком — то, что уезжает на подключении. */
  async values(identityId: string): Promise<Record<string, unknown>> {
    const rows = await this.db.getRepository(PrefRow).findBy({ identityId });
    const out: Record<string, unknown> = {};
    for (const row of rows) out[row.key] = row.value;
    return out;
  }

  /**
   * Запомнить настройку. `false` — не наш ключ или значение не влезло; в обоих
   * случаях в базе не меняется ничего.
   *
   * Внутри одного ключа выигрывает последний записавший. Слить две версии
   * «списка каналов со звуком» нельзя ничем, кроме выбора одной из них, и
   * притворяться, что можно, — худший из вариантов: человек получил бы звук
   * там, где его выключал.
   */
  async set(identityId: string, key: unknown, value: unknown): Promise<boolean> {
    if (!identityId || !isPrefKey(key)) return false;
    if (value === undefined || value === null) return false;
    let json: string;
    try {
      json = JSON.stringify(value);
    } catch {
      return false; // циклическая ссылка и прочее, чего в JSON не бывает
    }
    if (!json || Buffer.byteLength(json) > PREF_MAX_BYTES) return false;

    await this.db
      .getRepository(PrefRow)
      .createQueryBuilder()
      .insert()
      .values({ identityId, key, value, updatedAt: new Date() })
      .orUpdate(['value', 'updated_at'], ['identity_id', 'key'])
      .execute();
    return true;
  }
}

function isPrefKey(key: unknown): key is PrefKey {
  return typeof key === 'string' && (PREF_KEYS as readonly string[]).includes(key);
}
