'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { avatarStyle } from '@/lib/avatar';
import { cn } from '@/lib/utils';
import { listItem, springLayout } from '@/lib/motion';
import { Icon } from '@/components/ui/icon';
import { useVoiceStore } from '@/stores/voice';

/**
 * Кто сидит в голосовом канале — как в Discord.
 * Состав приходит с сервера событием `voice-presence` и лежит в сторе
 * (`presence[room]`); своя строка помечается «(вы)» по socket-id (`myId`).
 * Аватар — тот же стабильный бейдж по хэшу имени + зелёная точка статуса.
 * Справа — индикаторы: перечёркнутый микрофон (мут) и наушники (глушилка,
 * участник не слышит канал); состояние раздаёт сервер в том же presence.
 */
/**
 * Компактный стек аватарок сидящих в голосовом канале — на самой строке канала
 * (как в Discord). Показываем до трёх, остальных сворачиваем в «+N». Полный
 * список с именами/мутами по-прежнему живёт ниже в {@link VoiceMembers}.
 */
export function VoiceAvatarStack({ room }: { room: string }) {
  const members = useVoiceStore((s) => s.presence[room]);
  if (!members || members.length === 0) return null;

  const shown = members.slice(0, 3);
  const extra = members.length - shown.length;
  return (
    <span
      className="flex items-center"
      aria-label={`В канале: ${members.length}`}
      title={members.map((m) => m.name || 'Аноним').join(', ')}
    >
      <span className="flex -space-x-1.5">
        {shown.map((m) => (
          <span
            key={m.id}
            className="h-[18px] w-[18px] rounded-full bg-cover bg-center ring-2 ring-bg-sidebar"
            style={avatarStyle(m.name || 'Аноним')}
          />
        ))}
      </span>
      {extra > 0 && (
        <span className="ml-1 text-[11px] font-semibold tabular-nums text-text-muted">
          +{extra}
        </span>
      )}
    </span>
  );
}

export function VoiceMembers({ room }: { room: string }) {
  const members = useVoiceStore((s) => s.presence[room]);
  const myId = useVoiceStore((s) => s.myId);

  if (!members || members.length === 0) return null;

  return (
    <div className="my-px mb-1 flex flex-col gap-px">
      <AnimatePresence initial={false}>
        {members.map((m) => {
          const name = m.name || 'Аноним';
          const me = m.id === myId;
          const muted = m.micOn === false;
          return (
            <motion.div
              key={m.id}
              layout
              variants={listItem}
              initial="hidden"
              animate="show"
              exit="exit"
              transition={springLayout}
              className="flex cursor-default items-center gap-2 rounded py-1 pl-[26px] pr-2 text-sm text-text-muted transition-colors hover:bg-bg-hover"
            >
            <div
              className="relative h-[22px] w-[22px] shrink-0 rounded-full after:absolute after:-bottom-px after:-right-px after:h-2 after:w-2 after:rounded-full after:border-2 after:border-bg-sidebar after:bg-ok after:content-['']"
              style={avatarStyle(name)}
            />
            <div className={cn('min-w-0 flex-1 truncate', me && 'font-semibold text-text')}>
              {me ? name + ' (вы)' : name}
            </div>
            {/* Слоты под иконки всегда зарезервированы (даже пустые), чтобы имя не
                «прыгало» при переключении мута/глушилки по отдельности. */}
            <div className="flex shrink-0 items-center gap-1 text-danger/85">
              <Icon
                name="mic-off"
                className={cn('text-[14px]', muted ? 'animate-member-badge' : 'invisible')}
                title="Микрофон выключен"
              />
              <Icon
                name="headphone-off"
                className={cn('text-[14px]', m.deafened ? 'animate-member-badge' : 'invisible')}
                title="Звук выключен — не слышит канал"
              />
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
