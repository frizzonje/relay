'use client';

import { BlockingNotice } from '@/components/gates/BlockingNotice';
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
    <BlockingNotice
      open={banned}
      icon="🚫"
      title={t('moderation.banned.title')}
      body={t('moderation.banned.body')}
    >
      {me?.fingerprint && (
        <p className="mt-4 font-mono text-[12px] text-text-muted">{me.fingerprint}</p>
      )}
    </BlockingNotice>
  );
}
