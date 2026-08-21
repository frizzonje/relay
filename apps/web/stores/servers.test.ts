import { beforeEach, describe, expect, it } from 'vitest';
import type { Server } from '@relay/shared';
import { MAIN_SERVER_ID } from '@/lib/constants';
import { isServerUnlocked, useServersStore } from './servers';

/**
 * Реестр серверов на клиенте — и главное в нём: кто решает, заперт сервер или
 * открыт. Решает сервер, а не память вкладки. Разница видна ровно там, где её
 * и заметили: после перезагрузки страницы память пуста, а пропуск в handshake
 * жив — и замок обязан не вернуться.
 */

const main: Server = { id: MAIN_SERVER_ID, name: 'relay', removable: false };
const locked = (extra: Partial<Server> = {}): Server => ({
  id: 'srv',
  name: 'тайный',
  removable: true,
  locked: true,
  ...extra,
});

beforeEach(() => {
  useServersStore.setState({
    servers: [main],
    activeServerId: MAIN_SERVER_ID,
    unlockedIds: [],
    unlockTargetId: null,
    unlockError: null,
  });
});

describe('разблокировки', () => {
  it('берутся из присланного реестра: пропуск открыл сервер — замка нет', () => {
    useServersStore.getState().setServers([main, locked({ unlocked: true })]);
    const { servers, unlockedIds } = useServersStore.getState();
    expect(unlockedIds).toEqual(['srv']);
    expect(isServerUnlocked(servers[1], unlockedIds)).toBe(true);
  });

  it('без флага сервер заперт — даже если в этой вкладке его открывали', () => {
    useServersStore.getState().markUnlocked('srv');
    // Пароль сменили, пока мы сидели: сервер пропуск больше не признаёт и
    // говорит об этом первой же рассылкой. Держаться за свою память значило бы
    // рисовать открытым сервер, чьи каналы уже не приходят.
    useServersStore.getState().setServers([main, locked()]);
    const { servers, unlockedIds } = useServersStore.getState();
    expect(unlockedIds).toEqual([]);
    expect(isServerUnlocked(servers[1], unlockedIds)).toBe(false);
  });

  it('верный пароль открывает сервер сразу, не дожидаясь рассылки реестра', () => {
    useServersStore.getState().setServers([main, locked()]);
    useServersStore.getState().markUnlocked('srv');
    expect(useServersStore.getState().unlockedIds).toEqual(['srv']);
  });

  it('сервер без пароля открыт всегда', () => {
    expect(isServerUnlocked(main, [])).toBe(true);
  });

  it('активный сервер, пропавший из реестра, откатывается на главный', () => {
    useServersStore.getState().setServers([main, locked({ unlocked: true })]);
    useServersStore.getState().setActiveServer('srv');
    useServersStore.getState().setServers([main]);
    expect(useServersStore.getState().activeServerId).toBe(MAIN_SERVER_ID);
  });
});
