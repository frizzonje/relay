import { describe, expect, it, vi } from 'vitest';
import { BackgroundWork } from './background';

/**
 * Учёт работы, которую гейтвей начал и не ждёт.
 *
 * Проверяется без базы намеренно: это учёт обещаний, а не запись, — и цена
 * ошибки видна как раз там, где базы нет в кадре. Стенд тестов гейтвея чистит
 * базу между тестами через TRUNCATE, а TRUNCATE не уживается с чужой записью:
 * начатая и брошенная вставка встречала его взаимной блокировкой (release-images
 * #18 на теге v2.0.0). Отсюда и вся эта механика: работу, которую никто не ждёт,
 * должно быть можно дождаться — и на остановке сервиса, и на стенде.
 */

/** Дать циклу событий обернуться — не «поспать», а пропустить всех вперёд. */
const turn = () => new Promise((r) => setImmediate(r));

function stand() {
  const failures: string[] = [];
  return { bg: new BackgroundWork((what, err) => failures.push(`${what}: ${err}`)), failures };
}

describe('BackgroundWork', () => {
  it('без начатой работы расходится сразу', async () => {
    const { bg } = stand();
    await expect(bg.settled()).resolves.toBeUndefined();
  });

  it('дожидается начатого', async () => {
    const { bg } = stand();
    let release!: () => void;
    bg.run('запись', new Promise<void>((r) => (release = r)));

    let done = false;
    const waiting = bg.settled().then(() => (done = true));
    await turn();
    expect(done).toBe(false);

    release();
    await waiting;
    expect(done).toBe(true);
  });

  it('упавшая работа не роняет ожидание, но о ней говорят', async () => {
    const { bg, failures } = stand();
    bg.run('отметка о пропущенном не записана', Promise.reject(new Error('база молчит')));
    await expect(bg.settled()).resolves.toBeUndefined();
    expect(failures).toEqual(['отметка о пропущенном не записана: Error: база молчит']);
  });

  it('работу, начатую во время ожидания, тоже дожидается', async () => {
    const { bg } = stand();
    const second = vi.fn();
    let release!: () => void;
    const first = new Promise<void>((r) => (release = r));
    bg.run(
      'первая',
      first.then(() =>
        bg.run(
          'вторая',
          turn().then(() => void second()),
        ),
      ),
    );

    const waiting = bg.settled();
    release();
    await waiting;
    expect(second).toHaveBeenCalled();
  });
});
