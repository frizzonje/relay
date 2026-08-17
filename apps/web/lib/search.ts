/**
 * Как найденное показывается человеку: что подсветить и что показать, если
 * реплика длиннее строки результата.
 *
 * Слова для подсветки приходят с сервера — те самые, по которым он искал.
 * Разбирать запрос здесь второй раз значило бы завести вторые правила: сервер
 * ищет по началу слова, а клиент подсвечивал бы вхождения где попало, и человек
 * видел бы подсветку там, где совпадения не было, и не видел там, где было.
 */

/** Кусок текста результата: обычный или тот, из-за которого он нашёлся. */
export interface Segment {
  text: string;
  hit: boolean;
}

/** Слово — то же, чем его считает разбор запроса на сервере. */
const WORD = /[\p{L}\p{N}_]+/gu;

/**
 * Разбить текст на куски, пометив слова, из-за которых он нашёлся.
 *
 * Подсвечивается слово целиком, а не набранная часть: нашёлся текст из-за
 * «дачу», и подчёркнутый огрызок «дач» посреди слова читался бы как опечатка.
 */
export function highlight(text: string, terms: string[]): Segment[] {
  const wanted = terms.map((t) => t.toLowerCase()).filter(Boolean);
  if (!wanted.length || !text) return [{ text, hit: false }];

  const out: Segment[] = [];
  let last = 0;
  for (const match of text.matchAll(WORD)) {
    const at = match.index ?? 0;
    const word = match[0].toLowerCase();
    if (!wanted.some((term) => word.startsWith(term))) continue;
    if (at > last) out.push({ text: text.slice(last, at), hit: false });
    out.push({ text: match[0], hit: true });
    last = at + match[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out;
}

/** Сколько символов реплики показываем в строке результата. */
const EXCERPT = 160;

/**
 * Длинную реплику показываем куском вокруг найденного, а не её началом.
 *
 * Начало длинного сообщения — почти всегда не то место, где встретилось слово,
 * и результат выглядел бы как «нашлось непонятно почему». Обрезаем по границе
 * слова: оборванное посередине слово читается как ошибка, а не как сокращение.
 */
export function excerpt(text: string, terms: string[]): string {
  if (text.length <= EXCERPT) return text;

  const segments = highlight(text, terms);
  let at = 0;
  let seen = 0;
  for (const seg of segments) {
    if (seg.hit) {
      at = seen;
      break;
    }
    seen += seg.text.length;
  }

  // Треть окна до находки, остальное — после: смысл сказанного чаще следует за
  // словом, чем предшествует ему.
  const from = Math.max(0, at - Math.floor(EXCERPT / 3));
  const to = Math.min(text.length, from + EXCERPT);
  const head = from > 0 ? text.slice(from).replace(/^\S*\s/, '') : text.slice(from);
  const cut = head.slice(0, to - from).replace(/\s\S*$/, '');
  return `${from > 0 ? '…' : ''}${cut}${to < text.length ? '…' : ''}`;
}
