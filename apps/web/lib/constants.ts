import type { Channel, Server } from '@relay/shared';

/**
 * Статические данные shell-а: сиды реестра серверов/каналов.
 * ДОЛЖНЫ совпадать с дефолтами в signaling.gateway.ts.
 */


/**
 * Главный сервер relay — неудаляем; его id носят каналы по умолчанию.
 * ДОЛЖЕН совпадать с MAIN_SERVER_ID в gateway.
 */
export const MAIN_SERVER_ID = 'relay-main';

/**
 * Сид реестра серверов — только главный, до прихода списка с сервера. ДОЛЖЕН
 * совпадать с DEFAULT_SERVERS в apps/api/src/gateway/signaling.gateway.ts.
 */
export const DEFAULT_SERVERS: Server[] = [{ id: MAIN_SERVER_ID, name: 'relay', removable: false }];

/**
 * Сид реестра каналов — им наполняем стор до прихода реального списка с сервера
 * (и он же виден, если API недоступен). ДОЛЖЕН совпадать с DEFAULT_CHANNELS в
 * apps/api/src/gateway/signaling.gateway.ts (тот же id/slug/serverId/removable).
 *
 * Набор главного сервера фиксирован: два голосовых канала (напрямую и через
 * медиасервер) и один текстовый. Создавать, удалять и переименовывать каналы
 * здесь нельзя — свои заводят в собственных серверах.
 */
export const DEFAULT_CHANNELS: Channel[] = [
  {
    id: 'text-obshchii',
    serverId: MAIN_SERVER_ID,
    type: 'text',
    name: 'общий',
    slug: 'obshchii',
    removable: false,
  },
  {
    id: 'voice-obshchii',
    serverId: MAIN_SERVER_ID,
    type: 'voice',
    name: 'P2P общий',
    slug: 'voice-obshchii',
    removable: false,
  },
  {
    id: 'voice-obshchii-sfu',
    serverId: MAIN_SERVER_ID,
    type: 'voice',
    name: 'SFU общий',
    slug: 'voice-obshchii-sfu',
    removable: false,
    mode: 'sfu',
  },
];
