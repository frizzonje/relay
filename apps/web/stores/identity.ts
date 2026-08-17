import { create } from 'zustand';
import {
  LoginError,
  proveIdentity,
  renameIdentity,
  whoAmI,
  type Identity,
  type LoginFailure,
} from '@/lib/identity-login';
import { SignerError } from '@/lib/signer';
import { getSocket } from '@/lib/socket';
import { useUiStore } from './ui';

/**
 * Личность этого клиента — кто мы для сервера и как это выяснилось.
 *
 * Порядок восстановления один и тот же на любом заходе, и спрашивать в нём
 * человека не о чем:
 *
 *   1. `me` — сессия жива, мы уже узнаны;
 *   2. иначе доказать ключом (родив его, если ключа ещё нет);
 *   3. если сервер сказал, что личность родилась прямо сейчас, — попросить имя.
 *
 * Ключевое здесь третье: «первый ли это вход» решает сервер своим `created`, а
 * не клиент по метке в хранилище. Метка врёт при любом расхождении — очищенном
 * хранилище, втором браузере, переезде на другой сервер, — и врёт молча.
 *
 * Имя спрашивается ПОСЛЕ входа, а не до: личность — это ключ, а имя всего лишь
 * подпись к нему. Закрой человек окно на этом шаге — он останется собой, просто
 * с именем в виде куска отпечатка, и сменит его в панели, когда захочет.
 */

export type IdentityStatus =
  /** Выясняем. Показывать нечего: экран за диалогом уже нарисован. */
  | 'checking'
  /** Личность есть, имени она ещё не выбрала. */
  | 'naming'
  | 'in'
  /** Не вышло, и без человека дальше никак. Что именно — в `failure`. */
  | 'failed';

interface IdentityState {
  status: IdentityStatus;
  me: Identity | null;
  failure: LoginFailure | null;
  /** Узнать себя. Повторные вызовы подхватывают уже идущую попытку. */
  restore: () => Promise<void>;
  /** Назваться на первом входе. `false` — не сохранилось, экран остаётся. */
  name: (nick: string) => Promise<boolean>;
  /** Сменить имя потом. `false` — сервер не принял, показывать нечего. */
  rename: (nick: string) => Promise<boolean>;
}

/** Ошибка любого происхождения → причина, у которой есть свой экран. */
function failureOf(err: unknown): LoginFailure {
  if (err instanceof LoginError) return err.failure;
  if (err instanceof SignerError) return { kind: 'signer', error: err };
  // Сюда попадает и обрыв сети: fetch отвергает промис, а не отдаёт ответ.
  return { kind: 'network' };
}

/**
 * Беда, после которой человеку есть что делать руками (сходить на `/login`,
 * связать устройство, сменить браузер), — против той, что чинится повтором.
 * Первая занимает весь экран, вторая остаётся строчкой под полем ввода.
 */
function fatal(failure: LoginFailure): boolean {
  return failure.kind !== 'network';
}

// Восстановление идёт одно на клиент: эффекты React в строгом режиме зовут его
// дважды, и вторая попытка успела бы выпросить второй нонс и завести вторую
// сессию тому же ключу.
let inFlight: Promise<void> | null = null;

export const useIdentityStore = create<IdentityState>((set, get) => {
  /**
   * Принять себя. Ник заодно едет в UI-стор: сокет, чат и состав канала знают
   * человека по `callsign`, и заводить им второй источник имени — значит
   * однажды разойтись с ним.
   */
  function adopt(me: Identity, status: IdentityStatus): void {
    set({ me, status, failure: null });
    useUiStore.getState().setCallsign(me.nick);
  }

  /**
   * Сказать гейтвею, что имя изменилось. Имя живёт у личности и меняется
   * обычным HTTP, а сокет знает то, что было при подключении, — и без этого
   * пинка первые реплики только что назвавшегося человека подписаны его
   * автоником (куском отпечатка), хотя в базе он уже Аня.
   *
   * Имя в теле сервер у личности не спрашивает — он перечитывает его сам, — но
   * поле остаётся частью события: им же зовут себя те, у кого личности нет.
   * Повтор безвреден: из панели то же событие шлёт `renameSelf` (ему нужно ещё
   * и подписать свою плитку), и второй такой же rename не делает ничего.
   */
  function tellGateway(nick: string): void {
    try {
      const socket = getSocket();
      if (socket.connected) socket.emit('rename', { name: nick });
    } catch {
      // Сокета может не быть вовсе (тесты, серверный рендер) — не повод падать.
    }
  }

  return {
    status: 'checking',
    me: null,
    failure: null,

    restore: () => {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        set({ status: 'checking', failure: null });
        try {
          const known = await whoAmI();
          const me = known ?? (await proveIdentity());
          adopt(me, me.created ? 'naming' : 'in');
        } catch (err) {
          set({ status: 'failed', failure: failureOf(err) });
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },

    name: async (nick) => {
      const me = get().me;
      if (!me) return false;
      try {
        const named = await renameIdentity(nick);
        adopt({ ...me, nick: named }, 'in');
        tellGateway(named);
        return true;
      } catch (err) {
        const failure = failureOf(err);
        set({ failure, status: fatal(failure) ? 'failed' : 'naming' });
        return false;
      }
    },

    rename: async (nick) => {
      const me = get().me;
      if (!me) return false;
      try {
        const named = await renameIdentity(nick);
        adopt({ ...me, nick: named }, get().status);
        tellGateway(named);
        return true;
      } catch {
        // Экран не трогаем: смена имени — не вход, и терять из-за неё сессию
        // человеку незачем. Ответ `false` возвращает поле к прежнему имени —
        // это и есть сообщение «не сохранилось», и другого не нужно.
        return false;
      }
    },
  };
});

/** Отпечаток своего ключа — короткий доступ для мест, где личности может не быть. */
export function myFingerprint(): string {
  return useIdentityStore.getState().me?.fingerprint ?? '';
}
