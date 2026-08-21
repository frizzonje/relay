'use strict';

// Ключ личности: рождается, живёт и подписывает ЗДЕСЬ, в главном процессе.
// Страница знает только свой публичный ключ и умеет просить подпись.
//
// Формат хранения — байт в байт как у Tauri-клиента
// (`clients/desktop/src-tauri/src/identity.rs`), потому что это один и тот же
// человек на одной и той же машине:
//
//   • файл  `<config>/identity/<первые 8 байт sha256(origin) в hex>.key`, права 0600;
//   • содержимое — base64url (без набивки) 32-байтового семени Ed25519;
//   • имя файла — хеш, а не адрес: каталог и так виден, но пусть в домашнем
//     каталоге не будет написано именем файла, к какому серверу человек ходит.
//
// Ключ СВОЙ У КАЖДОГО origin. Оболочка умеет «сменить сервер», и общий ключ
// означал бы, что сервер A может попросить подписать нонс, взятый у сервера B, —
// и войти под нами туда, где нас не звали. Origin берётся у самого webContents,
// а не из тела запроса: то, что прислала страница, — это её слова о себе.
//
// Системного хранилища (Secret Service) здесь нет по той же причине, что и в
// Rust: оно тянет за собой демона, которого на машине может не быть, и всё
// равно кончается тем же файлом. `~/.ssh/id_ed25519` лежит ровно так же.

const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { identityDir } = require('./paths');
const { ulog } = require('./log');

/** PKCS#8-обёртка вокруг голого семени Ed25519 — в таком виде его берёт Node. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const b64url = (buf) => buf.toString('base64url');

/** Отказ в машинном виде: `kind` выбирает экран в web-UI, `detail` едет в лог. */
function fail(kind, detail) {
  return { kind, detail: String(detail) };
}

function keyFile(origin) {
  const digest = nodeCrypto.createHash('sha256').update(origin).digest();
  return path.join(identityDir(), `${digest.subarray(0, 8).toString('hex')}.key`);
}

function keyFromSeed(seed) {
  return nodeCrypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

/**
 * Поднять сохранённый ключ или родить новый.
 *
 * Железное правило порядка: новый ключ рождается ТОЛЬКО когда хранилище внятно
 * ответило «такого нет» (ENOENT). Любой другой отказ — каталог не читается, файл
 * битый, прав нет — это отказ, а не пустота: сгенерировать ключ на нём значит
 * молча сделать человека другим человеком.
 */
function loadOrCreate(origin) {
  const file = keyFile(origin);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') {
      return { error: fail('store', `чтение ${file}: ${e.message}`) };
    }
    raw = null;
  }

  if (raw !== null) {
    const seed = Buffer.from(raw.trim(), 'base64url');
    if (seed.length !== 32) {
      // Файл есть, но это не ключ. Молча заменить его новым — потерять личность;
      // человеку нужен внятный отказ, а файл пусть останется на месте.
      return { error: fail('store', `битый ключ ${file}: ${seed.length} байт вместо 32`) };
    }
    return { key: keyFromSeed(seed) };
  }

  const seed = nodeCrypto.randomBytes(32);
  try {
    fs.mkdirSync(identityDir(), { recursive: true, mode: 0o700 });
    // Права ставим ДО записи: файл, побывший читаемым для всех хоть мгновение,
    // уже не станет секретом обратно.
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
      fs.writeSync(fd, b64url(seed));
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return { error: fail('store', `запись ${file}: ${e.message}`) };
  }
  ulog(`identity: новый ключ для ${origin}`);
  return { key: keyFromSeed(seed) };
}

/** Публичная половина в том же виде, что отдаёт Rust: base64url 32 байт. */
function publicKeyOf(key) {
  const spki = nodeCrypto.createPublicKey(key).export({ format: 'der', type: 'spki' });
  return b64url(spki.subarray(spki.length - 32));
}

function sign(key, message) {
  return b64url(nodeCrypto.sign(null, Buffer.from(message, 'utf8'), key));
}

/**
 * Ответ на `identity-request`. `origin` даёт вызывающая сторона (main.js),
 * сняв его с самого окна; `null` — страница не с сервера (например локальный
 * экран выбора), личности у неё нет и быть не может.
 */
function answer(req, origin) {
  if (!req || typeof req.id !== 'string' || typeof req.op !== 'string') {
    return {
      id: req && typeof req.id === 'string' ? req.id : '',
      error: fail('bad-request', 'нет id или op'),
    };
  }
  if (!origin) {
    return { id: req.id, error: fail('origin', 'страница не с сервера — личности нет') };
  }

  const loaded = loadOrCreate(origin);
  if (loaded.error) {
    ulog(`identity ${req.op} для ${origin}: ${loaded.error.kind} — ${loaded.error.detail}`);
    return { id: req.id, error: loaded.error };
  }

  try {
    if (req.op === 'key') {
      return { id: req.id, publicKey: publicKeyOf(loaded.key) };
    }
    if (req.op === 'sign') {
      if (typeof req.message !== 'string') {
        return { id: req.id, error: fail('bad-request', 'sign без message') };
      }
      return { id: req.id, signature: sign(loaded.key, req.message) };
    }
    return { id: req.id, error: fail('bad-request', `неизвестная операция ${req.op}`) };
  } catch (e) {
    return { id: req.id, error: fail('engine', e.message) };
  }
}

module.exports = { answer, keyFile, loadOrCreate, publicKeyOf, sign };
