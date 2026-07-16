import Link from 'next/link';
import { Logo } from '@/components/ui/Logo';

/**
 * Карточка «приглашение недействительно»: битый или протухший инвайт-токен.
 * Серверный компонент — рисуется страницей /invite/[token] без клиентского кода.
 */
export function InviteInvalid() {
  return (
    <main className="relative z-10 grid min-h-dvh place-items-center p-4">
      <div className="panel flex w-full max-w-[420px] flex-col items-center gap-3 rounded-2xl border border-line px-7 py-8 text-center">
        <span className="grid h-14 w-14 place-items-center rounded-2xl bg-bg-elev ring-1 ring-inset ring-white/10">
          <Logo size={32} nodeBg="#111418" />
        </span>
        <h1 className="text-xl font-bold text-text-header">Приглашение недействительно</h1>
        <p className="max-w-[320px] text-[13px] leading-relaxed text-text-muted">
          Ссылка истекла или повреждена. Попросите нового приглашения у того, кто вас позвал, —
          ссылки действуют 24 часа.
        </p>
        <Link
          href="/login"
          className="mt-2 text-[13px] font-semibold text-text-muted underline-offset-4 transition-colors hover:text-text-header hover:underline"
        >
          У меня есть пароль сервера
        </Link>
      </div>
    </main>
  );
}
