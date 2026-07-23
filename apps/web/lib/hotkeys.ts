'use client';

import { toggleMic, toggleSpeakers, leaveVoice } from '@/lib/voice';
import { useUiStore } from '@/stores/ui';
import { useHotkeysStore, type HotkeyAction } from '@/stores/hotkeys';

/**
 * Глобальные горячие клавиши голосового канала. Привязки задаёт пользователь в
 * настройках (по умолчанию пусто — всё выключено). Комбинацию кодируем как
 * `Ctrl+Alt+Shift+Meta+<code>` в фиксированном порядке: `event.code` не зависит
 * от раскладки, так что «M» сработает и на кириллице. Действуем только когда ты
 * в голосовом канале и фокус не в поле ввода (иначе воровали бы набор).
 */

const BARE_MODIFIERS = new Set([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
]);

/** Комбинация из события; null — нажат один голый модификатор (ждём основную клавишу). */
export function eventToCombo(e: KeyboardEvent): string | null {
  if (BARE_MODIFIERS.has(e.code)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  parts.push(e.code);
  return parts.join('+');
}

const SPECIAL: Record<string, string> = {
  Meta: '⌘',
  Space: 'Space',
  Escape: 'Esc',
  Enter: 'Enter',
  Backspace: '⌫',
  Tab: 'Tab',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

function prettyKey(k: string): string {
  if (k.startsWith('Key')) return k.slice(3);
  if (k.startsWith('Digit')) return k.slice(5);
  if (k.startsWith('Numpad')) return 'Num ' + k.slice(6);
  return SPECIAL[k] ?? k;
}

/** Человекочитаемая подпись комбинации, напр. «Ctrl + Shift + M». */
export function comboLabel(combo: string): string {
  return combo.split('+').map(prettyKey).join(' + ');
}

function isTextTarget(): boolean {
  const el = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function run(action: HotkeyAction) {
  if (action === 'muteMic') toggleMic();
  else if (action === 'deafen') toggleSpeakers();
  else if (action === 'leaveVoice') leaveVoice();
}

let inited = false;

/** Навесить глобальный обработчик горячих клавиш (один раз на приложение). */
export function initHotkeys() {
  if (inited || typeof window === 'undefined') return;
  inited = true;
  window.addEventListener('keydown', (e) => {
    if (e.repeat || isTextTarget()) return;
    const combo = eventToCombo(e);
    if (!combo) return;
    const binds = useHotkeysStore.getState().binds;
    const action = (Object.keys(binds) as HotkeyAction[]).find((a) => binds[a] === combo);
    if (!action) return;
    // Горячие клавиши канала действуют только пока ты в нём.
    if (!useUiStore.getState().voiceRoom) return;
    e.preventDefault();
    run(action);
  });
}
