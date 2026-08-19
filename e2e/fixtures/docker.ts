import fs from 'node:fs';
import http from 'node:http';

/**
 * Управление контейнерами стенда прямо из спека — ради одной-единственной
 * проверки, которую иначе не поставить: что падение медиасервера роняет канал
 * в прямые звонки, а не в тишину. Уронить его снаружи нечем — момент знает
 * только сам тест, посреди живого разговора.
 *
 * Ходим в docker по его сокету, а не через CLI: в образе Playwright docker'а
 * нет, а сокет пробрасывается одной строкой (`-v /var/run/docker.sock:...`).
 * Не проброшен — спек пропускается, как и всё остальное, чего стенду не выдали.
 */
const SOCKET = '/var/run/docker.sock';

export const dockerReachable = (): boolean => fs.existsSync(SOCKET);

/** Имя контейнера медиасервера: зависит от имени проекта compose. */
export const SFU_CONTAINER = process.env.E2E_SFU_CONTAINER || 'relay-sfu-e2e-1';

function ask(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCKET, path, method: 'POST' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Остановить контейнер. `t=0` — сразу SIGKILL: нам нужен обрыв, а не прощание. */
export const stopContainer = (name: string): Promise<number> =>
  ask(`/containers/${encodeURIComponent(name)}/stop?t=0`);

export const startContainer = (name: string): Promise<number> =>
  ask(`/containers/${encodeURIComponent(name)}/start`);

/** Имя контейнера api: тоже зависит от имени проекта compose. */
export const API_CONTAINER = process.env.E2E_API_CONTAINER || 'relay-api-1';

/**
 * Перезапустить контейнер. Возвращается, когда docker его поднял, — а не когда
 * сервис внутри готов отвечать: этого docker не знает, и ждать готовности
 * приходится по тому, что видно в приложении.
 */
export const restartContainer = (name: string): Promise<number> =>
  ask(`/containers/${encodeURIComponent(name)}/restart?t=0`);
