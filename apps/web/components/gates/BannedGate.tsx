'use client';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useIdentityStore } from '@/stores/identity';
import { useModerationStore } from '@/stores/moderation';
import { useT } from '@/lib/i18n';

/**
 * Тебя забанили на всей инсталляции.
 *
 * Экран, а не тост, и закрыть его нельзя: сокета больше нет, и приложение
 * вокруг — рейка, каналы, поле ввода — осталось декорацией, которая молча
 * ничего не делает. Показать её вместо объяснения значит заставить человека
 * гадать, сломался ли relay или дело в нём.
 *
 * Отпечаток здесь не украшение: забанен КЛЮЧ, а не человек, и это ровно то,
 * что стоит сказать вслух. Новую личность заводят за секунду и без чьего-либо
 * разрешения — бан прекращает происходящее сейчас, а не запирает дверь в
 * здание. Дверь в relay одна, и она называется паролем инсталляции.
 */
export function BannedGate() {
  const t = useT();
  const banned = useModerationStore((s) => s.banned);
  const me = useIdentityStore((s) => s.me);

  return (
    <Dialog open={banned}>
      <DialogContent
        className="max-w-[420px]"
        // Ни Esc, ни клика мимо: закрывать тут нечего — за окном приложение,
        // которое всё равно не работает.
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <div className="px-7 pb-6 pt-6 text-center">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-bg-deep text-2xl">
            🚫
          </div>
          <DialogTitle className="text-xl">{t('moderation.banned.title')}</DialogTitle>
          <DialogDescription className="mx-auto mt-1.5 max-w-[320px] text-[13px] leading-relaxed">
            {t('moderation.banned.body')}
          </DialogDescription>
          {me?.fingerprint && (
            <p className="mt-4 font-mono text-[12px] text-text-muted">{me.fingerprint}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
