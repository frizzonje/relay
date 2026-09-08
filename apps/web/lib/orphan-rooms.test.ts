import { describe, expect, it } from 'vitest';
import type { VoicePresence } from '@relay/shared';
import { orphanVoiceRooms } from '@/lib/orphan-rooms';

/**
 * Правило временных строк в сайдбаре. Проверяем его без рендера: это правила
 * («что считать потерянным эфиром»), а не разметка, — и цена ошибки тут не
 * косметическая. Комната разговора двоих приезжает в присутствие обоим
 * собеседникам, и стоило ей попасть в этот список, как принятый звонок рисовал
 * себе «канал» с машинным именем voice:dm-… прямо в списке каналов сервера.
 */

const room = (n = 1): VoicePresence[string] =>
  Array.from({ length: n }, (_, i) => ({
    id: `sock-${i}`,
    name: `Гость-${i}`,
    micOn: true,
    deafened: false,
    transport: 'p2p' as const,
  }));

const CALL = 'voice:dm-0123456789abcdef01234567';

describe('orphanVoiceRooms', () => {
  it('оставляет занятый эфир, которого нет в реестре', () => {
    const presence: VoicePresence = { 'удалённый-канал': room(2) };
    expect(orphanVoiceRooms(presence, new Set(['общий']), null)).toEqual(['удалённый-канал']);
  });

  it('не повторяет каналы реестра', () => {
    const presence: VoicePresence = { общий: room(1) };
    expect(orphanVoiceRooms(presence, new Set(['общий']), null)).toEqual([]);
  });

  it('оставляет свою пустую комнату — в ней сидим мы сами', () => {
    const presence: VoicePresence = { 'свой-эфир': [] };
    expect(orphanVoiceRooms(presence, new Set(), 'свой-эфир')).toEqual(['свой-эфир']);
  });

  it('никогда не показывает комнату разговора двоих', () => {
    const presence: VoicePresence = { [CALL]: room(2) };
    expect(orphanVoiceRooms(presence, new Set(), CALL)).toEqual([]);
  });

  it('прячет разговор, но не теряет соседний потерянный эфир', () => {
    const presence: VoicePresence = { [CALL]: room(2), 'удалённый-канал': room(1) };
    expect(orphanVoiceRooms(presence, new Set(), CALL)).toEqual(['удалённый-канал']);
  });
});
