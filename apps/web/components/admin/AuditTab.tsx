'use client';

import { useEffect } from 'react';
import type { AuditEntry } from '@relay/shared';
import { Icon } from '@/components/ui/icon';
import { Identicon } from '@/components/ui/Identicon';
import { fmtDayTime, shortFingerprint } from '@/lib/format';
import { useT, type MessageKey, type Translate } from '@/lib/i18n';
import { adminRefusalKey } from '@/lib/refusals';
import { useAdminStore } from '@/stores/admin';

/**
 * Вкладка «Журнал»: кто, что и когда сделал с инсталляцией.
 *
 * Журнал — отдельная таблица, а не файловый лог, и разница здесь по существу:
 * лог уезжает в ротацию и остаётся вопросом к `docker logs`, а «кто снял бан
 * позавчера» — вопрос к продукту, и спрашивают его через год.
 *
 * ЛИСТАЕТСЯ КУРСОРОМ ИЗ ВРЕМЕНИ И ID ПОСЛЕДНЕЙ ПОКАЗАННОЙ СТРОКИ (курсор
 * собирает стор). Одно время не годится: сброс группы пишет записи пачкой в
 * одну миллисекунду, и страница по времени теряла бы соседок — молча, потому
 * что заметить пропажу в журнале можно только зная, что она там была.
 *
 * Строка называет человека именем НА МОМЕНТ ДЕЙСТВИЯ и лицом по живому ключу:
 * переименовавшийся остаётся узнаваемым, а исчезнувший теряет лицо, но не имя.
 * Систему выдаёт пометка `system`, а не ник: узнавай мы её по тексту, человек с
 * таким же именем подделал бы системную запись.
 */
export function AuditTab() {
  const t = useT();
  const entries = useAdminStore((s) => s.audit);
  const more = useAdminStore((s) => s.auditMore);
  const busy = useAdminStore((s) => s.auditBusy);
  const loaded = useAdminStore((s) => s.auditLoaded);
  const error = useAdminStore((s) => s.auditError);

  // Спрашиваем только то, чего ещё не спрашивали: журнал живёт в сторе, и
  // иначе каждый заход на вкладку сбрасывал бы долистанные страницы.
  useEffect(() => {
    if (!useAdminStore.getState().auditLoaded) void useAdminStore.getState().loadAudit();
  }, []);

  return (
    <div data-testid="admin-audit" className="flex flex-col gap-2.5">
      <p className="text-[13px] leading-relaxed text-text-muted">{t('admin.audit.body')}</p>

      {busy && !loaded && (
        <p
          data-testid="admin-audit-busy"
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-faint"
        >
          {t('admin.loading')}
        </p>
      )}

      {error && (
        <p data-testid="admin-audit-error" className="text-[13px] text-danger">
          {t(adminRefusalKey(error))}
        </p>
      )}

      {loaded && !error && entries.length === 0 && (
        <p data-testid="admin-audit-empty" className="text-[13px] text-text-muted">
          {t('admin.audit.empty')}
        </p>
      )}

      {entries.map((item) => (
        <Row key={item.id} entry={item} />
      ))}

      {/* Кнопка есть, только пока сервер сказал, что ниже что-то осталось:
          «показать ещё», не приносящее ничего, читается как сломанная панель. */}
      {more && (
        <button
          type="button"
          data-testid="admin-audit-more"
          disabled={busy}
          onClick={() => void useAdminStore.getState().moreAudit()}
          className="self-start rounded-[8px] border border-line-strong bg-bg-active px-3 py-2 text-[13px] text-text outline-none transition-colors hover:bg-line-strong disabled:opacity-50"
        >
          {t('admin.audit.more')}
        </button>
      )}
    </div>
  );
}

/** Одна строка журнала: кто, что, над чем и когда. */
function Row({ entry }: { entry: AuditEntry }) {
  const t = useT();
  const detail = detailOf(t, entry);

  return (
    <div
      data-testid={`admin-audit-${entry.id}`}
      className="flex items-start gap-3 rounded-[10px] border border-line bg-bg-elev/60 px-3.5 py-3"
    >
      {entry.actor ? (
        <Identicon fingerprint={entry.actor} size={30} className="mt-0.5 shrink-0" />
      ) : (
        // У машины лица нет. Значок вместо него, а не пустое место: строки в
        // столбце должны начинаться на одной вертикали.
        <span className="mt-0.5 grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[8px] bg-bg-active text-text-faint">
          <Icon name="settings" className="text-[15px]" />
        </span>
      )}

      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] text-text-header">
          <span className="font-medium">
            {entry.system ? t('admin.audit.system') : entry.actorNick}
          </span>{' '}
          <span className="text-text-muted">{t(actionKey(entry.action))}</span>
        </div>
        {entry.target && (
          <div className="truncate font-mono text-[11px] tracking-[0.04em] text-text-faint">
            {targetText(entry)}
          </div>
        )}
        {detail && <div className="truncate text-[12px] text-text-muted">{detail}</div>}
      </div>

      <time className="shrink-0 font-mono text-[11px] text-text-faint">{fmtDayTime(entry.at)}</time>
    </div>
  );
}

/**
 * Название действия. Незнакомое — это сервер новее клиента: показываем машинное
 * имя, потому что пустое место в журнале хуже непонятного слова.
 */
function actionKey(action: string): MessageKey {
  return `admin.audit.action.${action}` as MessageKey;
}

/**
 * На что подействовали. У бана и отзыва устройства целью служит отпечаток — его
 * укорачиваем, как и везде: девятнадцать знаков в строку не влезают.
 */
function targetText(entry: AuditEntry): string {
  const target = entry.target ?? '';
  return entry.action === 'ban' || entry.action === 'unban' || entry.action === 'device-revoked'
    ? shortFingerprint(target)
    : target;
}

/**
 * Подробности строки — по одному предложению на вид действия.
 *
 * Свободный `detail` печатать как есть нельзя: `{"from":2000,"to":500}` в
 * журнале читается как отладочный вывод, а не как ответ на вопрос «что
 * изменилось». Незнакомое действие остаётся без этой строки — врать о нём
 * нечем, а имя действия у него уже есть.
 */
function detailOf(t: Translate, entry: AuditEntry): string | null {
  const detail = entry.detail ?? {};
  const count = (name: string) => (typeof detail[name] === 'number' ? (detail[name] as number) : 0);

  switch (entry.action) {
    case 'setting-changed':
      return t('admin.audit.change', { from: show(detail.from), to: show(detail.to) });
    case 'settings-reset':
      return t('admin.audit.keys', {
        count: Array.isArray(detail.keys) ? detail.keys.length : 0,
      });
    case 'settings-imported':
      return t('admin.audit.imported', {
        applied: count('applied'),
        rejected: Array.isArray(detail.rejected) ? detail.rejected.length : 0,
      });
    case 'retention-run':
    case 'files-swept':
      return t('admin.audit.removed', { count: count('removed') });
    case 'sessions-revoked':
    case 'device-revoked':
      return t('admin.audit.sockets', { count: count('sockets') });
    case 'password-changed':
      return t(detail.set ? 'admin.audit.password.set' : 'admin.audit.password.unset');
    case 'ban':
    case 'unban':
      return typeof detail.nick === 'string' ? detail.nick : null;
    default:
      return null;
  }
}

/** Значение настройки в строку. Пустое называем словом, а не пустотой. */
function show(value: unknown): string {
  if (value === null || value === undefined || value === '') return '∅';
  if (Array.isArray(value)) return value.join(', ') || '∅';
  return String(value);
}
