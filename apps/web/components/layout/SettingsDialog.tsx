'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { springTab, tabPanel } from '@/lib/motion';
import {
  checkForUpdates,
  installUpdate,
  requestShellSettings,
  setAutostart,
  setPttShortcut,
  switchServer,
} from '@/lib/desktop';
import { getTheme, setTheme, type Theme } from '@/lib/theme';
import {
  LOCALES,
  LOCALE_LABELS,
  setLocale,
  tx,
  useLocale,
  useT,
  type MessageKey,
} from '@/lib/i18n';
import { isLocale } from '@/lib/i18n/config';
import { comboLabel, eventToCombo } from '@/lib/hotkeys';
import { useDesktopStore } from '@/stores/desktop';
import { useVoiceStore } from '@/stores/voice';
import { useHotkeysStore, HOTKEY_ACTIONS, type HotkeyAction } from '@/stores/hotkeys';
import {
  loadMediaPrefs,
  refreshMics,
  refreshSpeakers,
  refreshCameras,
  setMic,
  setSpeaker,
  setCamera,
  setNoiseSuppression,
  setPushToTalk,
  getMicLevel,
} from '@/lib/voice';

type Tab = 'av' | 'appearance' | 'hotkeys' | 'app' | 'notifications' | 'account';

const TABS: { id: Tab; label: MessageKey; desktopOnly?: boolean }[] = [
  { id: 'av', label: 'settings.tab.av' },
  { id: 'appearance', label: 'settings.tab.appearance' },
  { id: 'hotkeys', label: 'settings.tab.hotkeys' },
  // Настройки самой оболочки (автозапуск): в браузере показывать нечего.
  { id: 'app', label: 'settings.tab.app', desktopOnly: true },
  { id: 'notifications', label: 'settings.tab.notifications' },
  { id: 'account', label: 'settings.tab.account' },
];

function Chevron() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-muted"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/** Стилизованный native <select> с шевроном — общая обёртка для селектов настроек. */
function SelectField({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.16em] text-text-faint">
        {label}
      </span>
      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full appearance-none rounded-[10px] border border-line bg-bg-elev py-2.5 pl-3.5 pr-10 text-[14px] text-text outline-none transition focus:border-line-strong"
        >
          {children}
        </select>
        <Chevron />
      </div>
    </label>
  );
}

/** Селектор устройства: список из enumerateDevices + заглушка, пока доступа нет. */
function DeviceSelect({
  label,
  value,
  devices,
  fallback,
  onChange,
}: {
  label: string;
  value: string;
  devices: MediaDeviceInfo[];
  fallback: string;
  onChange: (id: string) => void;
}) {
  return (
    <SelectField label={label} value={value} onChange={onChange}>
      {devices.length === 0 && <option value="">{fallback}</option>}
      {devices.map((d, i) => (
        <option key={d.deviceId || i} value={d.deviceId}>
          {d.label || `${label} ${i + 1}`}
        </option>
      ))}
    </SelectField>
  );
}

/**
 * Выбор языка интерфейса. Названия языков не переводятся — каждый написан
 * на себе самом, чтобы его узнал тот, кто ищет именно его. Выбор пишется в
 * куку (её читает сервер), поэтому setLocale перезагружает страницу.
 */
function LanguageSelect() {
  const t = useT();
  const locale = useLocale();
  return (
    <div>
      <SelectField
        label={t('settings.language')}
        value={locale}
        onChange={(value) => isLocale(value) && setLocale(value)}
      >
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {LOCALE_LABELS[l]}
          </option>
        ))}
      </SelectField>
      <p className="mt-1.5 text-[12px] text-text-muted">{t('settings.language.hint')}</p>
    </div>
  );
}

/** Живой уровень входного сигнала микрофона — заполняющаяся полоса (rAF). */
function InputLevel({ active }: { active: boolean }) {
  const t = useT();
  const fillRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let shown = 0;
    const tick = () => {
      const lvl = getMicLevel();
      shown = lvl > shown ? lvl : shown + (lvl - shown) * 0.2;
      if (fillRef.current) fillRef.current.style.width = `${Math.round(shown * 100)}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return (
    <div>
      <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.16em] text-text-faint">
        {t('settings.inputLevel')}
      </span>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-black/45">
        <div ref={fillRef} className="h-full w-0 rounded-full bg-ok transition-none" />
      </div>
      <p className="mt-1.5 text-[12px] text-text-muted">{t('settings.inputLevel.hint')}</p>
    </div>
  );
}

/** Тоггл-переключатель (вкл/выкл) с подписью и пояснением. */
function Toggle({
  checked,
  onChange,
  title,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  hint: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-[10px] border border-line bg-bg-elev/60 px-3.5 py-3">
      <div className="min-w-0">
        <div className="text-[14px] font-medium text-text">{title}</div>
        <div className="text-[12px] text-text-muted">{hint}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative h-6 w-11 shrink-0 rounded-full transition-colors',
          checked ? 'bg-ok' : 'bg-line-strong',
        )}
      >
        <span
          className={cn(
            // left-0.5 фиксирует стартовую позицию явно: без него absolute-элемент
            // берёт «статическую» позицию из потока, которую флекс-строка считает
            // непредсказуемо (в разных webview — WebView2/WKWebView — ползунок
            // уезжал не туда). Сдвиг только через translate-x: 44−20−2·2 = 20px.
            'absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-5' : 'translate-x-0',
          )}
        />
      </button>
    </div>
  );
}

/**
 * Захват следующего нажатия как комбинации. Перехватываем в фазе capture, чтобы
 * не сработали чужие обработчики; Esc — отмена. Один голый модификатор
 * пропускаем и ждём основную клавишу.
 */
function useComboRecorder(onCombo: (combo: string) => void) {
  const [recording, setRecording] = useState(false);
  // Через ref, чтобы смена колбэка не переподписывала слушателя посреди записи.
  const handler = useRef(onCombo);
  useEffect(() => {
    handler.current = onCombo;
  });

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(false);
        return;
      }
      const c = eventToCombo(e);
      if (!c) return;
      handler.current(c);
      setRecording(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording]);

  return { recording, setRecording };
}

/**
 * Строка назначения горячей клавиши. По кнопке «Назначить» ловим следующее
 * нажатие и отдаём его наверх; крестик снимает привязку (действие выключается).
 * Без привязки действие не работает — это и есть «по умолчанию выкл».
 * `note` — пояснение под строкой (ошибка назначения или предупреждение).
 */
function KeybindRow({
  label,
  hint,
  combo,
  onCombo,
  onClear,
  note,
}: {
  label: string;
  hint: string;
  combo: string | null | undefined;
  onCombo: (combo: string) => void;
  onClear: () => void;
  note?: { text: string; tone: 'muted' | 'danger' };
}) {
  const t = useT();
  const { recording, setRecording } = useComboRecorder(onCombo);

  return (
    <div className="rounded-[10px] border border-line bg-bg-elev/60 px-3.5 py-3">
      {/* На узком экране метка и кнопка назначения не уживаются в строку — стопкой. */}
      <div className="flex items-center justify-between gap-4 max-md:flex-col max-md:items-start max-md:gap-2">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-text">{label}</div>
          <div className="text-[12px] text-text-muted">{hint}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setRecording((r) => !r)}
            className={cn(
              'min-w-[120px] rounded-[8px] border px-3 py-1.5 text-center font-mono text-[12px] outline-none transition-colors',
              recording
                ? 'border-accent-strong/60 bg-accent-strong/10 text-text-header'
                : combo
                  ? 'border-line-strong bg-bg-active text-text hover:border-line-strong hover:bg-line-strong'
                  : 'border-dashed border-line-strong text-text-muted hover:text-text',
            )}
          >
            {recording
              ? t('settings.hotkeys.recording')
              : combo
                ? comboLabel(combo)
                : t('settings.hotkeys.assign')}
          </button>
          {combo && !recording && (
            <button
              type="button"
              onClick={onClear}
              aria-label={t('settings.hotkeys.clearNamed', { action: label })}
              title={t('settings.hotkeys.clear')}
              className="grid h-7 w-7 place-items-center rounded-[7px] text-lg leading-none text-text-muted outline-none transition-colors hover:bg-danger/10 hover:text-danger"
            >
              ×
            </button>
          )}
        </div>
      </div>
      {note && (
        <p
          className={cn(
            'mt-2 text-[12px] leading-relaxed',
            note.tone === 'danger' ? 'text-danger' : 'text-text-muted',
          )}
        >
          {note.text}
        </p>
      )}
    </div>
  );
}

/** Горячая клавиша действия в голосовом канале (работает внутри окна relay). */
function VoiceKeybindRow({
  action,
  label,
  hint,
}: {
  action: HotkeyAction;
  label: string;
  hint: string;
}) {
  const combo = useHotkeysStore((s) => s.binds[action]);
  const setBind = useHotkeysStore((s) => s.setBind);
  return (
    <KeybindRow
      label={label}
      hint={hint}
      combo={combo}
      onCombo={(c) => setBind(action, c)}
      onClear={() => setBind(action, null)}
    />
  );
}

/**
 * Клавиша без модификаторов перехватывается системой ГЛОБАЛЬНО: пока relay
 * запущен, в других программах она работать перестанет. Для функциональных и
 * медиа-клавиш это ожидаемо (их для того и держат), для остальных — сюрприз,
 * о котором честнее предупредить, чем молча запретить.
 */
function globalKeyWarning(combo: string): string | null {
  const parts = combo.split('+');
  if (parts.length > 1) return null;
  const key = parts[0];
  if (/^F\d{1,2}$/.test(key) || key.startsWith('Media') || key.startsWith('Audio')) return null;
  return tx('settings.hotkeys.globalWarning');
}

/**
 * Глобальный push-to-talk десктоп-клиента. В отличие от строк выше, хоткей
 * регистрирует оболочка (Rust) — она же единственная знает, удалось ли занять
 * клавишу в системе. Поэтому значение и ошибку берём из её ответа, а не из
 * локального состояния: показываем ровно то, что реально применилось.
 */
function PttKeybindRow() {
  const t = useT();
  const shell = useDesktopStore((s) => s.shell);
  if (!shell) return null;

  const warning = shell.ptt ? globalKeyWarning(shell.ptt) : null;
  const note = shell.pttError
    ? {
        text: t('settings.hotkeys.assignFailed', { reason: shell.pttError }),
        tone: 'danger' as const,
      }
    : warning
      ? { text: warning, tone: 'muted' as const }
      : undefined;

  return (
    <KeybindRow
      label={t('settings.hotkeys.ptt')}
      hint={t('settings.hotkeys.ptt.hint')}
      combo={shell.ptt}
      onCombo={setPttShortcut}
      onClear={() => setPttShortcut(null)}
      note={note}
    />
  );
}

/**
 * Вкладка «Приложение» — всё про сам десктоп-клиент. Показывается в любой
 * оболочке (isDesktop), а не только в той, что умеет в настройки: обновления
 * нужны в первую очередь как раз старым клиентам (до 0.4.0), которые на
 * `desktop-settings-get` не отвечают. Поэтому блок обновлений безусловный, а
 * настройки оболочки рендерим, лишь когда она о них рассказала.
 */
function AppTab() {
  const t = useT();
  const isDesktop = useDesktopStore((s) => s.isDesktop);
  const shell = useDesktopStore((s) => s.shell);
  if (!isDesktop) return null;

  return (
    <div className="flex flex-col gap-2.5">
      {shell && (
        <>
          <Toggle
            checked={shell.autostart}
            onChange={setAutostart}
            title={t('settings.autostart')}
            hint={t('settings.autostart.hint')}
          />
          {shell.autostartError && (
            <p className="px-1 text-[12px] leading-relaxed text-danger">
              {t('settings.autostart.failed', { reason: shell.autostartError })}
            </p>
          )}
        </>
      )}
      <UpdateRow />
      {shell && (
        <p className="px-1 pt-1 font-mono text-[11px] uppercase tracking-[0.16em] text-text-faint">
          {t('settings.shellVersion', { version: shell.version })}
        </p>
      )}
    </div>
  );
}

function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-full place-items-center px-6 text-center font-mono text-[12px] uppercase tracking-[0.18em] text-text-faint">
      {children}
    </div>
  );
}

/**
 * Обновления десктоп-клиента — строка вкладки «Приложение», одной формы с
 * тумблерами и хоткеями. Приложение само ничего не ставит: здесь ручная
 * проверка и установка по клику (событие в Rust, см. lib/desktop.ts). Когда
 * апдейт найден — кнопка меняется на «Установить и перезапустить».
 */
function UpdateRow() {
  const t = useT();
  const update = useDesktopStore((s) => s.update);

  const busy = update.kind === 'checking' || update.kind === 'installing';
  const status =
    update.kind === 'checking'
      ? t('settings.updates.checking')
      : update.kind === 'up-to-date'
        ? t('settings.updates.upToDate')
        : update.kind === 'available'
          ? t('settings.updates.available', { version: update.version })
          : update.kind === 'installing'
            ? t('settings.updates.installing', { version: update.version })
            : update.kind === 'error'
              ? t('settings.updates.failed')
              : t('settings.updates.idle');

  return (
    <div className="flex items-center justify-between gap-4 rounded-[10px] border border-line bg-bg-elev/60 px-3.5 py-3">
      <div className="min-w-0">
        <div className="text-[14px] font-medium text-text">{t('settings.updates')}</div>
        <div
          className={cn('text-[12px]', update.kind === 'error' ? 'text-danger' : 'text-text-muted')}
        >
          {status}
        </div>
      </div>
      {update.kind === 'available' ? (
        <button
          type="button"
          onClick={installUpdate}
          className="shrink-0 rounded-[8px] bg-ok/15 px-3 py-1.5 text-[13px] font-medium text-ok outline-none transition-colors hover:bg-ok/25"
        >
          {t('settings.updates.install')}
        </button>
      ) : (
        <button
          type="button"
          onClick={checkForUpdates}
          disabled={busy}
          className="shrink-0 rounded-[8px] border border-line-strong bg-bg-active px-3 py-1.5 text-[13px] text-text outline-none transition-colors hover:bg-line-strong disabled:cursor-default disabled:opacity-60 disabled:hover:bg-bg-active"
        >
          {t('settings.updates.check')}
        </button>
      )}
    </div>
  );
}

/**
 * «Сменить сервер» — возврат оболочки на её локальный экран выбора инсталляции
 * (навигацию делает Rust, см. lib/desktop.ts). Только в Tauri: в браузере адрес
 * и так меняется в адресной строке. Дубль пункта трея — здесь его ищут, когда
 * окно открыто; трей остаётся запасным путём, если страница не загрузилась.
 */
function SwitchServerButton() {
  const t = useT();
  const isDesktop = useDesktopStore((s) => s.isDesktop);
  if (!isDesktop) return null;
  return (
    <button
      type="button"
      onClick={switchServer}
      className="w-full rounded-[8px] px-3 py-2 text-left text-[14px] text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text"
    >
      {t('settings.switchServer')}
    </button>
  );
}

/**
 * Модалка настроек (раздел 06 референса, 860×600 поверх блюра). Левая колонка —
 * навигация по вкладкам + выход из аккаунта; правая — контент вкладки «Аудио и
 * видео»: селекторы устройств (enumerateDevices через lib/voice), живой уровень
 * входа и тогглы шумоподавления / Push-to-talk. Локальный isOpen — вне stores/ui.
 */
export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<Tab>('av');
  const mics = useVoiceStore((s) => s.mics);
  const currentMicId = useVoiceStore((s) => s.currentMicId);
  const speakers = useVoiceStore((s) => s.speakers);
  const currentSpeakerId = useVoiceStore((s) => s.currentSpeakerId);
  const cameras = useVoiceStore((s) => s.cameras);
  const currentCamId = useVoiceStore((s) => s.currentCamId);
  const noiseSuppression = useVoiceStore((s) => s.noiseSuppression);
  const pushToTalk = useVoiceStore((s) => s.pushToTalk);
  const [theme, setThemeVal] = useState<Theme>('dark');
  const isDesktop = useDesktopStore((s) => s.isDesktop);
  // Вкладка оболочки — в любом десктоп-клиенте: даже у старого там есть
  // обновления (настройки оболочки внутри гейтятся отдельно, см. AppTab).
  const tabs = TABS.filter((t) => !t.desktopOnly || isDesktop);

  // Отражаем реально применённую тему (её ставит скрипт в <head> до отрисовки).
  useEffect(() => setThemeVal(getTheme()), []);

  // На мобиле вкладки — горизонтальная лента, и выбранная легко оказывается за
  // краем. Подтягиваем её в поле зрения; на десктопе колонка не прокручивается,
  // и вызов ничего не делает.
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    navRef.current
      ?.querySelector('[aria-current="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [tab]);

  function toggleTheme(light: boolean) {
    const next: Theme = light ? 'light' : 'dark';
    setTheme(next);
    setThemeVal(next);
  }

  // При открытии подтягиваем актуальные списки устройств и тогглы из хранилища.
  // Заодно переспрашиваем оболочку: автозапуск могли снять средствами системы,
  // и тумблер обязан показывать факт, а не то, что мы включили когда-то.
  useEffect(() => {
    if (!open) return;
    loadMediaPrefs();
    refreshMics();
    refreshSpeakers();
    refreshCameras();
    requestShellSettings();
  }, [open]);

  async function logout() {
    try {
      const base = process.env.NEXT_PUBLIC_API_URL || '';
      await fetch(`${base}/api/logout`, { method: 'POST', credentials: 'include' });
    } catch {
      /* всё равно уводим на вход — middleware не пустит без валидной куки */
    }
    window.location.replace('/login');
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'flex h-[600px] max-h-[92vh] w-[860px] max-w-[94vw] gap-0 overflow-hidden !p-0',
          // Мобайл: лист во весь экран и колонкой — на 375px колонка навигации в
          // 220px съедала бы две трети ширины, оставляя контенту ~90px.
          'max-md:h-[100dvh] max-md:max-h-none max-md:w-screen max-md:max-w-none',
          'max-md:flex-col max-md:rounded-none max-md:border-0',
        )}
      >
        <DialogTitle className="sr-only">{t('settings.title')}</DialogTitle>

        {/* Левая колонка — навигация; на мобиле это горизонтальная лента вкладок
            сверху (полосу прокрутки прячем — листается пальцем). */}
        <nav
          ref={navRef}
          className={cn(
            'flex w-[220px] shrink-0 flex-col border-r border-line bg-bg-deep/60 p-3',
            'max-md:w-full max-md:flex-row max-md:gap-1 max-md:overflow-x-auto',
            'max-md:border-r-0 max-md:border-b max-md:p-2',
            'max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden',
          )}
        >
          <div className="px-2 pb-2 pt-1 font-mono text-[11px] uppercase tracking-[0.2em] text-text-faint max-md:hidden">
            {t('settings.title')}
          </div>
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              aria-current={tab === item.id}
              className={cn(
                'relative rounded-[8px] px-3 py-2 text-left text-[14px] outline-none transition-colors',
                'max-md:shrink-0 max-md:whitespace-nowrap',
                tab === item.id
                  ? 'text-text-header'
                  : 'text-text-muted hover:bg-bg-hover hover:text-text',
              )}
            >
              {/* Подложка активной вкладки одна на всю группу: общий layoutId —
                  и она переезжает к выбранной, а не мигает на новом месте. */}
              {tab === item.id && (
                <motion.span
                  layoutId="settings-tab"
                  transition={springTab}
                  className="absolute inset-0 rounded-[8px] bg-bg-active"
                />
              )}
              <span className="relative">{t(item.label)}</span>
            </button>
          ))}
          {/* В ленте вкладок подвалу места нет — на мобиле он отдельной строкой внизу. */}
          <div className="mt-auto pt-2 max-md:hidden">
            <SwitchServerButton />
            <button
              type="button"
              onClick={logout}
              className="w-full rounded-[8px] px-3 py-2 text-left text-[14px] text-danger outline-none transition-colors hover:bg-danger/10"
            >
              {t('settings.logout')}
            </button>
          </div>
        </nav>

        {/* Правая колонка — контент вкладки */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-[52px] shrink-0 items-center justify-between border-b border-line px-5 max-md:px-4">
            <h2 className="overflow-hidden text-[15px] font-semibold text-text-header">
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={tab}
                  variants={tabPanel}
                  initial="hidden"
                  animate="show"
                  exit="exit"
                  className="block"
                >
                  {(() => {
                    const current = tabs.find((item) => item.id === tab);
                    return current ? t(current.label) : null;
                  })()}
                </motion.span>
              </AnimatePresence>
            </h2>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label={t('settings.close')}
              className="grid h-7 w-7 place-items-center rounded-[7px] text-lg leading-none text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text-header"
            >
              ×
            </button>
          </div>

          {/* mode="wait": прежний раздел гаснет, затем приезжает новый — иначе
              два разных набора полей встали бы стопкой и дёрнули прокрутку. */}
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={tab}
              variants={tabPanel}
              initial="hidden"
              animate="show"
              exit="exit"
              className="flex-1 overflow-y-auto p-5 max-md:p-4"
            >
              {tab === 'av' ? (
                <div className="flex flex-col gap-5">
                  <DeviceSelect
                    label={t('settings.mic')}
                    value={currentMicId ?? ''}
                    devices={mics}
                    fallback={t('settings.mic.noAccess')}
                    onChange={(id) => void setMic(id)}
                  />
                  <DeviceSelect
                    label={t('settings.camera')}
                    value={currentCamId ?? ''}
                    devices={cameras}
                    fallback={t('settings.camera.noAccess')}
                    onChange={(id) => void setCamera(id)}
                  />
                  <DeviceSelect
                    label={t('settings.output')}
                    value={currentSpeakerId ?? ''}
                    devices={speakers}
                    fallback={t('settings.output.default')}
                    onChange={(id) => void setSpeaker(id)}
                  />
                  <InputLevel active={open && tab === 'av'} />
                  <div className="flex flex-col gap-2.5">
                    <Toggle
                      checked={pushToTalk}
                      onChange={setPushToTalk}
                      title={t('settings.pushToTalk')}
                      hint={t('settings.pushToTalk.hint')}
                    />
                    <Toggle
                      checked={noiseSuppression}
                      onChange={(v) => void setNoiseSuppression(v)}
                      title={t('settings.noiseSuppression')}
                      hint={t('settings.noiseSuppression.hint')}
                    />
                  </div>
                </div>
              ) : tab === 'appearance' ? (
                <div className="flex flex-col gap-5">
                  <LanguageSelect />
                  <Toggle
                    checked={theme === 'light'}
                    onChange={toggleTheme}
                    title={t('settings.lightTheme')}
                    hint={t('settings.lightTheme.hint')}
                  />
                </div>
              ) : tab === 'hotkeys' ? (
                <div className="flex flex-col gap-2.5">
                  <p className="text-[12.5px] leading-relaxed text-text-muted">
                    {t('settings.hotkeys.intro')}
                  </p>
                  {HOTKEY_ACTIONS.map((a) => (
                    <VoiceKeybindRow key={a.id} action={a.id} label={t(a.label)} hint={t(a.hint)} />
                  ))}
                  <PttKeybindRow />
                </div>
              ) : tab === 'app' ? (
                <AppTab />
              ) : (
                <Placeholder>{t('settings.placeholder')}</Placeholder>
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Подвал только для мобилы: на десктопе эти кнопки живут внизу колонки
            навигации. Нижний отступ учитывает домашнюю полоску iPhone. */}
        <div className="hidden shrink-0 border-t border-line bg-bg-deep/60 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] max-md:block">
          <SwitchServerButton />
          <button
            type="button"
            onClick={logout}
            className="w-full rounded-[8px] px-3 py-2 text-left text-[14px] text-danger outline-none transition-colors hover:bg-danger/10"
          >
            {t('settings.logout')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
