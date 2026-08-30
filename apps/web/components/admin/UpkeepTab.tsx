'use client';

import { useRef, useState, type ReactNode } from 'react';
import { ownerLink, type AdminAction, type AdminImportRejection } from '@relay/shared';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';
import { useT, type MessageKey, type Translate } from '@/lib/i18n';
import { adminRefusalKey, type AdminFieldError } from '@/lib/refusals';
import { useAdminStore } from '@/stores/admin';

/**
 * Вкладка «Обслуживание»: то, что делают кнопкой, а не полем.
 *
 * Вкладка называется `upkeep`, а не `maintenance`, и это не вкусовщина:
 * `maintenance` — ГРУППА ПАРАМЕТРОВ (режим обслуживания и текст к нему), и два
 * разных места с одним именем спорили бы и на экране, и в разметке. Ровно то же
 * уже случилось с `people`, ставшей вкладкой `identities`.
 *
 * Три правила, на которых вкладка держится.
 *
 * ПЕРВОЕ: спрашиваем ДО отправки, а не после. Подтверждение здесь — не
 * вежливость, а само решение: прогнанная ретенция не отменяется, подметённые
 * файлы не возвращаются, а отозванные сессии выкидывают всех, включая
 * нажавшего. Единственное исключение — выгрузка: она ничего не меняет и
 * секретов не выносит, и спрашивать о ней значило бы приучать жать «да», не
 * читая.
 *
 * ВТОРОЕ: исход виден всегда — и удачный, и отказ. Молчание в ответ на нажатие
 * неотличимо от сломанной панели, и человек жмёт второй раз; для «отозвать все
 * сессии» второй раз стоит второго выселения всех.
 *
 * ТРЕТЬЕ: ключ владельца живёт в ЭТОМ КАДРЕ ЭКРАНА и нигде больше. Он
 * существует в читаемом виде ровно один раз — в базе лежит только хэш, — и
 * положи мы его в стор, он пережил бы переключение вкладок, а с ним и всякое
 * представление о том, где он побывал. Отсюда же предупреждение рядом: человек,
 * закрывший панель в уверенности, что ключ покажут снова, идёт за новым в ssh.
 */

/** Действия, которые спрашивают. Порядок — от полезного к разрушительному. */
const ASKED: readonly AdminAction[] = [
  'owner-link',
  'retention-run',
  'files-sweep',
  'revoke-sessions',
];

/** Что показать после ответа сервера. Одно на вкладку: жмут по одному. */
type Outcome =
  | { action: AdminAction; ok: true; count: number; rejected: AdminImportRejection[] }
  | { action: AdminAction; ok: false; error: AdminFieldError };

/** Ключ владельца — вне стора намеренно (см. третье правило вкладки). */
interface Issued {
  token: string;
  expiresAt: number;
}

export function UpkeepTab() {
  const t = useT();
  const [asking, setAsking] = useState<{ action: AdminAction; values?: SettingsFile } | null>(null);
  const [busy, setBusy] = useState<AdminAction | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const file = useRef<HTMLInputElement>(null);

  async function run(action: AdminAction, values?: SettingsFile) {
    setAsking(null);
    setBusy(action);
    // Прежний исход убираем ДО запроса: «подмели 7» под кнопкой, которую жмут
    // второй раз, читается как ответ на второе нажатие.
    setOutcome(null);
    setIssued(null);

    const res = await useAdminStore
      .getState()
      .runAction(action, values ? { confirm: true, values } : { confirm: action !== 'export' });
    setBusy(null);

    if (!res.ok) {
      setOutcome({ action, ok: false, error: res.error });
      return;
    }
    if (res.link) setIssued(res.link);
    if (res.settings) download(res.settings);
    setOutcome({
      action,
      ok: true,
      // Счётчиков у действий разные: подметённые файлы приезжают числом,
      // применённые ключи — списком. Наружу отдаём одно число: обе строки
      // отвечают на «сколько», и складывать их формы в разметке незачем.
      count: res.imported ? res.imported.applied.length : (res.count ?? 0),
      rejected: res.imported?.rejected ?? [],
    });
  }

  return (
    <div data-testid="admin-upkeep" className="flex flex-col gap-2.5">
      {ASKED.map((action) => (
        <Row
          key={action}
          action={action}
          busy={busy === action}
          outcome={outcome?.action === action ? outcome : null}
          onClick={() => setAsking({ action })}
        >
          {action === 'owner-link' && issued && (
            <OwnerLink issued={issued} onHide={() => setIssued(null)} />
          )}
        </Row>
      ))}

      {/* Выгрузка и загрузка стоят вместе и после разрушительного: это одна
          пара, и порознь они читались бы как разные умения. */}
      <Row
        action="export"
        busy={busy === 'export'}
        outcome={outcome?.action === 'export' ? outcome : null}
        onClick={() => void run('export')}
      />

      <Row
        action="import"
        busy={busy === 'import'}
        outcome={outcome?.action === 'import' ? outcome : null}
        onClick={() => file.current?.click()}
      >
        {/* Поле в разметке, а не создаваемое на лету: выбор файла обязан
            приходить событием элемента, который на экране уже есть. */}
        <input
          ref={file}
          data-testid="admin-import-file"
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const chosen = e.target.files?.[0];
            // Сбрасываем значение: выбрав тот же файл второй раз, человек не
            // получил бы события вовсе — оно приходит только на ИЗМЕНЕНИЕ.
            e.target.value = '';
            if (!chosen) return;
            void readSettings(chosen).then(
              (values) =>
                values
                  ? setAsking({ action: 'import', values })
                  : setOutcome({ action: 'import', ok: false, error: 'wrong-type' }),
              () => setOutcome({ action: 'import', ok: false, error: 'wrong-type' }),
            );
          }}
        />
      </Row>

      {asking && (
        <ConfirmDialog
          open
          onOpenChange={(v) => !v && setAsking(null)}
          title={t(`admin.upkeep.${asking.action}.title` as MessageKey)}
          description={t(`admin.upkeep.${asking.action}.confirm` as MessageKey)}
          confirmLabel={t(`admin.upkeep.${asking.action}.apply` as MessageKey)}
          onConfirm={() => void run(asking.action, asking.values)}
        />
      )}
    </div>
  );
}

/** Строка действия: что это, зачем и кнопка. Исход — под ней. */
function Row({
  action,
  busy,
  outcome,
  onClick,
  children,
}: {
  action: AdminAction;
  busy: boolean;
  outcome: Outcome | null;
  onClick: () => void;
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <div className="rounded-[10px] border border-line bg-bg-elev/60 px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[14px] text-text-header">
            {t(`admin.upkeep.${action}.title` as MessageKey)}
          </div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-text-muted">
            {t(`admin.upkeep.${action}.body` as MessageKey)}
          </p>
        </div>
        <button
          type="button"
          data-testid={`admin-action-${action}`}
          disabled={busy}
          onClick={onClick}
          className={cn(
            'shrink-0 rounded-[8px] border px-3 py-1.5 text-[13px] outline-none transition-colors disabled:opacity-50',
            // Красным — только необратимое. Выгрузка и ссылка обычные: залей мы
            // цветом всё подряд, красное перестало бы что-либо значить.
            action === 'files-sweep' || action === 'revoke-sessions'
              ? 'border-danger/40 text-danger hover:bg-danger/10'
              : 'border-line-strong bg-bg-active text-text hover:bg-line-strong',
          )}
        >
          {t(`admin.upkeep.${action}.button` as MessageKey)}
        </button>
      </div>

      {children}

      {outcome?.ok === true && (
        <div
          data-testid={`admin-action-done-${action}`}
          className="mt-2 text-[12px] leading-relaxed text-text-muted"
        >
          {t(`admin.upkeep.${action}.done` as MessageKey, { count: outcome.count })}
          {/* Отвергнутое перечисляем поимённо. Молча проглоченная половина
              файла — худший исход импорта: человек уходит уверенным, что
              инсталляция настроена так, как в файле. */}
          {outcome.rejected.length > 0 && <Rejected t={t} items={outcome.rejected} />}
        </div>
      )}

      {outcome?.ok === false && (
        <div data-testid={`admin-action-error-${action}`} className="mt-2 text-[12px] text-danger">
          {t(adminRefusalKey(outcome.error))}
        </div>
      )}
    </div>
  );
}

function Rejected({ t, items }: { t: Translate; items: AdminImportRejection[] }) {
  return (
    <ul className="mt-1 flex flex-col gap-0.5">
      {items.map((item) => (
        <li key={item.key} className="font-mono text-[11px] text-text-faint">
          {item.key} — {t(adminRefusalKey(item.reason))}
        </li>
      ))}
    </ul>
  );
}

/**
 * Ключ владельца на экране: целиком, выделенным и с кнопкой «скопировать».
 *
 * Поле только для чтения, а не строка текста: ссылку копируют, и выделять её
 * мышью из абзаца — верный способ потерять последний знак.
 */
function OwnerLink({ issued, onHide }: { issued: Issued; onHide: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const link = ownerLink(typeof window === 'undefined' ? '' : window.location.origin, issued.token);

  return (
    <div
      data-testid="admin-owner-link"
      className="mt-2.5 rounded-[8px] border border-accent/40 bg-accent/5 px-3 py-2.5"
    >
      <p className="text-[12px] leading-relaxed text-text">{t('admin.upkeep.owner-link.warn')}</p>
      <div className="mt-2 flex items-center gap-1.5">
        <input
          readOnly
          value={link}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded-[6px] border border-line bg-bg-deep px-2 py-1.5 font-mono text-[11px] text-text outline-none"
        />
        <button
          type="button"
          data-testid="admin-owner-link-copy"
          onClick={() => {
            void navigator.clipboard?.writeText(link).then(
              () => setCopied(true),
              // Буфер может быть закрыт политикой браузера. Молчать нельзя:
              // человек уйдёт, думая, что скопировал, — а ключа больше нет.
              () => setCopied(false),
            );
          }}
          className="shrink-0 rounded-[6px] border border-line-strong bg-bg-active px-2.5 py-1.5 text-[12px] text-text outline-none transition-colors hover:bg-line-strong"
        >
          {t(copied ? 'admin.upkeep.owner-link.copied' : 'admin.upkeep.owner-link.copy')}
        </button>
        <button
          type="button"
          data-testid="admin-owner-link-hide"
          onClick={onHide}
          className="shrink-0 rounded-[6px] px-2.5 py-1.5 text-[12px] text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text"
        >
          {t('admin.upkeep.owner-link.hide')}
        </button>
      </div>
    </div>
  );
}

/** Значения из выгруженного файла. Форма — та же, что отдаёт сервер. */
type SettingsFile = Record<string, unknown>;

/**
 * Прочитать выгрузку. `null` — файл не наш.
 *
 * Берём только `values`: в файле лежит ещё версия контракта и время снятия, и
 * отправлять их обратно как настройки значило бы просить сервер применить
 * ключи, которых в каталоге нет.
 */
async function readSettings(chosen: { text: () => Promise<string> }): Promise<SettingsFile | null> {
  const parsed: unknown = JSON.parse(await chosen.text());
  if (!parsed || typeof parsed !== 'object') return null;
  const values = (parsed as { values?: unknown }).values;
  return values && typeof values === 'object' ? (values as SettingsFile) : null;
}

/**
 * Отдать выгрузку файлом. Через `Blob`, а не ссылкой на сервер: выгрузка
 * приезжает ответом на событие сокета и на диске не существует вовсе.
 */
function download(settings: unknown): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = 'relay-settings.json';
  a.click();
  URL.revokeObjectURL(url);
}
