'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { avatarStyle } from '@/lib/avatar';
import { cn } from '@/lib/utils';
import { listItem, springLayout } from '@/lib/motion';
import { Icon } from '@/components/ui/icon';
import { kickGuest } from '@/lib/voice';
import { useVoiceStore } from '@/stores/voice';
import { useT } from '@/lib/i18n';

/**
 * Кто сидит в голосовом канале — как в Discord.
 * Состав приходит с сервера событием `voice-presence` и лежит в сторе
 * (`presence[room]`); своя строка помечается «(вы)» по socket-id (`myId`).
 * Аватар — тот же стабильный бейдж по хэшу имени + зелёная точка статуса.
 * Справа — индикаторы: перечёркнутый микрофон (мут) и наушники (глушилка,
 * участник не слышит канал); состояние раздаёт сервер в том же presence.
 *
 * Гостевая строка отличается двумя вещами: бейджем (гость, а у позванного в
 * закрытый канал — «слушает») и кнопкой «выгнать» по наведению. Выгнать гостя
 * вправе любой НЕ-гость — этот список видят только они (гостю сайдбар не
 * показывают вовсе), а право всё равно проверяет сервер.
 */
export function VoiceMembers({ room }: { room: string }) {
  const t = useT();
  const members = useVoiceStore((s) => s.presence[room]);
  const myId = useVoiceStore((s) => s.myId);

  if (!members || members.length === 0) return null;

  return (
    <div className="my-px mb-1 flex flex-col gap-px">
      <AnimatePresence initial={false}>
        {members.map((m) => {
          const name = m.name || t('common.anonymous');
          const me = m.id === myId;
          // Слушателю перечёркнутый микрофон не рисуем: он его не выключал, и
          // значок «без звука» читался бы как «сейчас включит обратно». Про его
          // права уже сказано бейджем рядом с именем.
          const muted = m.micOn === false && !m.listen;
          return (
            <motion.div
              key={m.id}
              layout
              variants={listItem}
              initial="hidden"
              animate="show"
              exit="exit"
              transition={springLayout}
              className="group flex cursor-default items-center gap-2 rounded py-1 pl-[26px] pr-2 text-sm text-text-muted transition-colors hover:bg-bg-hover"
            >
              <div
                className="relative h-[22px] w-[22px] shrink-0 rounded-full after:absolute after:-bottom-px after:-right-px after:h-2 after:w-2 after:rounded-full after:border-2 after:border-bg-sidebar after:bg-ok after:content-['']"
                style={avatarStyle(name)}
              />
              <div
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-1.5',
                  me && 'font-semibold text-text',
                )}
              >
                <span className="truncate">{me ? t('common.you', { name }) : name}</span>
                {/* Пришёл по инвайт-ссылке — доступ только к этому каналу. Что
                    он вдобавок лишь слушает, говорит значок справа, а не второй
                    бейдж: строка тут узкая, и каждая подпись съедает имя. */}
                {m.guest && (
                  <span
                    title={t(m.listen ? 'members.listen.title' : 'members.guest.title')}
                    className="shrink-0 rounded border border-line bg-bg-elev px-1 py-px text-[9px] font-bold uppercase tracking-[0.06em] text-text-muted"
                  >
                    {t('members.guest')}
                  </span>
                )}
              </div>

              {/* Выгнать гостя: появляется по наведению на строку, как «⋯» у
                  каналов, — постоянно висящая кнопка исключения превращала бы
                  список в панель модерации. */}
              {m.guest && !me && (
                <button
                  type="button"
                  title={t('members.kick', { name })}
                  aria-label={t('members.kick', { name })}
                  onClick={() => kickGuest(m.id, name)}
                  className="grid h-5 w-5 shrink-0 place-items-center rounded text-text-muted opacity-0 outline-none transition hover:bg-danger/15 hover:text-danger focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-danger group-hover:opacity-100"
                >
                  <Icon name="user-x" className="text-[14px]" />
                </button>
              )}
              {/* Слоты под иконки всегда зарезервированы (даже пустые), чтобы имя не
                «прыгало» при переключении мута/глушилки по отдельности. Первый
                слот у слушателя занят наушниками: у него не «выключен микрофон»,
                а его нет вовсе — и красный перечёркнутый значок тут врал бы. */}
              <div className="flex shrink-0 items-center gap-1 text-danger/85">
                {m.listen ? (
                  <Icon
                    name="headphones"
                    className="text-[14px] text-text-muted"
                    title={t('members.listen.title')}
                  />
                ) : (
                  <Icon
                    name="mic-off"
                    className={cn('text-[14px]', muted ? 'animate-member-badge' : 'invisible')}
                    title={t('members.mic.off')}
                  />
                )}
                <Icon
                  name="headphone-off"
                  className={cn('text-[14px]', m.deafened ? 'animate-member-badge' : 'invisible')}
                  title={t('members.deafened')}
                />
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
