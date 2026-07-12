import type { Attachment } from '@relay/shared';
import { fmtBytes } from '@/lib/format';

/**
 * Вложение в сообщении: картинка инлайн, mp3 — плеером, прочее — карточкой
 * со скачиванием. Вид задаёт сервер (att.kind).
 */
export function MessageAttachment({ att }: { att: Attachment }) {
  if (att.kind === 'image') {
    return (
      <div className="mt-1.5 max-w-[420px]">
        <a href={att.url} target="_blank" rel="noopener noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={att.url}
            alt={att.name}
            loading="lazy"
            className="block max-h-[340px] max-w-full cursor-pointer rounded-[10px] border border-bg-active bg-[#1e1f22] transition-[filter] hover:brightness-105"
          />
        </a>
      </div>
    );
  }

  if (att.kind === 'audio') {
    return (
      <div className="mt-1.5 flex max-w-[420px] flex-col gap-1.5 rounded-[10px] bg-bg-active px-3 py-2.5">
        <div className="truncate text-[13px] font-semibold text-text">{att.name}</div>
        <audio controls preload="metadata" src={att.url} className="h-9 w-full" />
      </div>
    );
  }

  return (
    <div className="mt-1.5 max-w-[420px]">
      <a
        href={att.url}
        download={att.name}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-3 rounded-[10px] border border-white/[0.06] bg-bg-active px-3 py-2.5 transition-colors hover:bg-bg-hover"
      >
        <div className="text-2xl">📄</div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-text">{att.name}</div>
          <div className="text-[11px] text-text-muted">{fmtBytes(att.size)}</div>
        </div>
      </a>
    </div>
  );
}
