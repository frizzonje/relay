import type { ClientToServerEvents } from '@relay/shared';
import { getSocket } from '@/lib/socket';

/**
 * Вопрос серверу с ответом — единственная дорога для всех событий с ack.
 *
 * У `socket.emit` с подтверждением своего срока нет вовсе: оборвись сокет
 * посреди вопроса, и ответ не придёт никогда, а ждущий его экран так и
 * останется в «загружается». Поэтому срок есть у каждого вопроса, и живёт он
 * здесь, а не в каждом вызывающем.
 *
 * Срок — встроенный `timeout()` socket.io, а не свой таймер, и это не вкус.
 * Пока сокет лежит, вопрос копится в буфере отправки и уходит на реконнекте.
 * Свой таймер сказал бы «сервер промолчал», а буфер всё равно доставил бы
 * вопрос позже: вызов, брошенный как неудачный, зазвонил бы у собеседника
 * через минуту. `timeout()` по истечении срока вынимает вопрос из буфера.
 *
 * Тип ответа берётся из контракта (`ClientToServerEvents`), а не из вызова:
 * вызывающий не может назвать ответ чужим типом и узнать об этом в рантайме.
 *
 * Мимо этой дороги ходят только команды, ответа на которые никто не ждёт
 * (`call-cancel`, `call-decline`, `dm-join` на реконнекте). Им срок вреден:
 * отбой, отправленный при лежащем сокете, обязан уйти на реконнекте, а не
 * пропасть из буфера через шесть секунд.
 */

/** Сколько ждём ответа. Обычный ответ сервера — миллисекунды. */
export const REQUEST_TIMEOUT_MS = 6000;

type Params<E extends keyof ClientToServerEvents> = Parameters<ClientToServerEvents[E]>;

/** Ответ сервера на событие — аргумент колбэка, последнего параметра. */
export type ReplyOf<E extends keyof ClientToServerEvents> =
  Params<E> extends [...unknown[], (res: infer R) => void] ? R : never;

/** Аргументы события без колбэка. */
type ArgsOf<E extends keyof ClientToServerEvents> =
  Params<E> extends [...infer A, (res: never) => void] ? A : never;

/** События, на которые сервер отвечает. */
export type AskedEvent = {
  [E in keyof ClientToServerEvents]: [ReplyOf<E>] extends [never] ? never : E;
}[keyof ClientToServerEvents];

/** Спросить с обычным сроком. `null` — ответа не дождались. */
export function request<E extends AskedEvent>(
  event: E,
  ...args: ArgsOf<E>
): Promise<ReplyOf<E> | null> {
  return requestWithin(REQUEST_TIMEOUT_MS, event, ...args);
}

/**
 * Спросить со своим сроком — для вопросов, ответ на которые нужен быстрее
 * обычного (пропуск в медиасервер ждёт человек, стоящий на входе в канал).
 */
export function requestWithin<E extends AskedEvent>(
  ms: number,
  event: E,
  ...args: ArgsOf<E>
): Promise<ReplyOf<E> | null> {
  return new Promise((resolve) => {
    // Перегрузки `emit` у socket.io сужены по имени события, а здесь имя —
    // параметр: связь «событие → аргументы → ответ» уже проверена сигнатурой.
    const timed = getSocket().timeout(ms);
    const emit = timed.emit as (event: string, ...rest: unknown[]) => void;
    emit.call(timed, event, ...args, (err: Error | null, res: ReplyOf<E>) =>
      resolve(err ? null : res),
    );
  });
}
