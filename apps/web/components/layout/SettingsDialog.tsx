'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { checkForUpdates, installUpdate, switchServer } from '@/lib/desktop';
import { getTheme, setTheme, type Theme } from '@/lib/theme';
import { useDesktopStore } from '@/stores/desktop';
import { useVoiceStore } from '@/stores/voice';
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

type Tab = 'av' | 'appearance' | 'notifications' | 'account';

const TABS: { id: Tab; label: string }[] = [
  { id: 'av', label: 'Аудио и видео' },
  { id: 'appearance', label: 'Внешний вид' },
  { id: 'notifications', label: 'Уведомления' },
  { id: 'account', label: 'Аккаунт' },
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

/** Селектор устройства: стилизованный native <select> с шевроном. */
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
          {devices.length === 0 && <option value="">{fallback}</option>}
          {devices.map((d, i) => (
            <option key={d.deviceId || i} value={d.deviceId}>
              {d.label || `${label} ${i + 1}`}
            </option>
          ))}
        </select>
        <Chevron />
      </div>
    </label>
  );
}

/** Живой уровень входного сигнала микрофона — заполняющаяся полоса (rAF). */
function InputLevel({ active }: { active: boolean }) {
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
        Уровень входа
      </span>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-black/45">
        <div ref={fillRef} className="h-full w-0 rounded-full bg-ok transition-none" />
      </div>
      <p className="mt-1.5 text-[12px] text-text-muted">
        Полоса оживает во время звонка — скажите что-нибудь.
      </p>
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

function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-full place-items-center px-6 text-center font-mono text-[12px] uppercase tracking-[0.18em] text-text-faint">
      {children}
    </div>
  );
}

/**
 * Обновления десктоп-клиента. Рендерится только в Tauri-оболочке (isDesktop).
 * Приложение само ничего не ставит — здесь ручная проверка и установка по клику
 * (событие в Rust, см. lib/desktop.ts). Когда апдейт найден — кнопка меняется на
 * «Установить и перезапустить».
 */
function UpdateBlock() {
  const isDesktop = useDesktopStore((s) => s.isDesktop);
  const update = useDesktopStore((s) => s.update);
  if (!isDesktop) return null;

  const busy = update.kind === 'checking' || update.kind === 'installing';
  const status =
    update.kind === 'checking'
      ? 'Проверяю…'
      : update.kind === 'up-to-date'
        ? 'Установлена последняя версия'
        : update.kind === 'available'
          ? `Доступна версия ${update.version}`
          : update.kind === 'installing'
            ? `Устанавливаю ${update.version}…`
            : update.kind === 'error'
              ? 'Не удалось проверить обновления'
              : null;

  return (
    <div className="mb-1 border-t border-line pt-2">
      {update.kind === 'available' ? (
        <button
          type="button"
          onClick={installUpdate}
          className="w-full rounded-[8px] bg-ok/15 px-3 py-2 text-left text-[13px] font-medium text-ok outline-none transition-colors hover:bg-ok/25"
        >
          Установить и перезапустить
        </button>
      ) : (
        <button
          type="button"
          onClick={checkForUpdates}
          disabled={busy}
          className="w-full rounded-[8px] px-3 py-2 text-left text-[14px] text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
        >
          Проверить обновления
        </button>
      )}
      {status && <p className="px-3 pt-1 text-[11px] text-text-faint">{status}</p>}
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
  const isDesktop = useDesktopStore((s) => s.isDesktop);
  if (!isDesktop) return null;
  return (
    <button
      type="button"
      onClick={switchServer}
      className="w-full rounded-[8px] px-3 py-2 text-left text-[14px] text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text"
    >
      Сменить сервер
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

  // Отражаем реально применённую тему (её ставит скрипт в <head> до отрисовки).
  useEffect(() => setThemeVal(getTheme()), []);

  function toggleTheme(light: boolean) {
    const next: Theme = light ? 'light' : 'dark';
    setTheme(next);
    setThemeVal(next);
  }

  // При открытии подтягиваем актуальные списки устройств и тогглы из хранилища.
  useEffect(() => {
    if (!open) return;
    loadMediaPrefs();
    refreshMics();
    refreshSpeakers();
    refreshCameras();
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
      <DialogContent className="flex h-[600px] max-h-[92vh] w-[860px] max-w-[94vw] gap-0 overflow-hidden !p-0">
        <DialogTitle className="sr-only">Настройки</DialogTitle>

        {/* Левая колонка — навигация */}
        <nav className="flex w-[220px] shrink-0 flex-col border-r border-line bg-bg-deep/60 p-3">
          <div className="px-2 pb-2 pt-1 font-mono text-[11px] uppercase tracking-[0.2em] text-text-faint">
            Настройки
          </div>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id}
              className={cn(
                'rounded-[8px] px-3 py-2 text-left text-[14px] outline-none transition-colors',
                tab === t.id
                  ? 'bg-bg-active text-text-header'
                  : 'text-text-muted hover:bg-bg-hover hover:text-text',
              )}
            >
              {t.label}
            </button>
          ))}
          <div className="mt-auto pt-2">
            <UpdateBlock />
            <SwitchServerButton />
            <button
              type="button"
              onClick={logout}
              className="w-full rounded-[8px] px-3 py-2 text-left text-[14px] text-danger outline-none transition-colors hover:bg-danger/10"
            >
              Выйти из аккаунта
            </button>
          </div>
        </nav>

        {/* Правая колонка — контент вкладки */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-[52px] shrink-0 items-center justify-between border-b border-line px-5">
            <h2 className="text-[15px] font-semibold text-text-header">
              {TABS.find((t) => t.id === tab)?.label}
            </h2>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label="Закрыть настройки"
              className="grid h-7 w-7 place-items-center rounded-[7px] text-lg leading-none text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text-header"
            >
              ×
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-5">
            {tab === 'av' ? (
              <div className="flex flex-col gap-5">
                <DeviceSelect
                  label="Микрофон"
                  value={currentMicId ?? ''}
                  devices={mics}
                  fallback="Дайте доступ к микрофону"
                  onChange={(id) => void setMic(id)}
                />
                <DeviceSelect
                  label="Камера"
                  value={currentCamId ?? ''}
                  devices={cameras}
                  fallback="Дайте доступ к камере"
                  onChange={(id) => void setCamera(id)}
                />
                <DeviceSelect
                  label="Устройство вывода"
                  value={currentSpeakerId ?? ''}
                  devices={speakers}
                  fallback="Системное по умолчанию"
                  onChange={(id) => void setSpeaker(id)}
                />
                <InputLevel active={open && tab === 'av'} />
                <div className="flex flex-col gap-2.5">
                  <Toggle
                    checked={pushToTalk}
                    onChange={setPushToTalk}
                    title="Push-to-talk"
                    hint="Микрофон открыт, только пока удерживаете пробел."
                  />
                  <Toggle
                    checked={noiseSuppression}
                    onChange={(v) => void setNoiseSuppression(v)}
                    title="Шумоподавление"
                    hint="Убирает фоновый шум с вашего микрофона."
                  />
                </div>
              </div>
            ) : tab === 'appearance' ? (
              <div className="flex flex-col gap-2.5">
                <Toggle
                  checked={theme === 'light'}
                  onChange={toggleTheme}
                  title="Светлая тема"
                  hint="Переключить оформление между тёмным и светлым."
                />
              </div>
            ) : (
              <Placeholder>раздел появится позже</Placeholder>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
