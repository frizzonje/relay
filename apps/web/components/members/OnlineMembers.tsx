'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { listItem, springLayout } from '@/lib/motion';
import { AnimatedCount } from '@/components/ui/AnimatedCount';
import { useUiStore } from '@/stores/ui';
import { useChatStore } from '@/stores/chat';
import { useSetting } from '@/stores/config';
import { avatarStyle } from '@/lib/avatar';
import { Identicon } from '@/components/ui/Identicon';
import { PresenceDot } from '@/components/ui/PresenceDot';
import { shortFingerprint } from '@/lib/format';
import { useRichT, useT } from '@/lib/i18n';
import { usePresence } from '@/stores/presence';

/**
 * Правая колонка текстового канала (раздел 05 референса, 232px): «В сети» —
 * просто присутствующие в канале, без микрофон-статусов. Ростер приходит с
 * сервера событием `chat-roster` и лежит в chat-сторе. Видна только в тексте.
 *
 * Точка присутствия — из глобального стора (`stores/presence.ts`), а не
 * буквально `online`: строка в этом списке означает лишь «подписан на канал
 * прямо сейчас», а человек мог одновременно быть в голосовом канале — и тогда
 * точке положено показать `in-voice`, а не соврать зелёным. У ростера без
 * отпечатка (аноним без ключа) точки нет вовсе — presence не знает, кто это.
 */
export function OnlineMembers() {
  const t = useT();
  const rt = useRichT();
  const view = useUiStore((s) => s.view);
  const callsign = useUiStore((s) => s.callsign);
  const roster = useChatStore((s) => s.roster);
  const showFingerprints = useSetting<boolean>('people.showFingerprints');
  if (view !== 'text') return null;

  const me = callsign.trim() || t('common.anonymous');

  return (
    <aside
      data-testid="online-members"
      className="panel panel-sidebar flex w-[232px] shrink-0 flex-col overflow-hidden border-l border-line max-md:grow max-md:border-l-0"
    >
      {/* На мобиле заголовок с тем же счётчиком уже стоит в шапке — не дублируем */}
      <h3 className="flex h-[52px] shrink-0 items-center gap-1 border-b border-line px-4 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-text-faint shadow-[0_1px_2px_rgba(0,0,0,0.2)] max-md:hidden">
        {rt('members.online', { count: <AnimatedCount value={roster.length} /> })}
      </h3>
      <div className="flex-1 overflow-y-auto px-2 py-3">
        <AnimatePresence initial={false}>
          {roster.map(({ nick, fingerprint }) => (
            <RosterRow
              // Ключ строки — отпечаток: имена не уникальны, и два тёзки
              // делили бы одну строку списка, мигая друг другом при каждом
              // изменении состава.
              key={fingerprint || `nick:${nick}`}
              nick={nick}
              fingerprint={fingerprint}
              me={me}
              showFingerprints={showFingerprints}
            />
          ))}
        </AnimatePresence>
      </div>
    </aside>
  );
}

/**
 * Отдельным компонентом, а не строкой прямо в `.map`: `usePresence` — хук, а
 * число строк ростера меняется от рендера к рендеру. Вызови его прямо внутри
 * `.map`, и число хуков `OnlineMembers` за один рендер плавало бы вместе с
 * составом — именно то, что React запрещает.
 */
function RosterRow({
  nick,
  fingerprint,
  me,
  showFingerprints,
}: {
  nick: string;
  fingerprint?: string;
  me: string;
  showFingerprints: boolean;
}) {
  const t = useT();
  // Без отпечатка presence спрашивать не о ком — usePresence('') читает
  // несуществующую запись и просто вернёт 'offline', а рисоваться дальше
  // всё равно не будет: ветка ниже точку в этом случае не выводит.
  const presence = usePresence(fingerprint ?? '');
  return (
    <motion.div
      layout
      variants={listItem}
      initial="hidden"
      animate="show"
      exit="exit"
      transition={springLayout}
      className="flex items-center gap-2.5 rounded-[8px] px-2 py-1.5 transition-colors hover:bg-bg-hover"
    >
      <div className="relative h-8 w-8 shrink-0">
        {fingerprint ? (
          <>
            <Identicon fingerprint={fingerprint} size={32} />
            <PresenceDot
              state={presence}
              size={11}
              className="absolute -bottom-0.5 -right-0.5 ring-2 ring-bg-sidebar"
            />
          </>
        ) : (
          <div className="h-full w-full rounded-full" style={avatarStyle(nick)} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            'truncate text-[14px]',
            nick === me ? 'font-semibold text-text-header' : 'text-text',
          )}
        >
          {nick === me ? t('common.you', { name: nick }) : nick}
        </div>
        {/* Картинка для узнавания, текст для сверки: лицо запоминают боковым
            зрением, а спорный случай разбирают по отпечатку — и тогда его
            надо иметь под рукой, а не в тултипе. */}
        {fingerprint && showFingerprints && (
          <div className="truncate font-mono text-[10px] tracking-[0.06em] text-text-faint">
            {shortFingerprint(fingerprint)}
          </div>
        )}
      </div>
    </motion.div>
  );
}
