/** Шпион `emit` из теста: подтверждение, если оно есть, — последний аргумент. */
type Emit = (event: string, ...args: never[]) => unknown;

/**
 * `timeout(ms)` socket.io поверх подделки `emit` — для тестов того, что ходит
 * через `request` (lib/request.ts).
 *
 * Шпион видит вызов в прежнем виде, с колбэком последним аргументом, и тест
 * отвечает за сервер тем же `cb(res)`. Наружу ответ уходит так, как его отдаёт
 * настоящий `timeout()`: `(null, res)` — сервер ответил, `(err)` — срок вышел.
 * Срок идёт обычным `setTimeout`, так что фейковые таймеры vitest им управляют.
 */
export function timeoutOf(emit: Emit) {
  return (ms: number) => ({
    emit(event: string, ...args: unknown[]) {
      const reply = args.pop() as (err: Error | null, res?: unknown) => void;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reply(new Error('operation has timed out'));
      }, ms);
      const answer = (res: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reply(null, res);
      };
      (emit as (event: string, ...rest: unknown[]) => unknown)(event, ...args, answer);
    },
  });
}

/**
 * `timeout(ms)` из ответчика-промиса — для тестов, которым важно, ЧТО ответил
 * сервер, а не когда: отказ промиса приезжает так же, как истёкший срок.
 */
export function answeringWith(answer: (event: string, ...args: never[]) => Promise<unknown>) {
  return () => ({
    emit(event: string, ...args: unknown[]) {
      const reply = args.pop() as (err: Error | null, res?: unknown) => void;
      (answer as (event: string, ...rest: unknown[]) => Promise<unknown>)(event, ...args).then(
        (res) => reply(null, res),
        (err: Error) => reply(err),
      );
    },
  });
}
