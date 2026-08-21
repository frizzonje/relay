'use strict';

// Ключ личности: то, что нельзя сломать молча.
//
// Эти проверки повторяют смысл тестов Rust-оболочки
// (clients/desktop/src-tauri/src/identity.rs) — потому что файл на диске у них
// ОБЩИЙ: человек, обновившийся с Tauri-сборки, должен остаться собой. Если
// формат разъедется, снаружи это будет выглядеть как «клиент забыл, кто я».

const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

let identity;
let home;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-identity-'));
  process.env.XDG_CONFIG_HOME = home;
  identity = require('../src/identity');
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const ORIGIN = 'https://relay.example.com';

test('секрет переживает круг: ключ поднимается тем же самым', () => {
  const first = identity.answer({ id: '1', op: 'key' }, ORIGIN);
  const again = identity.answer({ id: '2', op: 'key' }, ORIGIN);
  assert.equal(first.error, undefined);
  assert.equal(first.publicKey, again.publicKey);
  assert.match(first.publicKey, /^[A-Za-z0-9_-]{43}$/); // base64url 32 байт без набивки
});

test('у каждого origin свой файл и свой ключ', () => {
  const a = identity.answer({ id: '1', op: 'key' }, ORIGIN);
  const b = identity.answer({ id: '2', op: 'key' }, 'https://other.example.com');
  assert.notEqual(a.publicKey, b.publicKey);
  assert.notEqual(identity.keyFile(ORIGIN), identity.keyFile('https://other.example.com'));
});

test('имя файла — начало sha256(origin), как в Rust', () => {
  // Не «примерно так же»: тот же файл читает вторая оболочка.
  const digest = nodeCrypto.createHash('sha256').update(ORIGIN).digest();
  const expected = `${digest.subarray(0, 8).toString('hex')}.key`;
  assert.equal(path.basename(identity.keyFile(ORIGIN)), expected);
});

test('ключ читается только владельцем', () => {
  identity.answer({ id: '1', op: 'key' }, ORIGIN);
  const mode = fs.statSync(identity.keyFile(ORIGIN)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('подпись проверяется одним публичным ключом', () => {
  const { publicKey } = identity.answer({ id: '1', op: 'key' }, ORIGIN);
  const { signature } = identity.answer({ id: '2', op: 'sign', message: 'привет' }, ORIGIN);
  const spki = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(publicKey, 'base64url'),
  ]);
  const key = nodeCrypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  assert.equal(
    nodeCrypto.verify(
      null,
      Buffer.from('привет', 'utf8'),
      key,
      Buffer.from(signature, 'base64url'),
    ),
    true,
  );
});

test('битый файл — это отказ, а не новая личность', () => {
  const origin = 'https://broken.example.com';
  fs.mkdirSync(path.dirname(identity.keyFile(origin)), { recursive: true });
  fs.writeFileSync(identity.keyFile(origin), 'это не ключ');
  const reply = identity.answer({ id: '1', op: 'key' }, origin);
  // Сгенерировать здесь новый ключ значило бы молча сделать человека другим
  // человеком — с чужой лентой и чужим именем.
  assert.equal(reply.publicKey, undefined);
  assert.equal(reply.error.kind, 'store');
});

test('страница не с сервера личности не получает', () => {
  const reply = identity.answer({ id: '1', op: 'key' }, null);
  assert.equal(reply.error.kind, 'origin');
});

test('запрос не на том языке — bad-request, а не тишина', () => {
  assert.equal(identity.answer({ id: '1', op: 'нечто' }, ORIGIN).error.kind, 'bad-request');
  assert.equal(identity.answer({ id: '1', op: 'sign' }, ORIGIN).error.kind, 'bad-request');
  assert.equal(identity.answer({}, ORIGIN).error.kind, 'bad-request');
});

test('семя разворачивается в ту же пару, что у ed25519-dalek (RFC 8032, тест 1)', () => {
  // Проверка совместимости с Rust-оболочкой на известном векторе: если бы наша
  // обёртка семени в PKCS#8 была неверной, ключи двух оболочек разошлись бы —
  // и обновление выглядело бы как потеря личности.
  const seed = Buffer.from(
    '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    'hex',
  );
  const origin = 'https://vector.example.com';
  fs.mkdirSync(path.dirname(identity.keyFile(origin)), { recursive: true });
  fs.writeFileSync(identity.keyFile(origin), seed.toString('base64url'), { mode: 0o600 });

  const { publicKey } = identity.answer({ id: '1', op: 'key' }, origin);
  assert.equal(
    Buffer.from(publicKey, 'base64url').toString('hex'),
    'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  );

  const { signature } = identity.answer({ id: '2', op: 'sign', message: '' }, origin);
  assert.equal(
    Buffer.from(signature, 'base64url').toString('hex'),
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
  );
});
