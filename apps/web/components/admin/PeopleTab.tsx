'use client';

import { useEffect, useState } from 'react';
import type { AdminDevice, AdminPerson } from '@relay/shared';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/ui/icon';
import { Identicon } from '@/components/ui/Identicon';
import { PresenceDot } from '@/components/ui/PresenceDot';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { fmtSince, shortFingerprint } from '@/lib/format';
import { useT, type Translate } from '@/lib/i18n';
import { adminRefusalKey, type AdminFieldError } from '@/lib/refusals';
import { useAdminStore } from '@/stores/admin';
import { usePresence } from '@/stores/presence';

/**
 * Вкладка «Личности»: кто заведён в этой инсталляции.
 *
 * Человека здесь называют лицом, именем и коротким отпечатком — тем же тремя
 * приметами, что и в составе канала (`OnlineMembers`), и это не украшение:
 * ники не уникальны, и разбанить тёзку по имени было бы лотереей. Отпечаток
 * целиком не показывается нигде — он длиной в девятнадцать знаков и в строку
 * не влезает, а нужен он глазами, а не для доказательства.
 *
 * ПОИСК СЕРВЕРНЫЙ, И СПИСОК СТРАНИЦАМИ. Инсталляция на тысячу человек привезла
 * бы тысячу строк, чтобы показать одну; `admin-people` берёт и часть ника, и
 * часть отпечатка, а «показать ещё» ходит по курсору из прошлого ответа.
 *
 * Прав вкладка не раздаёт: их проверяет сервер на каждом событии (§9). Кнопки
 * «забанить» у владельца нет не поэтому, а потому, что она бы всегда
 * отказывала: строка бана на инсталляцию и строка владельца — одна и та же
 * пара ключей, и `RolesService` отвечает `forbidden`. Кнопка, которая никогда
 * не срабатывает, — насмешка над тем, кто её нажал.
 */

/**
 * Сколько ждём после последней буквы. Запрос на каждое нажатие — это запрос на
 * «м», «ма» и «маш» ради одной «маши»; полсекунды человек не замечает, а
 * сервер за это время не спрашивают трижды.
 */
const SEARCH_DEBOUNCE_MS = 300;

export function PeopleTab() {
  const t = useT();
  const people = useAdminStore((s) => s.people);
  const query = useAdminStore((s) => s.peopleQuery);
  const cursor = useAdminStore((s) => s.peopleCursor);
  const busy = useAdminStore((s) => s.peopleBusy);
  const loaded = useAdminStore((s) => s.peopleLoaded);
  const listError = useAdminStore((s) => s.listError);
  const [draft, setDraft] = useState(query);
  /** Кого спрашивают перед баном. `null` — никого. */
  const [banning, setBanning] = useState<AdminPerson | null>(null);
  /** Отказ по строке: он про одного человека, и стоять ему рядом с ним. */
  const [refusals, setRefusals] = useState<Record<string, AdminFieldError>>({});

  // Список переживает переключение вкладок (он в сторе), поэтому спрашиваем
  // только то, чего ещё не спрашивали: иначе каждый заход на вкладку сбрасывал
  // бы набранный поиск и долистанные страницы.
  useEffect(() => {
    if (!useAdminStore.getState().peopleLoaded) void useAdminStore.getState().loadPeople('');
  }, []);

  useEffect(() => {
    const wanted = draft.trim();
    if (wanted === useAdminStore.getState().peopleQuery) return;
    const id = setTimeout(
      () => void useAdminStore.getState().loadPeople(wanted),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(id);
  }, [draft]);

  const remember = (fingerprint: string, reason: AdminFieldError | null) => {
    setRefusals((prev) => {
      if (!reason) {
        if (!(fingerprint in prev)) return prev;
        const rest = { ...prev };
        delete rest[fingerprint];
        return rest;
      }
      return { ...prev, [fingerprint]: reason };
    });
  };

  return (
    <div data-testid="admin-people" className="flex flex-col gap-3">
      <div className="relative">
        <Icon
          name="search"
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[16px] text-text-muted"
        />
        <input
          value={draft}
          aria-label={t('admin.people.search')}
          placeholder={t('admin.people.search')}
          data-testid="admin-people-search"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            void useAdminStore.getState().loadPeople(draft.trim());
          }}
          className="w-full rounded-[10px] border border-line bg-bg-elev py-2 pl-9 pr-3 text-[14px] text-text outline-none transition focus:border-line-strong"
        />
      </div>

      {/* «Ищем» — не украшение: на медленной сети список без него выглядит
          пустым, и человек решает, что в инсталляции никого нет. */}
      {busy && (
        <p
          data-testid="admin-people-busy"
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-faint"
        >
          {t('admin.people.searching')}
        </p>
      )}

      {listError && (
        <p data-testid="admin-people-error" className="text-[13px] text-danger">
          {t(adminRefusalKey(listError))}
        </p>
      )}

      {loaded && people.length === 0 && !busy && (
        <p data-testid="admin-people-empty" className="text-[13px] text-text-muted">
          {query ? t('admin.people.nothing', { query }) : t('admin.people.empty')}
        </p>
      )}

      {people.map((person) => (
        <PersonRow
          key={person.fingerprint}
          person={person}
          refusal={refusals[person.fingerprint]}
          onBan={() => setBanning(person)}
          onUnban={async () =>
            remember(person.fingerprint, await useAdminStore.getState().unban(person.fingerprint))
          }
        />
      ))}

      {/* Кнопка есть, только пока курсор есть: «показать ещё», не приносящее
          ничего, читается как сломанная панель. */}
      {cursor && (
        <button
          type="button"
          data-testid="admin-people-more"
          disabled={busy}
          onClick={() => void useAdminStore.getState().morePeople()}
          className="self-start rounded-[8px] border border-line-strong bg-bg-active px-3 py-2 text-[13px] text-text outline-none transition-colors hover:bg-line-strong disabled:opacity-50"
        >
          {t('admin.people.more')}
        </button>
      )}

      {banning && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setBanning(null)}
          title={t('admin.people.ban.title', { nick: banning.nick })}
          description={t('admin.people.ban.body')}
          // Вторая половина последствий — про то, что бан не выгоняет насовсем
          // одним нажатием, а держится на личности. Человек, читающий диалог,
          // обязан знать обе.
          details={
            <p className="text-[13px] leading-relaxed text-text-muted">
              {t('admin.people.ban.warn')}
            </p>
          }
          confirmLabel={t('admin.people.ban.apply')}
          onConfirm={() => {
            const target = banning.fingerprint;
            setBanning(null);
            void useAdminStore
              .getState()
              .ban(target)
              .then((reason) => remember(target, reason));
          }}
        />
      )}
    </div>
  );
}

/** Одна строка списка: лицо, имя, отпечаток, положение и его устройства. */
function PersonRow({
  person,
  refusal,
  onBan,
  onUnban,
}: {
  person: AdminPerson;
  refusal?: AdminFieldError;
  onBan: () => void;
  onUnban: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const presence = usePresence(person.fingerprint);

  return (
    <div
      data-testid={`admin-person-${person.fingerprint}`}
      className="rounded-[10px] border border-line bg-bg-elev/60 px-3.5 py-3"
    >
      <div className="flex items-center gap-3">
        <div className="relative h-[34px] w-[34px] shrink-0">
          <Identicon fingerprint={person.fingerprint} size={34} />
          <PresenceDot
            state={presence}
            size={11}
            className="absolute -bottom-0.5 -right-0.5 ring-2 ring-bg-elev"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-medium text-text-header">{person.nick}</span>
            {person.owner && <Tag tone="accent">{t('admin.people.owner')}</Tag>}
            {person.banned && <Tag tone="danger">{t('admin.people.banned')}</Tag>}
          </div>
          <div className="truncate font-mono text-[11px] tracking-[0.06em] text-text-faint">
            {shortFingerprint(person.fingerprint)}
          </div>
          <div className="truncate text-[12px] text-text-muted">
            {seenNote(t, person.lastSeenAt)}
          </div>
        </div>

        {/* Владельца не банят: сервер откажет (`forbidden`), потому что строка
            бана на инсталляцию и строка владельца — одна и та же. */}
        {!person.owner &&
          (person.banned ? (
            <button
              type="button"
              data-testid={`admin-unban-${person.fingerprint}`}
              onClick={onUnban}
              title={t('admin.bans.unban')}
              aria-label={t('admin.bans.unban')}
              className="shrink-0 rounded-[8px] px-2 py-1.5 text-text-muted outline-none transition-colors hover:bg-ok/10 hover:text-ok"
            >
              <Icon name="user-check" className="text-[17px]" />
            </button>
          ) : (
            <button
              type="button"
              data-testid={`admin-ban-${person.fingerprint}`}
              onClick={onBan}
              title={t('admin.people.ban')}
              aria-label={t('admin.people.ban')}
              className="shrink-0 rounded-[8px] px-2 py-1.5 text-text-muted outline-none transition-colors hover:bg-danger/10 hover:text-danger"
            >
              <Icon name="user-x" className="text-[17px]" />
            </button>
          ))}
      </div>

      {refusal && (
        <p
          data-testid={`admin-person-error-${person.fingerprint}`}
          className="mt-1.5 text-[12px] leading-relaxed text-danger"
        >
          {t(adminRefusalKey(refusal))}
        </p>
      )}

      {person.devices.length > 0 && (
        <>
          <button
            type="button"
            data-testid={`admin-devices-${person.fingerprint}`}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="mt-2 flex items-center gap-1 text-[12px] text-text-muted outline-none transition-colors hover:text-text"
          >
            <Icon name={open ? 'chevron-up' : 'chevron-down'} className="text-[14px]" />
            {t('admin.people.devices', { count: person.devices.length })}
          </button>
          {open && (
            <div className="mt-2 flex flex-col gap-1.5 border-t border-line pt-2">
              {person.devices.map((device) => (
                <DeviceRow key={device.id} device={device} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Устройство человека и кнопка его отзыва.
 *
 * Своё текущее устройство сервер отзывать не даёт, и панель не знает, какое из
 * чужой связки — её собственное: в протоколе такой пометки нет (§9.3), а гадать
 * по имени значило бы прятать кнопку не у того. Поэтому кнопка есть у всех, а
 * отказ объясняется словами ровно там, где его получили.
 */
function DeviceRow({ device }: { device: AdminDevice }) {
  const t = useT();
  const [refusal, setRefusal] = useState<AdminFieldError | null>(null);

  return (
    <div data-testid={`admin-device-${device.id}`} className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-text">{device.name}</div>
        <div className="truncate text-[11px] text-text-faint">{seenNote(t, device.lastSeenAt)}</div>
        {refusal && (
          <p className="text-[11px] leading-relaxed text-danger">
            {/* «Не владелец» здесь означало бы неправду: владение сервер уже
                проверил, отказ пришёл на том, что это устройство — наше. */}
            {refusal === 'forbidden' ? t('admin.people.device.self') : t(adminRefusalKey(refusal))}
          </p>
        )}
      </div>
      {device.revoked ? (
        <span className="shrink-0 text-[11px] uppercase tracking-[0.14em] text-text-faint">
          {t('admin.people.device.revoked')}
        </span>
      ) : (
        <button
          type="button"
          data-testid={`admin-revoke-${device.id}`}
          onClick={() => void useAdminStore.getState().revokeDevice(device.id).then(setRefusal)}
          className="shrink-0 rounded-[8px] px-2 py-1 text-[12px] text-text-muted outline-none transition-colors hover:bg-danger/10 hover:text-danger"
        >
          {t('admin.people.device.revoke')}
        </button>
      )}
    </div>
  );
}

/** Пометка у имени: владелец, забанен. */
function Tag({ tone, children }: { tone: 'accent' | 'danger'; children: string }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-[6px] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]',
        tone === 'danger' ? 'bg-danger/15 text-danger' : 'bg-bg-active text-text-muted',
      )}
    >
      {children}
    </span>
  );
}

/**
 * «Когда видели». Слово «в сети» здесь не пишется намеренно: сервер отмечает
 * личность в тот миг, когда она входит, и больше не трогает, — так что свежая
 * отметка означает «недавно входил», а не «сидит сейчас». В протоколе панели
 * (§9.3) признака присутствия по-прежнему нет — эта строка его и не изображает,
 * выдуманный по свежести отметки он врал бы ровно там, где на него посмотрят:
 * у того, кто закрыл вкладку минуту назад. Настоящее «сейчас» стоит рядом,
 * точкой на лице (`PresenceDot`) — оно приезжает отдельным путём, из
 * глобального стора присутствия (`stores/presence.ts`, задача 2 плана B), а
 * не из этого списка личностей.
 */
function seenNote(t: Translate, at: number | null): string {
  if (!at) return t('admin.people.never');
  return t('admin.people.seen', { when: fmtSince(new Date(at).toISOString()) });
}
