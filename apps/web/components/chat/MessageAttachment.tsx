'use client';

import { useState } from 'react';
import type { Attachment } from '@relay/shared';
import { fmtBytes } from '@/lib/format';
import { ImageLightbox } from '@/components/chat/ImageLightbox';

/** Глазок-иконка для плашки спойлера (Feather eye). */
function EyeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/**
 * Вложение в сообщении: картинка инлайн, mp3 — плеером, прочее — карточкой
 * со скачиванием. Вид задаёт сервер (att.kind). Клик по картинке открывает
 * полноэкранный просмотр с зумом ([[ImageLightbox]]) — прямо в клиенте.
 *
 * Спойлер (att.spoiler) прячет вложение под заблюренной плашкой до клика — как
 * в Discord. Картинка под спойлером всё же грузится (иначе не показать по клику),
 * но замазана до раскрытия.
 */
export function MessageAttachment({ att }: { att: Attachment }) {
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState(!att.spoiler);

  // Спойлер: заблюренная плашка «показать». Для картинки — размытый превью,
  // для прочего — нейтральная карточка, чтобы имя файла не выдавало содержимое.
  if (!revealed) {
    const isImg = att.kind === 'image';
    return (
      <div className="mt-1.5 max-w-[420px]">
        <button
          type="button"
          onClick={() => setRevealed(true)}
          aria-label={`Показать спойлер: ${att.name}`}
          className="group/spoiler relative block overflow-hidden rounded-[10px] border border-line outline-none focus-visible:ring-2 focus-visible:ring-white/40"
        >
          {isImg ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={att.url}
              alt=""
              aria-hidden
              // min-размеры растягивают мелкие картинки (object-cover), чтобы
              // плашка «спойлер» всегда помещалась; крупные живут как раньше.
              className="pointer-events-none block max-h-[300px] min-h-[104px] min-w-[190px] max-w-full scale-110 select-none object-cover blur-[26px] brightness-[0.5]"
            />
          ) : (
            <div className="h-[88px] w-[280px] bg-bg-active" />
          )}
          <span className="absolute inset-0 grid place-items-center">
            <span className="flex items-center gap-1.5 whitespace-nowrap rounded-full border border-line-strong bg-bg-app/80 px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-text-header backdrop-blur-sm transition-colors group-hover/spoiler:bg-bg-app">
              <EyeIcon />
              спойлер
            </span>
          </span>
        </button>
      </div>
    );
  }

  if (att.kind === 'image') {
    return (
      <div className="mt-1.5 max-w-[420px]">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`Открыть изображение: ${att.name}`}
          className="block cursor-zoom-in rounded-[10px] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={att.url}
            alt={att.name}
            loading="lazy"
            className="block max-h-[340px] max-w-full rounded-[10px] border border-bg-active bg-[#1e1f22] transition-[filter] hover:brightness-105"
          />
        </button>
        <ImageLightbox
          src={att.url}
          alt={att.name}
          downloadName={att.name}
          sizeLabel={fmtBytes(att.size)}
          open={open}
          onOpenChange={setOpen}
        />
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
