/**
 * Все настройки инсталляции — одним списком.
 *
 * Списком, а не набором полей на экране, ровно по одной причине: параметров
 * почти сотня, и у каждого есть тип, границы и вопрос «когда подействует».
 * Разметить это руками в интерфейсе значит завести сотню мест, где проверка
 * значения и само значение разъедутся, — причём разъедутся молча, потому что
 * ошибётся здесь не программа, а человек, дописавший сто первое поле.
 *
 * Поэтому каталог — контракт. Сервер по нему проверяет запись, панель по нему
 * же рисует контролы и подписи, журнал берёт из него имя параметра, а
 * импорт-экспорт — список того, что вообще бывает. Добавить параметр — значит
 * добавить сюда строку; больше нигде ничего дописывать не нужно.
 *
 * Умолчание каждого параметра равно тому, как relay вёл себя до появления
 * панели. Инсталляция, где владелец не открывал её ни разу, обязана работать
 * ровно как прежде, и это проверяется тестом, а не обещанием: числа в
 * `fallback` сверены с константами кода (NICK_MAX, LIMITS.chatText,
 * MAX_UPLOAD_BYTES и прочими), а не переписаны из плана на глаз.
 *
 * Проверка (`validateSetting`) — чистая функция: ни базы, ни `process.env`, ни
 * времени. Её зовут и сервер перед записью, и браузер перед отправкой, и тест;
 * загляни она хоть раз в окружение — три ответа разъехались бы на четвёртый.
 */

export * from './spec';

import { normalizeAddressPrefix } from '../net';
import { LIST_ITEM_MAX } from './limits';
import type { SettingSpec, SettingValue } from './spec';
import { ACCESS_SETTINGS } from './catalog/access';
import { PEOPLE_SETTINGS } from './catalog/people';
import { MODERATION_SETTINGS } from './catalog/moderation';
import { MESSAGES_SETTINGS } from './catalog/messages';
import { FILES_SETTINGS } from './catalog/files';
import { DIRECT_SETTINGS } from './catalog/direct';
import { SPACES_SETTINGS } from './catalog/spaces';
import { VOICE_SETTINGS } from './catalog/voice';
import { CALLS_SETTINGS } from './catalog/calls';
import { INVITES_SETTINGS } from './catalog/invites';
import { APPEARANCE_SETTINGS } from './catalog/appearance';
import { NOTIFICATIONS_SETTINGS } from './catalog/notifications';
import { MAINTENANCE_SETTINGS } from './catalog/maintenance';

/** Весь каталог — группы в порядке `SETTING_GROUPS`. */
export const SETTINGS: readonly SettingSpec[] = [
  ...ACCESS_SETTINGS,
  ...PEOPLE_SETTINGS,
  ...MODERATION_SETTINGS,
  ...MESSAGES_SETTINGS,
  ...FILES_SETTINGS,
  ...DIRECT_SETTINGS,
  ...SPACES_SETTINGS,
  ...VOICE_SETTINGS,
  ...CALLS_SETTINGS,
  ...INVITES_SETTINGS,
  ...APPEARANCE_SETTINGS,
  ...NOTIFICATIONS_SETTINGS,
  ...MAINTENANCE_SETTINGS,
];

const BY_KEY = new Map<string, SettingSpec>(SETTINGS.map((spec) => [spec.key, spec]));

/** Описание параметра или `undefined`, если такого в каталоге нет. */
export function settingSpec(key: string): SettingSpec | undefined {
  return BY_KEY.get(key);
}

/**
 * Снимок умолчаний. Каждый раз новый и со свежими копиями списков: снимок
 * уезжает в хранилище и в панель, и общий на всех массив кто-нибудь однажды
 * поправит на месте — а поправит он при этом сам каталог.
 */
export function defaults(): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  for (const spec of SETTINGS) {
    out[spec.key] = Array.isArray(spec.fallback) ? [...spec.fallback] : spec.fallback;
  }
  return out;
}

export type SettingError =
  | 'unknown-key'
  | 'read-only'
  | 'wrong-type'
  | 'out-of-range'
  | 'not-an-option'
  | 'too-long'
  /** Пункт списка не той формы: строка, которая адресом с маской не является. */
  | 'bad-item';

export type SettingCheck = { ok: true; value: SettingValue } | { ok: false; error: SettingError };

/** Число знаков, а не ячеек utf-16: эмодзи — один знак, а не два. */
function chars(text: string): number {
  return [...text].length;
}

/**
 * Проверка значения по каталогу: `ok` либо причина отказа.
 *
 * Причина возвращается разная не ради красоты сообщения: «не то» и «слишком
 * длинное» человек чинит по-разному, а «только чтение» не чинится вовсе, и
 * панели надо сказать об этом сразу, а не после сохранения.
 */
export function validateSetting(key: string, value: unknown): SettingCheck {
  const spec = settingSpec(key);
  if (!spec) return { ok: false, error: 'unknown-key' };
  // Инфраструктурное живёт в окружении. Отказ здесь, а не на экране: экран
  // легко забыть выключить, а мимо каталога запись не проходит.
  if (spec.readOnly) return { ok: false, error: 'read-only' };

  switch (spec.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false, error: 'wrong-type' };

    case 'number':
    case 'bytes': {
      // Целое и конечное. `Number.isInteger` отсеивает и NaN, и бесконечность,
      // и «30» строкой — то есть ровно то, что приезжает из формы без разбора.
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return { ok: false, error: 'wrong-type' };
      }
      if (spec.min !== undefined && value < spec.min) return { ok: false, error: 'out-of-range' };
      if (spec.max !== undefined && value > spec.max) return { ok: false, error: 'out-of-range' };
      return { ok: true, value };
    }

    case 'select': {
      if (typeof value !== 'string') return { ok: false, error: 'wrong-type' };
      return spec.options?.includes(value)
        ? { ok: true, value }
        : { ok: false, error: 'not-an-option' };
    }

    case 'text':
    case 'multiline':
    case 'secret': {
      if (typeof value !== 'string') return { ok: false, error: 'wrong-type' };
      if (spec.max !== undefined && chars(value) > spec.max)
        return { ok: false, error: 'too-long' };
      return { ok: true, value };
    }

    case 'list': {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        return { ok: false, error: 'wrong-type' };
      }
      const items = value as string[];
      if (spec.max !== undefined && items.length > spec.max)
        return { ok: false, error: 'too-long' };
      if (items.some((item) => chars(item) > LIST_ITEM_MAX))
        return { ok: false, error: 'too-long' };
      if (spec.options && items.some((item) => !spec.options?.includes(item))) {
        return { ok: false, error: 'not-an-option' };
      }
      // Адреса и маски приводятся к канонической записи прямо здесь, а не при
      // сравнении: в таблицу и на экран уезжает то, ЧТО СЕРВЕР ПОНЯЛ. Голый
      // IPv6 при этом разворачивается в /64 и виден развёрнутым — иначе
      // настройка выглядела бы одним, а действовала бы другим.
      if (spec.items === 'cidr') {
        const prefixes: string[] = [];
        for (const item of items) {
          const prefix = normalizeAddressPrefix(item);
          if (!prefix) return { ok: false, error: 'bad-item' };
          prefixes.push(prefix);
        }
        return { ok: true, value: prefixes };
      }
      // Копия: список уезжает в хранилище, а пришедший массив принадлежит
      // вызывающему и может измениться у него под руками.
      return { ok: true, value: [...items] };
    }
  }
}

/**
 * Снимок настроек, каким его видит браузер. Ключи — из каталога
 * (`settings/catalog`), значения уже обезврежены: у секрета
 * вместо строки признак «задано».
 */
export type SettingsSnapshot = Record<string, SettingValue>;
