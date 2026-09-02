import { create } from 'zustand';
import type { PresenceEntry, PresenceState } from '@relay/shared';

/**
 * Где люди сейчас — на всю инсталляцию, а не в этом канале (тем и отличается от
 * `voice-presence` в stores/voice.ts: та отвечает «кто в этой комнате», эта —
 * «где вообще этот человек»). Питается двумя событиями гейтвея (протокол §4.1):
 *
 *  • `presence` — полный снимок на подключении. Заменяет карту целиком:
 *    частичного снимка не бывает, и слить его с прежней картиной значило бы
 *    хранить чужие устаревшие записи вечно (снимок никогда не перечисляет
 *    `offline` — см. ниже).
 *  • `presence-update` — дельта, только то, что изменилось, пачкой (сервер
 *    коалесцирует окном 80 мс). Правит ровно упомянутые записи и не трогает
 *    остальные: расписание дельты — это то, чем отличаются `applySnapshot` и
 *    `applyDelta`, и перепутать их значило бы гасить всех, кроме того, кто
 *    изменился.
 *
 * `people` — по отпечатку ключа, а не по нику (ники не уникальны) и не по
 * socket-id (одна личность держит несколько устройств и сокетов сразу).
 * Отсутствие записи — тоже сигнал, а не дыра: сервер не хранит `offline`
 * россыпью (иначе карта росла бы на каждого, кто когда-либо заходил), поэтому
 * «эту личность никто не видел» и «эта личность явно офлайн» неразличимы на
 * входе и должны читаться одинаково. Отсюда `presenceOf` вместо прямого
 * доступа к `people[fingerprint]`: только через него неизвестный отпечаток
 * гарантированно превращается в `offline`, а не в `undefined`, из которого
 * компонент вывел бы либо пустоту, либо (что хуже) молча упал.
 *
 * `recent` угасает в `offline` и по времени клиента, а не только по приходу
 * `presence-update`. Сервер сам присылает эту дельту через `RECENT_MS` (см.
 * apps/api/src/gateway/presence.ts), но клиент, который переподключился
 * посреди окна или проспал его в фоновой вкладке, мог это событие пропустить
 * мимо ушей — а без подстраховки здесь «недавно» осталось бы гореть до
 * следующего чужого события, то есть как повезёт. `RECENT_MS` продублирован
 * константой, а не импортирован: `packages/shared` описывает только форму
 * события (см. `PresenceEntry`), а не серверные тайминги — ровно та же
 * граница, что api намеренно держит между собой и веб-пакетом (см.
 * комментарий у `PresenceState` в apps/api/src/gateway/presence.ts).
 */
export const RECENT_MS = 120_000;

interface PresenceStoreState {
  /** Разосланная картина: отпечаток → последняя известная запись. */
  people: Record<string, PresenceEntry>;
  /** Снимок с сервера (`presence`) — заменяет карту целиком. */
  applySnapshot: (people: PresenceEntry[]) => void;
  /** Дельта (`presence-update`) — правит только упомянутые записи. */
  applyDelta: (changed: PresenceEntry[]) => void;
  /** Переподключение/выход из инсталляции: прежняя картина не наша. */
  reset: () => void;
}

export const usePresenceStore = create<PresenceStoreState>((set) => ({
  people: {},

  applySnapshot: (people) => {
    const map: Record<string, PresenceEntry> = {};
    for (const entry of people) map[entry.fingerprint] = entry;
    set({ people: map });
  },

  applyDelta: (changed) =>
    set((s) => {
      if (!changed.length) return s;
      const people = { ...s.people };
      for (const entry of changed) people[entry.fingerprint] = entry;
      return { people };
    }),

  reset: () => set({ people: {} }),
}));

/**
 * Действующее состояние личности — снимок карты плюс угасание «недавно» по
 * времени (см. док-комментарий выше). Единственный путь читать присутствие:
 * неизвестный отпечаток и протухшее «недавно» здесь превращаются в один и тот
 * же честный ответ — `offline`, — а не в дыру, которую каждому месту показа
 * пришлось бы затыкать по-своему.
 *
 * `since` неизвестного человека — `0`, а не `now`: у него нет своей истории, и
 * подсовывать текущий момент значило бы утверждать «стал офлайн только что» о
 * том, о ком мы вообще ничего не знаем.
 */
export function presenceOf(
  people: Record<string, PresenceEntry>,
  fingerprint: string,
  now: number = Date.now(),
): PresenceEntry {
  const entry = people[fingerprint];
  if (!entry) return { fingerprint, state: 'offline', since: 0 };
  if (entry.state === 'recent' && now - entry.since >= RECENT_MS) {
    return { fingerprint, state: 'offline', since: entry.since };
  }
  return entry;
}

/** То же самое, но как React-хук: перечитывает карту при каждом её изменении. */
export function usePresence(fingerprint: string): PresenceState {
  return usePresenceStore((s) => presenceOf(s.people, fingerprint).state);
}

/**
 * Ключ перевода для состояния — одна карта на весь веб. И точка (PresenceDot),
 * и текстовые статусы рядом с ней (шапка беседы, карточка собеседника) обязаны
 * называть одно и то же состояние одним и тем же словом; разведи эту карту по
 * компонентам — и текст с точкой разошлись бы при первой же правке одного из
 * них.
 */
export const PRESENCE_LABEL_KEY = {
  online: 'presence.online',
  'in-voice': 'presence.inVoice',
  recent: 'presence.recent',
  offline: 'presence.offline',
} as const satisfies Record<PresenceState, string>;
