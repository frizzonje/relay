import type { MentionRef } from '@relay/shared';

/**
 * Упоминания в тексте: где они написаны и что из набранного ими считается.
 *
 * Правило здесь ровно одно и совпадает с серверным (`mentionedIn` в
 * api/gateway/chat.service): упомянут тот, чьё имя написано в тексте после
 * `@`. Ищем подстроку целиком, а не слово по границам, — ники свободные, в них
 * бывают и пробелы, и точки, и разбор «где кончается имя» разошёлся бы с тем,
 * что человек выбрал в подсказке.
 *
 * Отпечаток при этом остаётся адресатом, а ник — только написанным словом:
 * человек мог переименоваться, и сказанное вчера от этого не меняется.
 */

/** Кусок текста: обычный или названное имя. */
export interface MentionSegment {
  text: string;
  /** Кого назвали этим куском. Пусто — обычный текст. */
  mention?: MentionRef;
}

/** Максимум того, что считается набранным после `@` (ник длиннее не бывает). */
const QUERY_MAX = 20;

/**
 * Разбить текст на обычные куски и упоминания.
 *
 * Длинные имена пробуем первыми: у «Аня» и «Аня К» общее начало, и совпади
 * первое — второе имя оказалось бы наполовину упоминанием, наполовину текстом.
 */
export function splitMentions(text: string, mentions: MentionRef[]): MentionSegment[] {
  if (!text || !mentions.length) return text ? [{ text }] : [];
  const people = [...mentions].sort((a, b) => b.nick.length - a.nick.length);
  const lower = text.toLowerCase();

  const out: MentionSegment[] = [];
  let plain = '';
  for (let i = 0; i < text.length; ) {
    const person =
      text[i] === '@'
        ? people.find((p) => p.nick && lower.startsWith(p.nick.toLowerCase(), i + 1))
        : undefined;
    if (!person) {
      plain += text[i];
      i += 1;
      continue;
    }
    if (plain) {
      out.push({ text: plain });
      plain = '';
    }
    const len = person.nick.length + 1;
    out.push({ text: text.slice(i, i + len), mention: person });
    i += len;
  }
  if (plain) out.push({ text: plain });
  return out;
}

/**
 * Что человек набирает после `@` прямо сейчас — по тексту и позиции курсора.
 * `null` — ничего: подсказке появляться не с чего.
 *
 * Набранное обрывается пробелом, хотя в самом нике пробел и допустим. Иначе
 * подсказка держалась бы до конца строки, а искать по началу имени всё равно
 * достаточно: выбранное подставится целиком, вместе со всеми пробелами.
 *
 * Перед `@` обязано быть начало строки или пробел: в «почта@дом.рф» никого не
 * зовут, и подсказка там только мешает.
 */
export function typedMention(text: string, caret: number): { at: number; query: string } | null {
  const head = text.slice(0, Math.max(0, caret));
  const at = head.lastIndexOf('@');
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(head[at - 1])) return null;
  const query = head.slice(at + 1);
  if (query.length > QUERY_MAX || /\s/.test(query)) return null;
  return { at, query };
}

/** Подставить выбранное имя вместо набранного `@…`; курсор — сразу за ним. */
export function insertMention(
  text: string,
  token: { at: number; query: string },
  nick: string,
): { text: string; caret: number } {
  const before = text.slice(0, token.at);
  const after = text.slice(token.at + 1 + token.query.length);
  const inserted = `@${nick} `;
  return {
    text: before + inserted + after.replace(/^ /, ''),
    caret: before.length + inserted.length,
  };
}

/**
 * Кого из выбранных и правда назвали в этом тексте. Тем же правилом, каким это
 * потом проверит сервер: выбранное в подсказке имя человек мог и стереть, и
 * посылать вслед отпечаток стёртого — значит звать молча.
 */
export function writtenIn(text: string, people: MentionRef[]): MentionRef[] {
  const lower = text.toLowerCase();
  const seen = new Set<string>();
  return people.filter((p) => {
    if (!p.nick || seen.has(p.fingerprint)) return false;
    if (!lower.includes('@' + p.nick.toLowerCase())) return false;
    seen.add(p.fingerprint);
    return true;
  });
}

/** Названа ли в реплике эта личность — то, из-за чего строка ленты подсвечена. */
export function mentions(list: MentionRef[] | undefined, fingerprint: string | undefined): boolean {
  return !!fingerprint && !!list?.some((m) => m.fingerprint === fingerprint);
}
