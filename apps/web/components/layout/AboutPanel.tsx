'use client';

import { Icon } from '@/components/ui/icon';
import { useT } from '@/lib/i18n';
import { useServerVersion } from '@/lib/use-sfu';
import { clientVersion } from '@/lib/version';
import { useDesktopStore } from '@/stores/desktop';
import { useSetting } from '@/stores/config';
import { cn } from '@/lib/utils';

/**
 * О программе: какие версии тут на самом деле работают.
 *
 * Экран нужен не для гордости номером. Чисел здесь три, и они умеют
 * расходиться: сервер обновился, а вкладка осталась открытой на прежнем
 * коде — и человек получает странности, для которых нет ни одной другой
 * подсказки. Поэтому расхождение не просто показано, а названо вслух вместе с
 * тем, что с ним делать.
 */
function Row({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-[13px] text-text-muted">{label}</span>
      <span className={cn('font-mono text-[13px]', dim ? 'text-text-faint' : 'text-text-header')}>
        {value}
      </span>
    </div>
  );
}

export function AboutPanel() {
  const t = useT();
  const server = useServerVersion();
  const client = clientVersion();
  const isDesktop = useDesktopStore((s) => s.isDesktop);
  const shell = useDesktopStore((s) => s.shell);
  // Показывать ли номер сборки инсталляции (`appearance.showVersion`). Прячется
  // именно СЕРВЕРНЫЙ номер: он про инсталляцию, и владелец вправе его не
  // объявлять. Клиентский остаётся — он про вкладку самого человека, и по нему
  // тот объясняет собственную беду. Вместе с серверным уходит и предупреждение
  // о расхождении: сказать «версии разошлись», не назвав их, — совет, который
  // нечем проверить.
  const showVersion = useSetting<boolean>('appearance.showVersion');
  // Правила инсталляции — текст владельца (`appearance.rulesText`). Пусто —
  // умолчание каталога, и раздела нет вовсе.
  const rules = useSetting<string>('appearance.rulesText').trim();

  // «Собрано из исходников» — не заглушка, а положение дел: у такой сборки
  // номера релиза нет, и подставить сюда что-нибудь означало бы соврать.
  const source = t('about.fromSource');
  const pending = server === null;

  // Расходятся только два настоящих номера. Пустая строка с любой стороны —
  // это «номера нет», а не «номер другой»: сборку из исходников не в чем
  // упрекнуть, и сервер, ответа от которого мы ещё ждём, тоже.
  const mismatch = showVersion && !pending && !!server && !!client && server !== client;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[12.5px] leading-relaxed text-text-muted">{t('about.blurb')}</p>

      <div className="rounded-lg border border-line px-3 py-1.5">
        <Row label={t('about.client')} value={client || source} dim={!client} />
        {showVersion && (
          <Row
            label={t('about.server')}
            value={pending ? t('about.asking') : server || source}
            dim={pending || !server}
          />
        )}
        {isDesktop && shell && <Row label={t('about.shell')} value={shell.version || source} />}
      </div>

      {rules && (
        <div className="rounded-lg border border-line px-3 py-2.5">
          <p className="mb-1 text-[11px] uppercase tracking-[0.08em] text-text-faint">
            {t('about.rules')}
          </p>
          {/* Текст владельца не переводится и абзацы сохраняет: поле в панели
              многострочное, и расставленное там обязано доехать до экрана. */}
          <p className="whitespace-pre-line text-[12.5px] leading-relaxed text-text-muted">
            {rules}
          </p>
        </div>
      )}

      {mismatch && (
        <p className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2.5 text-[13px] leading-relaxed text-warn">
          <Icon name="refresh" className="mt-[2px] shrink-0 text-[15px]" />
          <span>{t('about.mismatch')}</span>
        </p>
      )}
    </div>
  );
}
