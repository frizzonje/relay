import { Fragment, type ReactNode } from 'react';

/**
 * Markdown-мини для сообщений: `**жирный**`, `` `код` `` и авто-ссылки. Парсим в
 * React-узлы вручную (без dangerouslySetInnerHTML) — так в текст не просочится
 * разметка, а ссылки и код получают наши классы. Набор намеренно узкий: это
 * подсветка «мессенджерового» ввода, а не полноценный markdown.
 *
 * Приоритет: сперва код (внутри бэктиков ничего не разбираем), затем в обычном
 * тексте — жирный и ссылки. Вложенность глубже одного уровня не поддерживаем.
 */

// URL целиком до пробела/скобок; хвостовую пунктуацию (.,!?…) отрезаем — она
// почти всегда часть предложения, а не адреса.
const URL_RE = /https?:\/\/[^\s<>()]+/g;

function linkify(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  let i = 0;
  while ((m = URL_RE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    let url = m[0];
    let trail = '';
    // Отрезаем хвостовую пунктуацию — вернём её обычным текстом после ссылки.
    const tail = url.match(/[.,!?;:…]+$/);
    if (tail) {
      trail = tail[0];
      url = url.slice(0, -trail.length);
    }
    out.push(
      <a
        key={`${keyBase}-a${i++}`}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[#79a6ff] underline decoration-[#79a6ff]/40 underline-offset-2 hover:decoration-[#79a6ff]"
      >
        {url}
      </a>,
    );
    if (trail) out.push(trail);
    last = URL_RE.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Обычный текст (уже вне кода): жирный **…**, остальное — под авто-ссылки.
const BOLD_RE = /\*\*([^*\n]+?)\*\*/g;

function renderText(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  BOLD_RE.lastIndex = 0;
  let i = 0;
  while ((m = BOLD_RE.exec(text))) {
    if (m.index > last) out.push(...linkify(text.slice(last, m.index), `${keyBase}-t${i}`));
    out.push(
      <strong key={`${keyBase}-b${i++}`} className="font-semibold text-text-header">
        {linkify(m[1], `${keyBase}-bi${i}`)}
      </strong>,
    );
    last = BOLD_RE.lastIndex;
  }
  if (last < text.length) out.push(...linkify(text.slice(last), `${keyBase}-t${i}`));
  return out;
}

const CODE_RE = /`([^`\n]+)`/g;

/** Разбирает текст сообщения в React-узлы (жирный / код / ссылки). */
export function renderMarkdownMini(text: string): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  CODE_RE.lastIndex = 0;
  let i = 0;
  while ((m = CODE_RE.exec(text))) {
    if (m.index > last) out.push(<Fragment key={`c-t${i}`}>{renderText(text.slice(last, m.index), `t${i}`)}</Fragment>);
    out.push(
      <code
        key={`c-c${i++}`}
        className="rounded-[5px] border border-line bg-black/30 px-1.5 py-0.5 font-mono text-[0.86em] text-text-header"
      >
        {m[1]}
      </code>,
    );
    last = CODE_RE.lastIndex;
  }
  if (last < text.length) out.push(<Fragment key={`c-t${i}`}>{renderText(text.slice(last), `t${i}`)}</Fragment>);
  return out;
}
