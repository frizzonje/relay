import { describe, expect, it, vi } from 'vitest';
import { channelMenuEntries, type ChannelMenuTarget } from '@/lib/channel-menu';
import { isSeparator, type MenuAction, type MenuEntry } from '@/stores/context-menu';

/**
 * Правила меню канала. Проверяем именно их, а не разметку: это те же запреты,
 * что держит сервер (дефолтные каналы неприкосновенны, занятый эфир не
 * удаляется, чужие каналы не трогаются), и разъехаться они не должны — иначе
 * интерфейс будет предлагать действие, которое сервер молча отклонит.
 */

const ids = (entries: MenuEntry[]) => entries.map((e) => e.id);
const action = (entries: MenuEntry[], id: string) =>
  entries.find((e): e is MenuAction => !isSeparator(e) && e.id === id);

const noop = { onRename: () => {}, onDelete: () => {} };

// `mine` проставляет сервер под каждый сокет: это его ответ на вопрос «твоя ли
// эта запись» (см. audit B2). Клиент id владельца не видит и сам ничего не
// сравнивает — только рисует по флагу.
function target(
  over: Partial<ChannelMenuTarget['channel']> = {},
  occupants = 0,
): ChannelMenuTarget {
  return {
    channel: {
      id: 'c1',
      type: 'voice',
      name: 'переговорка',
      removable: true,
      mine: true,
      ...over,
    },
    occupants,
  };
}

describe('channelMenuEntries', () => {
  it('в своём голосовом канале даёт позвать, переименовать и удалить', () => {
    const entries = channelMenuEntries(target(), { ...noop, onInvite: () => {} });
    expect(ids(entries)).toEqual([
      'channel-invite',
      'channel-rename',
      'channel-sep',
      'channel-delete',
    ]);
  });

  it('в своём текстовом канале приглашения нет — только правка', () => {
    const entries = channelMenuEntries(target({ type: 'text' }), {
      ...noop,
      onInvite: () => {},
    });
    expect(ids(entries)).toEqual(['channel-rename', 'channel-sep', 'channel-delete']);
  });

  it('канал по умолчанию не переименовать и не удалить', () => {
    const entries = channelMenuEntries(target({ removable: false }), {
      ...noop,
      onInvite: () => {},
    });
    expect(ids(entries)).toEqual(['channel-invite']);
  });

  it('у дефолтного текстового канала пунктов нет вовсе — своё меню не показываем', () => {
    expect(channelMenuEntries(target({ type: 'text', removable: false }), noop)).toEqual([]);
  });

  it('чужой голосовой канал: позвать можно, менять — нет', () => {
    const entries = channelMenuEntries(target({ mine: undefined }), {
      ...noop,
      onInvite: () => {},
    });
    expect(ids(entries)).toEqual(['channel-invite']);
  });

  it('чужой текстовый канал: меню пусто — своё меню не показываем', () => {
    expect(channelMenuEntries(target({ type: 'text', mine: undefined }), noop)).toEqual([]);
  });

  it('пока в эфире кто-то есть, удаление отключено и объясняет причину', () => {
    const onDelete = vi.fn();
    const entries = channelMenuEntries(target({}, 2), { ...noop, onDelete });
    const del = action(entries, 'channel-delete');
    expect(del?.disabled).toBe(true);
    // Подпись собирается словарём; в тестах активна база — английская.
    expect(del?.hint).toBe('2 on air');
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('открытый кем-то текстовый канал удалить можно — там теряется только история', () => {
    const entries = channelMenuEntries(target({ type: 'text' }, 3), noop);
    expect(action(entries, 'channel-delete')?.disabled).toBeFalsy();
  });

  // Звук входящих — настройка слушателя, а не канала: сервер о ней не знает,
  // поэтому запреты на правку канала её не касаются.
  it('звук предлагается и в дефолтном текстовом канале, где править нечего', () => {
    const entries = channelMenuEntries(target({ type: 'text', removable: false }), {
      ...noop,
      onToggleSound: () => {},
    });
    expect(ids(entries)).toEqual(['channel-sound']);
  });

  it('в чужом текстовом канале звук тоже свой', () => {
    const entries = channelMenuEntries(target({ type: 'text', mine: undefined }), {
      ...noop,
      onToggleSound: () => {},
    });
    expect(ids(entries)).toEqual(['channel-sound']);
  });

  it('в своём текстовом канале звук идёт первым пунктом', () => {
    const entries = channelMenuEntries(target({ type: 'text' }), {
      ...noop,
      onToggleSound: () => {},
    });
    expect(ids(entries)).toEqual([
      'channel-sound',
      'channel-rename',
      'channel-sep',
      'channel-delete',
    ]);
  });

  it('пункт звука меняет подпись и значок по текущему состоянию канала', () => {
    const off = channelMenuEntries(
      { ...target({ type: 'text' }), loud: false },
      { ...noop, onToggleSound: () => {} },
    );
    // Подпись собирается словарём; в тестах активна база — английская.
    expect(action(off, 'channel-sound')).toMatchObject({
      label: 'Sound on new messages',
      icon: 'bell',
    });

    const on = channelMenuEntries(
      { ...target({ type: 'text' }), loud: true },
      { ...noop, onToggleSound: () => {} },
    );
    expect(action(on, 'channel-sound')).toMatchObject({
      label: 'Mute channel',
      icon: 'bell-off',
    });
  });

  it('голосовому каналу звук сообщений не предлагают — там их нет', () => {
    const entries = channelMenuEntries(target(), { ...noop, onToggleSound: () => {} });
    expect(ids(entries)).not.toContain('channel-sound');
  });
});
