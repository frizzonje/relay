'use strict';

// Разбор адресов окна. Отдельным файлом, потому что это чистые функции с
// правилами, которые важно не потерять, и их проверяют юнит-тесты (test/).

/** Протокол адреса или пустая строка, если это вообще не адрес. */
function safeProtocol(url) {
  try {
    return new URL(url).protocol;
  } catch {
    return '';
  }
}

/**
 * origin страницы — или null, если личности у неё быть не может.
 *
 * Экран выбора сервера живёт по `file://`, и его origin непрозрачен: ключ там
 * заводить не на что и незачем. Ключ есть только у настоящей инсталляции —
 * http(s)-origin, который человек ввёл сам.
 */
function originOf(url) {
  const proto = safeProtocol(url);
  if (proto !== 'http:' && proto !== 'https:') return null;
  return new URL(url).origin;
}

module.exports = { originOf, safeProtocol };
