import type { Channel } from '@relay/shared';
import type { MenuEntry } from '@/stores/context-menu';
import { tx } from '@/lib/i18n';

/**
 * Пункты меню канала — те же и по правой кнопке на строке, и по «⋯» на ховере
 * (см. Sidebar). Отдельная чистая функция: набор пунктов и их доступность —
 * это правила, а не разметка, поэтому проверяются тестами без рендера
 * (lib/channel-menu.test.ts).
 *
 * Правила ровно те же, что держит сервер, — интерфейс лишь показывает их
 * заранее, чтобы человек не жал в стену:
 *   • каналы по умолчанию (removable: false) не переименовать и не удалить —
 *     набор главного сервера фиксирован;
 *   • голосовой канал, в котором кто-то есть, не удаляется вовсе: удаление
 *     выбросило бы людей из разговора.
 */

export interface ChannelMenuTarget {
  channel: Pick<Channel, 'id' | 'type' | 'name' | 'removable'>;
  /** Сколько человек в канале прямо сейчас (для голосовых — из presence). */
  occupants: number;
}

export interface ChannelMenuActions {
  onRename: () => void;
  onDelete: () => void;
  /** Только голосовые: гостевая ссылка в этот эфир. */
  onInvite?: () => void;
}

export function channelMenuEntries(
  { channel, occupants }: ChannelMenuTarget,
  { onRename, onDelete, onInvite }: ChannelMenuActions,
): MenuEntry[] {
  const entries: MenuEntry[] = [];

  if (channel.type === 'voice' && onInvite) {
    entries.push({
      id: 'channel-invite',
      label: tx('channelMenu.invite'),
      icon: 'link',
      run: onInvite,
    });
  }

  // Дальше — только правка канала. У дефолтных её нет: приглашать в них можно,
  // трогать нельзя.
  if (!channel.removable) return entries;

  entries.push({
    id: 'channel-rename',
    label: tx('channelMenu.rename'),
    icon: 'edit',
    run: onRename,
  });

  const busy = channel.type === 'voice' && occupants > 0;
  if (entries.length) entries.push({ id: 'channel-sep', separator: true });
  entries.push({
    id: 'channel-delete',
    label: tx('channelMenu.delete'),
    icon: 'trash',
    danger: true,
    disabled: busy,
    // Подпись справа объясняет запрет на месте: отключённый пункт без причины
    // выглядит как поломка.
    ...(busy ? { hint: tx('channelMenu.busy', { count: occupants }) } : {}),
    run: onDelete,
  });

  return entries;
}
