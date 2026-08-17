import { Fragment, type ReactNode } from 'react';
import type { MentionRef } from '@relay/shared';
import { cn } from '@/lib/utils';
import { splitMentions } from '@/lib/mentions';

/**
 * Markdown-мини для сообщений: `**жирный**`, `` `код` ``, авто-ссылки и
 * упоминания. Парсим в React-узлы вручную (без dangerouslySetInnerHTML) — так в
 * текст не просочится разметка, а ссылки и код получают наши классы. Набор
 * намеренно узкий: это подсветка «мессенджерового» ввода, а не полноценный
 * markdown.
 *
 * Приоритет: сперва код (внутри бэктиков ничего не разбираем), затем в обычном
 * тексте — жирный, упоминания и ссылки. Вложенность глубже одного уровня не
 * поддерживаем.
 *
 * Упоминания приходят списком с сервера, а не ищутся по «@слово»: имя стало
 * упоминанием потому, что его выбрали из подсказки, а не потому, что оно
 * похоже на чьё-то. Написанное просто так «@всем» остаётся текстом — и это
 * честно: никого оно и не позвало.
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
        className="text-link underline decoration-link/40 underline-offset-2 hover:decoration-link"
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

/**
 * Названное имя — «пилюлей», как в любом мессенджере; своё имя ярче, потому
 * что оно и есть повод посмотреть на эту строку.
 */
function mentionize(
  text: string,
  mentions: MentionRef[],
  me: string | undefined,
  keyBase: string,
): ReactNode[] {
  const parts = splitMentions(text, mentions);
  if (parts.length === 1 && !parts[0].mention) return linkify(text, keyBase);
  return parts.map((part, i) =>
    part.mention ? (
      <span
        key={`${keyBase}-m${i}`}
        title={part.mention.fingerprint}
        className={cn(
          'rounded-[4px] px-1 py-px font-medium',
          part.mention.fingerprint === me
            ? 'bg-accent-strong/30 text-text-header'
            : 'bg-accent/20 text-link',
        )}
      >
        {part.text}
      </span>
    ) : (
      <Fragment key={`${keyBase}-m${i}`}>{linkify(part.text, `${keyBase}-m${i}`)}</Fragment>
    ),
  );
}

// Обычный текст (уже вне кода): жирный **…**, остальное — под упоминания и ссылки.
const BOLD_RE = /\*\*([^*\n]+?)\*\*/g;

function renderText(
  text: string,
  keyBase: string,
  mentions: MentionRef[],
  me: string | undefined,
): ReactNode[] {
  const out: ReactNode[] = [];
  const leaf = (chunk: string, key: string) =>
    mentions.length ? mentionize(chunk, mentions, me, key) : linkify(chunk, key);
  let last = 0;
  let m: RegExpExecArray | null;
  BOLD_RE.lastIndex = 0;
  let i = 0;
  while ((m = BOLD_RE.exec(text))) {
    if (m.index > last) out.push(...leaf(text.slice(last, m.index), `${keyBase}-t${i}`));
    out.push(
      <strong key={`${keyBase}-b${i++}`} className="font-semibold text-text-header">
        {leaf(m[1], `${keyBase}-bi${i}`)}
      </strong>,
    );
    last = BOLD_RE.lastIndex;
  }
  if (last < text.length) out.push(...leaf(text.slice(last), `${keyBase}-t${i}`));
  return out;
}

const CODE_RE = /`([^`\n]+)`/g;

/**
 * Разбирает текст сообщения в React-узлы (жирный / код / упоминания / ссылки).
 * `me` — отпечаток читающего: своё имя в чужой реплике выделено сильнее.
 */
export function renderMarkdownMini(
  text: string,
  mentions: MentionRef[] = [],
  me?: string,
): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  CODE_RE.lastIndex = 0;
  let i = 0;
  while ((m = CODE_RE.exec(text))) {
    if (m.index > last)
      out.push(
        <Fragment key={`c-t${i}`}>
          {renderText(text.slice(last, m.index), `t${i}`, mentions, me)}
        </Fragment>,
      );
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
  if (last < text.length)
    out.push(
      <Fragment key={`c-t${i}`}>{renderText(text.slice(last), `t${i}`, mentions, me)}</Fragment>,
    );
  return out;
}
