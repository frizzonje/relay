'use client';

import { useCallback, useEffect, useState } from 'react';
import { Identicon } from '@/components/ui/Identicon';
import { Icon } from '@/components/ui/icon';
import { fmtSince } from '@/lib/format';
import { listDevices, revokeDevice, DeviceError, type Device } from '@/lib/devices';
import { useIdentityStore } from '@/stores/identity';
import { useOwnerStore } from '@/stores/owner';
import { usePairingStore } from '@/stores/pairing';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { LinkDeviceDialog } from './LinkDevicePanel';
import { failureText } from './pair-failure';

/**
 * Своя карточка личности: лицо ключа, отпечаток и все свои устройства.
 *
 * Список нужен не для порядка. Ключ у каждого устройства свой, и без этого
 * экрана человек не может ни увидеть, что вошёл откуда-то ещё, ни закрыть тот
 * вход. Отозванные не прячутся: пропади они, и убедиться, что отзыв случился,
 * было бы негде.
 */
export function DevicesPanel() {
  const t = useT();
  const me = useIdentityStore((s) => s.me);
  const admit = usePairingStore((s) => s.admit);
  const [devices, setDevices] = useState<Device[] | null>(null);
  // Владельца спрашивает вход (AppShell) — здесь только читаем: два экрана,
  // задающие один и тот же вопрос по-своему, рано или поздно расходятся.
  const owner = useOwnerStore((s) => s.owner);
  const [failed, setFailed] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [complaint, setComplaint] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDevices(await listDevices());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(device: Device) {
    setAsking(null);
    try {
      await revokeDevice(device.id);
      await load();
    } catch (err) {
      setComplaint(t(failureText(err instanceof DeviceError ? err.reason : 'network')));
    }
  }

  // Связать ЭТО устройство можно, только пока личность состоит из него одного:
  // дальше связка превратилась бы в слияние двух биографий, и сервер откажет.
  const alone = devices?.length === 1 && devices[0].current;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <Identicon
          fingerprint={me?.fingerprint ?? ''}
          size={44}
          className="shrink-0 rounded-xl ring-1 ring-inset ring-white/10"
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-[15px] font-semibold text-text-header">@{me?.nick}</span>
            {owner && (
              <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-accent">
                {t('owner.badge')}
              </span>
            )}
          </div>
          <div
            className="select-all font-mono text-[11px] tracking-[0.08em] text-text-muted"
            title={t('identity.fingerprint.hint')}
          >
            {me?.fingerprint}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-[12.5px] leading-relaxed text-text-muted">{t('devices.intro')}</p>

        {failed && (
          <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-[13px] text-danger">
            {t('devices.failed')}
          </p>
        )}

        {devices?.map((device) => (
          <div
            key={device.id}
            className={cn(
              'rounded-[10px] border border-line bg-bg-elev/60 px-3.5 py-3',
              device.revokedAt && 'opacity-60',
            )}
          >
            <div className="flex items-center gap-3">
              <Identicon
                fingerprint={device.fingerprint}
                size={34}
                className="shrink-0 rounded-lg ring-1 ring-inset ring-white/10"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[14px] font-medium text-text-header">
                    {device.name}
                  </span>
                  {device.current && (
                    <span className="shrink-0 rounded-full bg-ok/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-ok">
                      {t('devices.current')}
                    </span>
                  )}
                  {device.revokedAt && (
                    <span className="shrink-0 rounded-full bg-danger/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-danger">
                      {t('devices.revoked')}
                    </span>
                  )}
                </div>
                <div className="truncate text-[12px] text-text-muted">
                  {device.revokedAt
                    ? t('devices.revokedAt', { when: fmtSince(device.revokedAt) })
                    : device.lastSeenAt
                      ? t('devices.lastSeen', { when: fmtSince(device.lastSeenAt) })
                      : t('devices.never')}
                </div>
              </div>

              {!device.current && !device.revokedAt && (
                <button
                  type="button"
                  onClick={() => setAsking(device.id)}
                  aria-label={t('devices.revoke')}
                  title={t('devices.revoke')}
                  className="shrink-0 rounded-[8px] px-2 py-1.5 text-text-muted outline-none transition-colors hover:bg-danger/10 hover:text-danger"
                >
                  <Icon name="user-x" className="text-[17px]" />
                </button>
              )}
            </div>

            {/* Последствие сказано до нажатия, а не после: отозванный ключ
                вернуть нельзя, устройство придётся связывать заново. */}
            {asking === device.id && (
              <div className="mt-3 border-t border-line pt-3">
                <p className="text-[12.5px] leading-snug text-text-muted">
                  {t('devices.revoke.body', { name: device.name })}
                </p>
                <div className="mt-2.5 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setAsking(null)}
                    className="rounded-[8px] px-3 py-1.5 text-[13px] text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void revoke(device)}
                    className="rounded-[8px] bg-danger/15 px-3 py-1.5 text-[13px] font-medium text-danger outline-none transition-colors hover:bg-danger/25"
                  >
                    {t('devices.revoke.action')}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}

        {complaint && <p className="text-[12.5px] leading-snug text-danger">{complaint}</p>}
      </div>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => admit()}
          className="flex items-center gap-2 rounded-[8px] border border-line-strong bg-bg-active px-3 py-2 text-[14px] text-text outline-none transition-colors hover:bg-line-strong"
        >
          <Icon name="plus" className="text-[16px]" />
          {t('devices.admit')}
        </button>
        <p className="px-1 text-[11.5px] leading-snug text-text-muted">{t('devices.admit.hint')}</p>

        {alone && (
          <>
            <button
              type="button"
              onClick={() => setLinking(true)}
              className="mt-2 rounded-[8px] px-3 py-2 text-left text-[14px] text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text"
            >
              {t('devices.link')}
            </button>
            <p className="px-1 text-[11.5px] leading-snug text-text-muted">
              {t('devices.link.hint')}
            </p>
          </>
        )}
      </div>

      <LinkDeviceDialog open={linking} onOpenChange={setLinking} />
    </div>
  );
}
