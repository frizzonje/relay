import type { Metadata } from 'next';
import { readGuestToken } from '@relay/shared';
import { GuestStage } from '@/components/stage/GuestStage';
import { InviteInvalid } from '@/components/stage/InviteInvalid';
import { decodeOrNull } from '@/lib/decode';
import { getT } from '@/lib/i18n/server';

/**
 * Гостевой вход по инвайт-ссылке `/invite/<token>`. Middleware пропускает этот
 * путь без куки relay_pass. Здесь — только форма и срок токена: подписан он
 * паролем инсталляции, а тот может жить не в `SITE_PASSWORD`, а в настройках
 * api (владелец задал его из панели), где фронт его не видит. Проверять подпись
 * старым ключом значило бы объявить негодной каждую ссылку такой инсталляции.
 *
 * Подлинность решает api на socket-handshake — тем же порядком, что и у
 * пропуска в middleware. Не принял — сцена показывает ту же карточку (см.
 * `inviteRefused`). Годный по форме токен → гостевая сцена (ввод имени → сразу
 * в эфир войс-канала); битый/протухший → карточка сразу.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('invite.title') };
}

export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ l?: string }>;
}) {
  const { token } = await params;
  // Обрезанная ссылка с битой кодировкой — такое же негодное приглашение, а не 500.
  const raw = decodeOrNull(token);
  const payload = raw && readGuestToken(raw)?.payload;
  if (!payload) return <InviteInvalid />;

  // ?l= — косметическое имя канала для приветствия (не подписано, только текст).
  const { l } = await searchParams;
  const label = typeof l === 'string' && l.trim() ? l.trim().slice(0, 32) : payload.slug;

  // `listen` — часть подписанного токена, а не параметр адреса: приглашение в
  // канал закрытого сервера даёт слышать, но не говорить (пароля, на котором
  // этот канал держится, ссылка не раздаёт). Правкой URL это не снимается, а
  // соврать самому себе клиент может только себе же во вред: медиасервер и
  // собеседники сверяются с сервером, а не с этой страницей.
  return <GuestStage slug={payload.slug} label={label} exp={payload.exp} listen={payload.listen} />;
}
