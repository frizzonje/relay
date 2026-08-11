// Сервер под пробу ключа (tools/keyprobe/index.html). Две страницы и лог:
// отдаёт пробу и печатает присланный ею вердикт в stdout — окно webview на
// чужой платформе может быть некому показать, а результат нужен в логе.
//
//   docker run --rm -p 4321:4321 -v "$PWD/tools/keyprobe":/probe:ro \
//     -w /probe node:20-alpine node serve.mjs
//
// Слушает на 4321. http://localhost — доверенный источник во всех трёх
// движках, так что crypto.subtle и IndexedDB доступны без сертификата.

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';

const PORT = Number(process.env.PORT || 4321);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

// Файлы читаются на каждый запрос, а не при старте: правка пробы между двумя
// запусками приложения — обычный ход в этой работе, и перезапускать ради неё
// сервер значит терять лог предыдущего опыта.
function file(name) {
  const url = new URL('./' + name, import.meta.url);
  return existsSync(url) ? readFileSync(url) : null;
}

createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/report') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let r;
      try { r = JSON.parse(body); } catch { r = { verdict: '(unparseable report)', rows: [] }; }
      console.log('\n─── report from ' + (req.headers['user-agent'] || 'unknown') + ' ───');
      console.log(r.verdict);
      for (const [label, value, ok] of r.rows || []) {
        const mark = ok === true ? 'ok  ' : ok === false ? 'FAIL' : '    ';
        console.log('  ' + mark + '  ' + label + ': ' + value);
      }
      res.writeHead(204).end();
    });
    return;
  }
  // Маячки по стадиям. Проба ходит асинхронная, и её худший исход — не ошибка,
  // а тишина: запрос к IndexedDB, который не позвал ни onsuccess, ни onerror,
  // оставляет страницу живой и молчащей, и снаружи это неотличимо от «скрипт
  // не выполнялся вовсе». Маячок печатает стадию до того, как её ждать.
  if (req.url && req.url.startsWith('/log?')) {
    console.log('  · ' + decodeURIComponent(req.url.slice('/log?'.length)));
    res.writeHead(204).end();
    return;
  }
  // Имя файла из пути, если такой файл есть; иначе — обычная проба. Второе
  // важнее первого: пикер десктоп-клиента сначала стучится в корень, проверяя
  // доступность, и 404 он считает мёртвым сервером.
  const name = decodeURIComponent((req.url || '/').split('?')[0].replace(/^\/+/, ''));
  const body = (/^[\w.-]+$/.test(name) && file(name)) || file('index.html');
  const ext = name.slice(name.lastIndexOf('.'));
  res.writeHead(200, {
    'content-type': TYPES[ext] || TYPES['.html'],
    'cache-control': 'no-store',
  }).end(body);
}).listen(PORT, () => console.log('key probe on http://localhost:' + PORT));
