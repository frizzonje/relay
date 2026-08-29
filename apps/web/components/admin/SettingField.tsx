'use client';

import { useEffect, useState } from 'react';
import type { SettingSpec, SettingValue } from '@relay/shared';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/ui/icon';
import { Switch } from '@/components/ui/switch';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { fmtBytes } from '@/lib/format';
import { useT, type MessageKey, type Translate } from '@/lib/i18n';
import { adminRefusalKey } from '@/lib/refusals';
import { useAdminStore } from '@/stores/admin';

/**
 * Одно поле панели инсталляции.
 *
 * Главное правило файла: КОНТРОЛ ВЫБИРАЕТСЯ ПО ВИДУ ПАРАМЕТРА ИЗ КАТАЛОГА, а не
 * по его имени. Здесь нет и не может быть ни одной проверки вида «если это
 * такой-то ключ» — иначе девяносто пятый параметр пришлось бы рисовать руками,
 * а каталог перестал бы быть контрактом и стал бы просто списком, который
 * панель дублирует по памяти. Всё, что поле знает о параметре, оно берёт из
 * `spec`: вид, границы, варианты, «опасно», «только чтение», «когда
 * подействует». Подписи приходят по ключу словаря, собранному из ключа
 * каталога, — тем же механическим способом.
 *
 * Под полем всегда видно три вещи, каждая из которых иначе врала бы молча:
 * когда правка подействует (сразу, к новым подключениям, после перезапуска или
 * «правится в .env»), что запись сейчас в полёте, и почему сервер отказал.
 * Молчаливое «сохранено», после которого до перезапуска ничего не изменилось,
 * — худший вид вранья: человек идёт искать поломку не там.
 */

/** Шаги единиц и их подписи. `stats.unit.*` уже есть в словаре — берём их. */
const BYTE_STEPS = [1, 1024, 1024 * 1024, 1024 * 1024 * 1024] as const;
const BYTE_UNITS = ['b', 'kb', 'mb', 'gb'] as const;
/** Мегабайты: в них человек называет размер файла, и с них удобно начинать. */
const DEFAULT_BYTE_STEP = 2;

/**
 * Подпись параметра — по ключу каталога, а не по совпадению с именем поля.
 *
 * `translate` возвращает сам ключ, когда его нет в словаре. Пустая строка на
 * этом месте честнее: параметр, заведённый сервером новее панели, покажется
 * машинным именем (см. `label`), а не строкой `settings.key.…`, в которой
 * человеку нечего прочитать.
 */
function textOf(t: Translate, key: string, part: 'label' | 'hint'): string {
  const message = `settings.key.${key}.${part}` as MessageKey;
  const text = t(message);
  return text === message ? '' : text;
}

/** Название варианта селекта или чипа — тем же способом, что и подпись поля. */
function optionOf(t: Translate, key: string, option: string): string {
  const message = `settings.option.${key}.${option}` as MessageKey;
  const text = t(message);
  return text === message ? option : text;
}

/** Наибольшая единица, в которой размер остаётся целым числом. */
function pickStep(bytes: number): number {
  for (let i = BYTE_STEPS.length - 1; i > 0; i -= 1) {
    if (bytes !== 0 && bytes % BYTE_STEPS[i] === 0) return i;
  }
  return bytes === 0 ? DEFAULT_BYTE_STEP : 0;
}

export function SettingField({ spec }: { spec: SettingSpec }) {
  const t = useT();
  const stored = useAdminStore((s) => s.values[spec.key]);
  const saving = useAdminStore((s) => s.saving.includes(spec.key));
  const refusal = useAdminStore((s) => s.errors[spec.key]);
  // Значения ключа может не быть только у сервера новее панели — там показываем
  // умолчание каталога, оно приехало вместе с описанием параметра.
  const value = stored ?? spec.fallback;

  /**
   * Правка, которую ещё не подтвердили. Опасное (`danger`) не уезжает по
   * нажатию: сперва вопрос, и `confirm: true` в запросе — то, чем за ответ
   * отвечают перед сервером. Без поля сервер откажет сам (`needs-confirm`).
   */
  const [pending, setPending] = useState<SettingValue | null>(null);

  const label = textOf(t, spec.key, 'label') || spec.key;
  const hint = textOf(t, spec.key, 'hint');

  const write = (next: SettingValue) => {
    if (spec.danger) {
      setPending(next);
      return;
    }
    void useAdminStore.getState().set(spec.key, next);
  };

  /** Секрет меняется своей дорогой (§9.5): общей записью он не проходит. */
  const writeSecret = (next: string) => {
    if (spec.danger) {
      setPending(next);
      return;
    }
    void useAdminStore.getState().setPassword(next);
  };

  const confirm = () => {
    if (pending === null) return;
    // Дорога та же, что и без подтверждения, — разница только в том, что
    // спросили. Секрет по-прежнему идёт своей.
    if (spec.kind === 'secret') void useAdminStore.getState().setPassword(String(pending));
    else void useAdminStore.getState().set(spec.key, pending, { confirm: true });
    setPending(null);
  };

  const control = spec.readOnly ? (
    <ReadOnlyValue spec={spec} value={value} />
  ) : spec.kind === 'boolean' ? (
    <Switch checked={value === true} onChange={write} label={label} />
  ) : spec.kind === 'secret' ? (
    <SecretControl spec={spec} value={value === true} label={label} onChange={writeSecret} />
  ) : spec.kind === 'select' ? (
    <SelectControl spec={spec} value={String(value)} label={label} onChange={write} />
  ) : spec.kind === 'list' ? (
    <ListControl spec={spec} value={Array.isArray(value) ? value : []} onChange={write} />
  ) : spec.kind === 'number' || spec.kind === 'bytes' ? (
    <NumberControl spec={spec} value={Number(value)} label={label} onChange={write} />
  ) : (
    <TextControl spec={spec} value={String(value)} label={label} onChange={write} />
  );

  // Флаг и секрет встают в строку с названием: контрол там узкий, и колонка
  // под ним оставила бы половину строки пустой. Остальные — под названием.
  const inline = !spec.readOnly && (spec.kind === 'boolean' || spec.kind === 'secret');

  return (
    <div
      data-testid={`admin-field-${spec.key}`}
      className="rounded-[10px] border border-line bg-bg-elev/60 px-3.5 py-3"
    >
      <div className={cn(inline && 'flex items-center justify-between gap-4')}>
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-text">{label}</div>
          {hint && <div className="text-[12px] leading-relaxed text-text-muted">{hint}</div>}
        </div>
        <div className={cn(inline ? 'shrink-0' : 'mt-2.5')}>{control}</div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span
          data-testid={`admin-applies-${spec.key}`}
          className="font-mono text-[11px] uppercase tracking-[0.16em] text-text-faint"
        >
          {appliesNote(t, spec)}
        </span>
        <Bounds spec={spec} />
        {saving && (
          <span data-testid={`admin-saving-${spec.key}`} className="text-[12px] text-text-muted">
            {t('admin.saving')}
          </span>
        )}
      </div>

      {/* Отказ — причиной, а не тишиной: поле вернулось на прежнее значение, и
          человек должен узнать, почему именно, а не думать, что панель мертва. */}
      {refusal && (
        <p
          data-testid={`admin-error-${spec.key}`}
          className="mt-1.5 text-[12px] leading-relaxed text-danger"
        >
          {t(adminRefusalKey(refusal))}
        </p>
      )}

      {pending !== null && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setPending(null)}
          title={t('admin.confirm.title', { name: label })}
          description={t('admin.confirm.body')}
          confirmLabel={t('admin.confirm.apply')}
          onConfirm={confirm}
        />
      )}
    </div>
  );
}

/** Когда правка подействует — строкой под полем, а не в голове у автора. */
function appliesNote(t: Translate, spec: SettingSpec): string {
  // «Только чтение» и «живёт в окружении» — одно и то же положение дел, и
  // называть его надо переменной, в которой оно лежит: искать её человек пойдёт
  // в `.env` конкретной машины.
  if (spec.readOnly || spec.applies === 'env') {
    return t('admin.applies.env', { name: spec.env ?? '.env' });
  }
  const key: MessageKey =
    spec.applies === 'new'
      ? 'admin.applies.new'
      : spec.applies === 'restart'
        ? 'admin.applies.restart'
        : 'admin.applies.now';
  return t(key);
}

/** Границы и потолки — из каталога, в человеческом виде. */
function Bounds({ spec }: { spec: SettingSpec }) {
  const t = useT();
  if (spec.readOnly) return null;

  const text =
    spec.kind === 'bytes' && spec.max !== undefined
      ? t('admin.range', { min: fmtBytes(spec.min ?? 0), max: fmtBytes(spec.max) })
      : spec.kind === 'number' && spec.min !== undefined && spec.max !== undefined
        ? t('admin.range', { min: String(spec.min), max: String(spec.max) })
        : spec.kind === 'list' && spec.max !== undefined && !spec.options
          ? t('admin.limit.items', { max: String(spec.max) })
          : (spec.kind === 'text' || spec.kind === 'multiline') && spec.max !== undefined
            ? t('admin.limit.chars', { max: String(spec.max) })
            : '';

  if (!text) return null;
  return <span className="text-[12px] text-text-muted">{text}</span>;
}

/** Параметр из окружения: значение видно, править его отсюда нельзя. */
function ReadOnlyValue({ spec, value }: { spec: SettingSpec; value: SettingValue }) {
  const t = useT();
  // У секрета значения нет и в панели: наружу уезжает только признак «задано».
  const shown = spec.secret
    ? value === true
      ? t('admin.secret.set')
      : t('admin.secret.unset')
    : String(value).trim() || t('admin.empty');
  return (
    <p className="mt-2.5 break-all rounded-[8px] border border-dashed border-line px-3 py-2 font-mono text-[12px] text-text-muted">
      {shown}
    </p>
  );
}

/**
 * Секрет: «задано / не задано» и кнопка «сменить». Значения здесь нет и быть не
 * может — сервер знает только хэш и наружу его не отдаёт.
 *
 * Про то, что это пароль инсталляции, поле не знает: сменяемый секрет в
 * каталоге ровно один (`secret` без `readOnly`), и стор выбирает его тем же
 * правилом. Появится второй — правило придётся уточнить в обоих местах сразу.
 */
function SecretControl({
  spec,
  value,
  label,
  onChange,
}: {
  spec: SettingSpec;
  value: boolean;
  label: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (!editing) {
    return (
      <div className="flex items-center gap-3">
        <span
          data-testid={`admin-secret-${spec.key}`}
          className={cn('text-[13px]', value ? 'text-ok' : 'text-text-muted')}
        >
          {value ? t('admin.secret.set') : t('admin.secret.unset')}
        </span>
        <button
          type="button"
          onClick={() => {
            setDraft('');
            setEditing(true);
          }}
          className="rounded-[8px] border border-line-strong bg-bg-active px-3 py-1.5 text-[13px] text-text outline-none transition-colors hover:bg-line-strong"
        >
          {t('admin.secret.change')}
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="password"
        autoFocus
        value={draft}
        maxLength={spec.max}
        aria-label={label}
        placeholder={t('admin.secret.placeholder')}
        onChange={(e) => setDraft(e.target.value)}
        className="w-[200px] rounded-[8px] border border-line bg-bg-elev px-3 py-1.5 text-[13px] text-text outline-none transition focus:border-line-strong"
      />
      <button
        type="button"
        onClick={() => {
          setEditing(false);
          onChange(draft);
        }}
        className="rounded-[8px] bg-accent-strong px-3 py-1.5 text-[13px] font-semibold text-bg-app outline-none transition hover:brightness-95"
      >
        {t('admin.secret.save')}
      </button>
      <button
        type="button"
        onClick={() => setEditing(false)}
        aria-label={t('common.cancel')}
        className="grid h-7 w-7 place-items-center rounded-[7px] text-lg leading-none text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text"
      >
        ×
      </button>
    </div>
  );
}

/** Селект по вариантам каталога — тот же вид, что у личных настроек. */
function SelectControl({
  spec,
  value,
  label,
  onChange,
}: {
  spec: SettingSpec;
  value: string;
  label: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  return (
    <div className="relative">
      <select
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        className="w-full appearance-none rounded-[10px] border border-line bg-bg-elev py-2 pl-3.5 pr-10 text-[14px] text-text outline-none transition focus:border-line-strong"
      >
        {(spec.options ?? []).map((option) => (
          <option key={option} value={option}>
            {optionOf(t, spec.key, option)}
          </option>
        ))}
      </select>
      <Icon
        name="chevron-down"
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[16px] text-text-muted"
      />
    </div>
  );
}

/**
 * Список — набором чипов. Каталог различает два случая, и это видно на экране:
 * с `options` выбирают из готового набора (чип нажимается), без них список
 * пишет владелец, и чип нужно уметь добавить и снять.
 */
function ListControl({
  spec,
  value,
  onChange,
}: {
  spec: SettingSpec;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState('');

  if (spec.options) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {spec.options.map((option) => {
          const on = value.includes(option);
          return (
            <button
              key={option}
              type="button"
              aria-pressed={on}
              onClick={() =>
                onChange(on ? value.filter((item) => item !== option) : [...value, option])
              }
              className={cn(
                'rounded-[8px] border px-2.5 py-1 text-[13px] outline-none transition-colors',
                on
                  ? 'border-line-strong bg-bg-active text-text-header'
                  : 'border-dashed border-line text-text-muted hover:text-text',
              )}
            >
              {optionOf(t, spec.key, option)}
            </button>
          );
        })}
      </div>
    );
  }

  const add = () => {
    const item = draft.trim();
    setDraft('');
    if (!item || value.includes(item)) return;
    onChange([...value, item]);
  };

  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((item) => (
            <span
              key={item}
              className="flex items-center gap-1 rounded-[8px] border border-line bg-bg-active px-2 py-1 text-[13px] text-text"
            >
              {item}
              <button
                type="button"
                aria-label={t('admin.list.remove', { item })}
                onClick={() => onChange(value.filter((other) => other !== item))}
                className="text-text-muted outline-none transition-colors hover:text-danger"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          value={draft}
          placeholder={t('admin.list.add')}
          aria-label={t('admin.list.add')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            add();
          }}
          className="w-[220px] rounded-[8px] border border-line bg-bg-elev px-3 py-1.5 text-[13px] text-text outline-none transition focus:border-line-strong"
        />
        <button
          type="button"
          onClick={add}
          className="rounded-[8px] border border-line-strong bg-bg-active px-3 py-1.5 text-[13px] text-text outline-none transition-colors hover:bg-line-strong"
        >
          {t('admin.list.addButton')}
        </button>
      </div>
    </div>
  );
}

/**
 * Число и размер — одним контролом: у размера к полю добавляется выбор единицы,
 * и человек видит «25 МБ», а не 26214400.
 *
 * Смена единицы — это смена значения, а не переодевание того же числа: пара
 * «число + единица» и есть значение. Показать 0,02 ГБ вместо 25 МБ значило бы
 * предложить владельцу дробь там, где каталог принимает только целое.
 *
 * Границы каталога здесь не проверяются намеренно: вторая копия проверки
 * разъехалась бы с серверной, а отказ и так виден под полем причиной.
 */
function NumberControl({
  spec,
  value,
  label,
  onChange,
}: {
  spec: SettingSpec;
  value: number;
  label: string;
  onChange: (value: number) => void;
}) {
  const t = useT();
  const bytes = spec.kind === 'bytes';
  const [step, setStep] = useState(() => (bytes ? pickStep(value) : 0));
  const shown = bytes ? value / BYTE_STEPS[step] : value;
  const [draft, setDraft] = useState(String(shown));

  // Значение приехало снаружи (ответ сервера, правка со второго устройства,
  // откат после отказа) — поле обязано показать его, а не то, что набрали.
  useEffect(() => {
    const next = bytes ? pickStep(value) : 0;
    setStep(next);
    setDraft(String(bytes ? value / BYTE_STEPS[next] : value));
  }, [value, bytes]);

  const commit = (text: string, at: number) => {
    const parsed = Number(text);
    // Пустое или нечисло — это не правка, а недописанный ввод: возвращаем поле
    // к тому, что стоит в настройке, и молчим.
    if (!text.trim() || !Number.isFinite(parsed)) {
      setDraft(String(bytes ? value / BYTE_STEPS[at] : value));
      return;
    }
    const next = bytes ? Math.round(parsed * BYTE_STEPS[at]) : Math.round(parsed);
    if (next === value) return;
    onChange(next);
  };

  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        value={draft}
        min={bytes ? undefined : spec.min}
        max={bytes ? undefined : spec.max}
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value, step)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          commit(draft, step);
        }}
        className="w-[140px] rounded-[10px] border border-line bg-bg-elev px-3 py-2 text-[14px] text-text outline-none transition focus:border-line-strong"
      />
      {bytes && (
        <div className="relative">
          <select
            value={BYTE_UNITS[step]}
            aria-label={t('admin.unit')}
            onChange={(e) => {
              const at = BYTE_UNITS.indexOf(e.target.value as (typeof BYTE_UNITS)[number]);
              if (at < 0) return;
              setStep(at);
              commit(draft, at);
            }}
            className="appearance-none rounded-[10px] border border-line bg-bg-elev py-2 pl-3 pr-9 text-[14px] text-text outline-none transition focus:border-line-strong"
          >
            {BYTE_UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {t(`stats.unit.${unit}` as MessageKey)}
              </option>
            ))}
          </select>
          <Icon
            name="chevron-down"
            className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[16px] text-text-muted"
          />
        </div>
      )}
      {bytes && <span className="text-[12px] text-text-muted">{fmtBytes(value)}</span>}
    </div>
  );
}

/** Строка и многострочный текст — одно поле на два вида, разница в высоте. */
function TextControl({
  spec,
  value,
  label,
  onChange,
}: {
  spec: SettingSpec;
  value: string;
  label: string;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    if (draft === value) return;
    onChange(draft);
  };

  const shared = {
    value: draft,
    maxLength: spec.max,
    'aria-label': label,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: commit,
    className:
      'w-full rounded-[10px] border border-line bg-bg-elev px-3 py-2 text-[14px] text-text outline-none transition focus:border-line-strong',
  };

  return spec.kind === 'multiline' ? (
    <textarea {...shared} rows={3} className={`${shared.className} resize-y leading-relaxed`} />
  ) : (
    <input
      {...shared}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        commit();
      }}
    />
  );
}
