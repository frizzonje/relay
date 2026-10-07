/** Каталог настроек, группа `direct` — личные сообщения. */

import { NOTICE_MAX, DM_PRIVACY_NOTICE } from '../limits';
import type { SettingSpec } from '../spec';

export const DIRECT_SETTINGS: readonly SettingSpec[] = [
  { key: 'direct.enabled', group: 'direct', kind: 'boolean', fallback: true, applies: 'now' },
  {
    key: 'direct.whoCanStart',
    group: 'direct',
    kind: 'select',
    fallback: 'everyone',
    applies: 'now',
    options: ['everyone', 'seen-together', 'nobody'],
  },
  // Ноль — без предела, как у квот на файлы: сегодня первых реплик никто не
  // считает, и умолчание обязано значить ровно это, а не «сотня в час». Счёт
  // идёт только по первым репликам незнакомцу — разговор с ответившим не
  // ограничен ничем. «Совсем нельзя писать первым» — это не ноль здесь, а
  // `direct.whoCanStart: nobody`; двух способов сказать одно и то же не нужно.
  {
    key: 'direct.firstMessagesPerHour',
    group: 'direct',
    kind: 'number',
    fallback: 0,
    applies: 'now',
    min: 0,
    max: 100,
  },
  {
    key: 'direct.attachmentsAllowed',
    group: 'direct',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  // «Как у каналов» — это сегодняшнее поведение слово в слово: ретенция ходит
  // по всей таблице реплик и о том, что часть из них лежит в беседах, не знает.
  // Отдельный срок у переписки появляется ровно тогда, когда владелец его
  // выберет, — и `direct.retentionDays` до этого момента ни на что не влияет.
  {
    key: 'direct.retentionMode',
    group: 'direct',
    kind: 'select',
    fallback: 'inherit',
    applies: 'now',
    options: ['inherit', 'days', 'forever', 'ephemeral'],
  },
  {
    key: 'direct.retentionDays',
    group: 'direct',
    kind: 'number',
    fallback: 14,
    applies: 'now',
    min: 1,
    max: 3650,
  },
  {
    key: 'direct.privacyNotice',
    group: 'direct',
    kind: 'multiline',
    fallback: DM_PRIVACY_NOTICE,
    applies: 'now',
    max: NOTICE_MAX,
    client: true,
  },
  {
    key: 'direct.blockFromBanned',
    group: 'direct',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
];
