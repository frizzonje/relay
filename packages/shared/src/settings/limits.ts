/** Единицы и потолки ввода, общие для групп каталога и проверки. */

import type { AttachmentKind } from '../attachments';

// Байты пишем степенями двойки и словами: «26214400» в столбце умолчаний не
// читается никем, а ошибку в нуле не видно даже при вычитке.
export const KIB = 1024;
export const MIB = 1024 * KIB;
export const GIB = 1024 * MIB;
export const TIB = 1024 * GIB;

/**
 * Потолки ввода для текста. Это защита от мегабайта в поле, а не политика:
 * решение «сколько уместно» принимает владелец, а каталог лишь не даёт
 * положить в таблицу то, что потом не покажет ни один экран.
 */
export const NOTICE_MAX = 2000;
export const RULES_MAX = 8000;
export const SECRET_MAX = 256;
export const URL_MAX = 500;
/**
 * Виды вложений, какие существуют. Импорт типа (стирается при сборке, цикла с
 * `index.ts` не заводит) плюс `satisfies` — единственный способ не дать этому
 * списку разойтись с тем, что раскладывает по видам сервер.
 */
export const ATTACHMENT_KINDS = [
  'image',
  'audio',
  'file',
] as const satisfies readonly AttachmentKind[];

/** Столько слов помещается в фильтр и столько букв — в одно слово. */
export const LIST_MAX = 500;
export const LIST_ITEM_MAX = 100;

/**
 * Текст про приватность бесед — тот же, что этап A показывает в шапке ЛС
 * (ключ `dm.privacy`, apps/web/lib/i18n/messages/en.json). Владелец волен его
 * переписать, но умолчание обязано совпадать с тем, что человек видит сегодня:
 * обещание приватности, разъехавшееся с интерфейсом, хуже отсутствующего.
 */
export const DM_PRIVACY_NOTICE =
  "Direct messages are addressed to one person, but they aren't hidden from the installation's owner.";
