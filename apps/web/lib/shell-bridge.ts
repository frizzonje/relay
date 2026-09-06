/**
 * Связь с нативной оболочкой — одна на две реализации.
 *
 * Оболочек у relay две, и это не дублирование, а следствие движков:
 *   • Windows и macOS — Tauri v2 (`clients/desktop`), мост живёт в
 *     `window.__TAURI__.event`;
 *   • Linux — Electron (`clients/desktop-linux`), мост живёт в
 *     `window.__RELAY_SHELL__`. Он там потому, что системный WebKitGTK, который
 *     берёт Tauri, собран без WebRTC — звонков в нём нет и не будет
 *     (см. lib/voice-support.ts и clients/desktop-linux/README.md).
 *
 * Веб-UI об этой разнице знать не должен: имена событий, payload'ы и форма
 * вызовов у обеих оболочек одинаковые (listen → Promise<unlisten>, handler
 * получает `{ payload }`, emit → Promise, который ОТКЛОНЯЕТСЯ при отказе).
 * Поэтому весь остальной код спрашивает мост здесь и больше нигде не трогает
 * ни `__TAURI__`, ни `__RELAY_SHELL__`.
 */

/** События оболочки в том объёме, в каком они нужны web-UI. */
export interface ShellBridge {
  listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void>;
  emit(event: string, payload?: unknown): Promise<void>;
}

/** Какая оболочка вокруг нас; null — обычный браузер. */
export type ShellKind = 'tauri' | 'electron';

declare global {
  interface Window {
    __TAURI__?: { event: ShellBridge };
    __RELAY_SHELL__?: ShellBridge & { kind?: string };
  }
}

/** Мост к оболочке или null, если мы в обычном браузере. */
export function shellBridge(): ShellBridge | null {
  if (typeof window === 'undefined') return null;
  return window.__TAURI__?.event ?? window.__RELAY_SHELL__ ?? null;
}

/** Мы внутри нативной оболочки? */
export function inShell(): boolean {
  return shellBridge() !== null;
}

/**
 * Отправить событие оболочке, не проглотив отказ. Вне оболочки — тишина: в
 * обычном браузере посылать некуда, и это не ошибка.
 *
 * Оболочка вправе отказать: у Tauri origin может не подойти под
 * capabilities/remote.json, у Electron события нет в списке моста
 * (clients/desktop-linux/src/events.js). `void emit(...)` делал это молча, и
 * снаружи выглядело так, будто оболочка просто ничего не умеет: нативные
 * настройки не появляются, ошибки нет. Теперь причина видна в консоли.
 *
 * Живёт здесь, а не в `lib/desktop.ts`, потому что говорить с оболочкой умеет
 * не только он: `lib/notify.ts` зовёт мост о входящем звонке (см.
 * `shellRingStart`/`shellRingStop` ниже — по той же причине они тоже здесь, а
 * не в `desktop.ts`), а тащить ради этого весь граф `desktop.ts` (голос,
 * сокет, сторы) в модуль, который импортирует половина чата, — плохой размен.
 */
export function shellSend(event: string, payload?: unknown) {
  const ev = shellBridge();
  if (!ev) return;
  // Без payload'а зовём emit одним аргументом: у события-запроса (например
  // `desktop-settings-get`) payload'а нет вовсе, и подсовывать undefined незачем.
  const sent = payload === undefined ? ev.emit(event) : ev.emit(event, payload);
  sent.catch((err: unknown) => {
    console.error(`[shell] оболочка отклонила событие «${event}»:`, err);
  });
}

/** Кто и как звонит — то, что оболочке нужно знать о входящем вызове. */
export interface ShellRing {
  /** Имя звонящего: заголовок системного окошка. */
  nick: string;
  /** Видеозвонок — сказано ДО ответа, как и в тосте (см. `IncomingToast`). */
  video: boolean;
  /**
   * Показать системное окошко — решение уже принято за оболочку, и это
   * намеренно: иначе его принимали бы двое (вкладка и оболочка) независимо, и
   * на десктопе об одном звонке приходило бы два уведомления. Правило одно на
   * всех и живёт в `lib/notify.ts`: окно свёрнуто и окошки разрешены
   * настройкой `notifications.desktopEnabled`.
   */
  notify: boolean;
}

/**
 * Входящий вызов — оболочке (задача 9 плана B). Она умеет то, чего вкладка не
 * может: поднять своё окно поверх всего, написать «входящий вызов» в трее и
 * показать системное окошко там, где у движка нет `Notification` API (macOS
 * WKWebView).
 *
 * Живут здесь же, а не в `lib/desktop.ts`: это ровно те две функции моста,
 * которые зовёт `lib/notify.ts` (см. комментарий `shellSend` выше про то,
 * почему notify.ts не должен тянуть граф `desktop.ts` целиком). Сам
 * `lib/desktop.ts` тоже зовёт `shellRingStop` — при старте моста, чтобы
 * перезагруженная посреди звонка страница не оставила трей звонящим вечно
 * (см. его `initDesktopBridge`), — но уже как обычный потребитель этого
 * модуля, а не как хозяин функции.
 */
export function shellRingStart(ring: ShellRing) {
  shellSend('call-ringing', { ringing: true, ...ring });
}

/**
 * Вызов кончился — чем угодно (принят, отклонён, отбой, не ответили, обрыв
 * сокета). То же событие, а не своё собственное: трей обязан вернуться к
 * обычному статусу на ЛЮБОМ исходе, а два события однажды разъехались бы —
 * одно послали, второе забыли, и в трее навсегда остался бы звонок.
 */
export function shellRingStop() {
  shellSend('call-ringing', { ringing: false });
}

/**
 * Какая именно оболочка. Нужно там, где поведение зависит от движка, а не от
 * самого факта оболочки, — например в диагностике «почему нет звонков».
 */
export function shellKind(): ShellKind | null {
  if (typeof window === 'undefined') return null;
  if (window.__TAURI__?.event) return 'tauri';
  if (window.__RELAY_SHELL__) return 'electron';
  return null;
}
