import type { Metadata } from 'next';
import { verifyGuestToken } from '@relay/shared';
import { GuestStage } from '@/components/stage/GuestStage';
import { InviteInvalid } from '@/components/stage/InviteInvalid';

/**
 * Гостевой вход по инвайт-ссылке `/invite/<token>`. Middleware пропускает этот
 * путь без куки relay_pass — подпись и срок токена проверяем здесь, на сервере
 * (SITE_PASSWORD есть только у него). Валидный токен → минимальная гостевая
 * сцена (ввод имени → сразу в эфир конкретного войс-канала); битый/протухший →
 * карточка об ошибке. Второй рубеж — socket-handshake на гейтвее.
 */
export const metadata: Metadata = {
  title: 'Приглашение в звонок',
};

export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ l?: string }>;
}) {
  const { token } = await params;
  const payload = await verifyGuestToken(
    decodeURIComponent(token),
    process.env.SITE_PASSWORD ?? '',
  );
  if (!payload) return <InviteInvalid />;

  // ?l= — косметическое имя канала для приветствия (не подписано, только текст).
  const { l } = await searchParams;
  const label = typeof l === 'string' && l.trim() ? l.trim().slice(0, 32) : payload.slug;

  return <GuestStage slug={payload.slug} label={label} exp={payload.exp} />;
}
