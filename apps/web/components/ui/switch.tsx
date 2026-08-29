'use client';

import { cn } from '@/lib/utils';

/**
 * Переключатель «вкл/выкл» — только сам движок, без строки вокруг него.
 *
 * Выделен из личных настроек (`SettingsDialog`) ради панели владельца: строки
 * там свои (под полем ещё живут «когда подействует», отказ и «сохраняется»), а
 * вот сам движок обязан быть тем же самым. Два похожих переключателя в одном
 * приложении расходятся молча — сперва на два пикселя, потом на цвет.
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  /** Название для диктора: сам движок никакого текста не несёт. */
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : () => onChange(!checked)}
      className={cn(
        'relative h-6 w-11 shrink-0 rounded-full transition-colors',
        checked ? 'bg-ok' : 'bg-line-strong',
        disabled && 'opacity-50',
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
  );
}
