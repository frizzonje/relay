'use client';

import { toast } from 'sonner';
import { tx } from '@/lib/i18n';
import { useUiStore } from '@/stores/ui';

/**
 * Свежесть бандла: сервер обновился, а открытая страница — нет.
 *
 * Браузер и десктоп-оболочка держат код, скачанный при открытии окна, сколько
 * угодно долго: переподключение сокета его не меняет, а оболочка из трея не
 * перезагружается вовсе. Так 2026-10-04 клиент на Windows неделю показывал
 * трансляцию по-старому — без настроек и без «Смотреть», — хотя сервер давно
 * отдавал новое. Версия контракта (`PROTOCOL_VERSION`) этого не ловит: она
 * поднимается только с мажором, а сборки меняются каждый день.
 *
 * Поэтому страница помнит, с какой сборки она загружена (`<meta
 * name="relay-build">`), и время от времени спрашивает сервер, какая у него
 * сейчас (`/version.json`). Разошлись — пора обновиться:
 *   - в звонке — не трогаем, звонок важнее; обновимся, когда он кончится;
 *   - окно скрыто (свёрнуто, в трее) — перезагружаемся сразу, никто не
 *     заметит;
 *   - окно перед глазами — предлагаем кнопкой и перезагружаемся, как только
 *     окно уйдёт с глаз. Молча перезагрузить страницу, в которой человек
 *     печатает, — значит отнять у него набранное.
 */

const CHECK_EVERY_MS = 10 * 60_000;
// Вернулся к окну — проверим, но не чаще раза в минуту.
const FOCUS_GAP_MS = 60_000;
// Сервер обновляется целиком: api встаёт раньше веба, и сокет переподключается
// к новому api, пока веб ещё старый. Спрашиваем дважды.
const AFTER_RECONNECT_MS = [3_000, 45_000];
// Ради какой сборки уже перезагружались: если после перезагрузки сервер всё
// ещё называет её, а страница загрузилась другой (два веба за балансером,
// кэш по дороге), второй раз не крутим — иначе вечная перезагрузка.
const RELOADED_FOR_KEY = 'relay-reloaded-for';

function loadedBuild(): string | null {
  const meta = document.querySelector('meta[name="relay-build"]');
  return meta?.getAttribute('content') || null;
}

async function serverBuild(): Promise<string | null> {
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as { build?: unknown };
    return typeof body.build === 'string' && body.build ? body.build : null;
  } catch {
    return null; // сервер перезапускается — спросим позже
  }
}

function reloadedFor(): string | null {
  try {
    return sessionStorage.getItem(RELOADED_FOR_KEY);
  } catch {
    return null;
  }
}

/** Следить за свежестью. Возвращает отписку. `reload` подменяют только тесты. */
export function initFreshness(
  socket: {
    on(event: 'connect', fn: () => void): unknown;
    off(event: 'connect', fn: () => void): unknown;
  },
  { reload: doReload = () => window.location.reload() } = {},
): () => void {
  const mine = loadedBuild();
  // Dev-сервер и страница без отметки: сравнивать не с чем.
  if (!mine || mine === 'dev') return () => {};

  let target: string | null = null; // сборка сервера, на которую пора
  let offered = false;
  let lastCheck = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  function reload() {
    try {
      if (target) sessionStorage.setItem(RELOADED_FOR_KEY, target);
    } catch {
      /* без хранилища защита от петли слабее, но перезагрузка нужнее */
    }
    doReload();
  }

  /** Решить, что делать с найденным обновлением прямо сейчас. */
  function settle() {
    if (!target) return;
    if (useUiStore.getState().voiceRoom) return; // в звонке — ждём его конца
    if (document.visibilityState === 'hidden') {
      reload();
      return;
    }
    if (offered) return;
    offered = true;
    toast(tx('update.ready'), {
      id: 'relay-update',
      duration: Infinity,
      action: { label: tx('update.reload'), onClick: reload },
    });
  }

  async function check() {
    if (target) return;
    lastCheck = Date.now();
    const theirs = await serverBuild();
    if (!theirs || theirs === mine || theirs === reloadedFor()) return;
    target = theirs;
    settle();
  }

  function later(ms: number) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      void check();
    }, ms);
    timers.add(timer);
  }

  // На первом connect (загрузка страницы) спросим впустую — это дешевле, чем
  // гадать, успел ли сокет подключиться до нас.
  const onConnect = () => AFTER_RECONNECT_MS.forEach(later);
  const onVisible = () => {
    if (document.visibilityState === 'hidden') settle();
    else if (Date.now() - lastCheck >= FOCUS_GAP_MS) void check();
  };
  const interval = setInterval(() => void check(), CHECK_EVERY_MS);
  // Звонок кончился — самое время.
  const unsubscribe = useUiStore.subscribe((state, prev) => {
    if (prev.voiceRoom && !state.voiceRoom) settle();
  });

  socket.on('connect', onConnect);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);

  return () => {
    socket.off('connect', onConnect);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('focus', onVisible);
    clearInterval(interval);
    timers.forEach(clearTimeout);
    unsubscribe();
  };
}
