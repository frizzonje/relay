// Один опыт из матрицы — в воркере, а не на странице.
//
// Причина ровно одна: в WKWebView зависшая операция IndexedDB блокирует поток
// целиком, вместе с setTimeout. То есть сторож на странице не срабатывает, и
// «зависло» неотличимо от «страница не загрузилась». Воркер можно убить снаружи
// и продолжить с того же места — иначе каждый вариант стоил бы отдельного
// запуска приложения.
//
// Сообщения наверх: {stage} по ходу дела и {done|error} в конце. Последняя
// пришедшая стадия и есть точка зависания.

const STORE = 'identity';

// Стадия уходит на сервер и ДОЖИДАЕТСЯ доставки, прежде чем воркер сделает
// следующий шаг. Дорого, но иначе бесполезно: зависшая операция IndexedDB в
// WebKit кладёт вместе с собой и сеть (это один и тот же процесс), так что
// маячок, отправленный и не дождавшийся ответа, до сервера уже не доедет — и
// последняя удавшаяся стадия окажется не той, на которой всё встало.
async function say(stage) {
  postMessage({ stage });
  try {
    await fetch('/log?' + encodeURIComponent('    [worker] ' + stage));
  } catch {
    // Маячок — диагностика, а не работа: сеть отвалилась, а проба идёт дальше.
  }
}

function idb(name) {
  return new Promise((res, rej) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error || new Error('open failed'));
    r.onblocked = () => rej(new Error('open blocked'));
  });
}

// Ответ и с запроса, и с транзакции: какой из двух не приходит — это и есть
// половина диагноза. Первый сработавший выигрывает.
function put(db, key, value) {
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, 'readwrite');
    const req = t.objectStore(STORE).put(value, key);
    req.onsuccess = () => res('request');
    t.oncomplete = () => res('transaction');
    req.onerror = () => rej(req.error || new Error('put request failed'));
    t.onerror = () => rej(t.error || new Error('put transaction failed'));
    t.onabort = () => rej(t.error || new Error('put aborted'));
  });
}

function get(db, key) {
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).get(key);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error || new Error('get request failed'));
    t.onerror = () => rej(t.error || new Error('get transaction failed'));
    t.onabort = () => rej(t.error || new Error('get aborted'));
  });
}

const ALG = { name: 'Ed25519' };

async function run(msg) {
  const { db: name, mode, expectExisting } = msg;
  await say('opening ' + name);
  const db = await idb(name);
  await say('open');

  let value, describe;
  if (mode === 'plain') {
    value = { hello: 'world', n: 42 };
    describe = 'a plain object';
  } else {
    const extractable = mode.indexOf('extractable') === 0;
    await say('generating (extractable=' + extractable + ')');
    const pair = await crypto.subtle.generateKey(ALG, extractable, ['sign', 'verify']);
    await say('generated');
    value = mode.indexOf('-top') !== -1
      ? pair.privateKey
      : { privateKey: pair.privateKey, publicKey: pair.publicKey };
    describe = 'a CryptoKey, extractable=' + extractable +
      (mode.indexOf('-top') !== -1 ? ', stored bare' : ', inside an object');
  }

  // На втором запуске приложения писать нечего — там проверяется чтение того,
  // что легло в прошлый раз.
  if (!expectExisting) {
    await say('putting');
    const settled = await put(db, 'v', value);
    await say('put settled via ' + settled);
  }

  await say('getting');
  const back = await get(db, 'v');
  await say('got');

  if (!back) return { ok: false, what: describe, detail: 'nothing came back' };
  if (mode === 'plain') {
    return { ok: back.n === 42, what: describe, detail: 'n=' + back.n };
  }

  const priv = back.privateKey || back;
  const pub = back.publicKey;
  await say('signing with the key that came back');
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const sig = await crypto.subtle.sign(ALG, priv, nonce);
  const verified = pub ? await crypto.subtle.verify(ALG, pub, sig, nonce) : null;
  return {
    ok: sig.byteLength === 64 && verified !== false,
    what: describe,
    detail: 'extractable=' + priv.extractable + ', signature ' + sig.byteLength +
      ' bytes' + (pub ? ', verifies=' + verified : ', public half not stored'),
  };
}

onmessage = (e) => {
  run(e.data).then(
    (r) => postMessage({ done: r }),
    (err) => postMessage({ error: (err && err.name ? err.name + ': ' : '') + (err && err.message ? err.message : String(err)) })
  );
};
