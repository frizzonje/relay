'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { PAIR_CODE_DIGITS, readPairCode } from '@relay/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Identicon } from '@/components/ui/Identicon';
import {
  admitDevice,
  peekPairing,
  DeviceError,
  type DeviceFailure,
  type PairOffer,
} from '@/lib/devices';
import { useIdentityStore } from '@/stores/identity';
import { usePairingStore } from '@/stores/pairing';
import { useT } from '@/lib/i18n';
import { failureText } from './pair-failure';

/**
 * Экран того, кто впускает: у него личность уже есть, и он ручается за новый
 * ключ своей подписью.
 *
 * Здесь единственное место во всём слое 2, где человека спрашивают всерьёз.
 * Ссылка из QR открывает этот экран сама (её ловит AppShell), а значит, открыть
 * его может и посторонний, прислав ссылку в чат. Поэтому экран не «подтвердите
 * действие», а «это ваше устройство?» — с отпечатком, именем и прямым
 * предупреждением. Впустивший чужой ключ отдаёт свою личность навсегда.
 */

type Phase =
  | { kind: 'entry' }
  | { kind: 'looking' }
  | { kind: 'found'; code: string; offer: PairOffer }
  | { kind: 'admitting'; code: string; offer: PairOffer }
  | { kind: 'done' }
  | { kind: 'failed'; reason: DeviceFailure };

export function AdmitDeviceDialog() {
  const t = useT();
  const code = usePairingStore((s) => s.admitting);
  const close = usePairingStore((s) => s.close);
  const identityId = useIdentityStore((s) => s.me?.id);
  const [phase, setPhase] = useState<Phase>({ kind: 'entry' });
  const [draft, setDraft] = useState('');

  const look = useCallback(async (raw: string) => {
    const clean = readPairCode(raw);
    if (!clean) return;
    setPhase({ kind: 'looking' });
    try {
      setPhase({ kind: 'found', code: clean, offer: await peekPairing(clean) });
    } catch (err) {
      setPhase({ kind: 'failed', reason: err instanceof DeviceError ? err.reason : 'network' });
    }
  }, []);

  // Открылись — начинаем с чистого листа. Код из ссылки проверяем сразу: он уже
  // введён человеком, просто не руками.
  useEffect(() => {
    if (code === null) return;
    setDraft('');
    setPhase({ kind: 'entry' });
    if (code) void look(code);
  }, [code, look]);

  async function admit() {
    if (phase.kind !== 'found' || !identityId) return;
    setPhase({ kind: 'admitting', code: phase.code, offer: phase.offer });
    try {
      await admitDevice(phase.code, identityId, phase.offer.publicKey);
      setPhase({ kind: 'done' });
      toast(t('pair.admit.done'));
    } catch (err) {
      setPhase({ kind: 'failed', reason: err instanceof DeviceError ? err.reason : 'network' });
    }
  }

  return (
    <Dialog open={code !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{t('pair.admit.title')}</DialogTitle>
          <DialogDescription>
            {phase.kind === 'found' || phase.kind === 'admitting'
              ? t('pair.admit.confirm.body')
              : t('pair.admit.body')}
          </DialogDescription>
        </DialogHeader>

        {(phase.kind === 'entry' || phase.kind === 'looking') && (
          <CodeEntry
            value={draft}
            busy={phase.kind === 'looking'}
            onChange={setDraft}
            onSubmit={() => void look(draft)}
            onScan={(text) => void look(text)}
          />
        )}

        {(phase.kind === 'found' || phase.kind === 'admitting') && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3 rounded-[10px] border border-line bg-bg-elev/60 px-3.5 py-3">
              {/* Лицо ключа — то же, что новичок показывает у себя на экране:
                  сверяют глазами именно его, а не имя устройства. */}
              <Identicon
                fingerprint={phase.offer.fingerprint}
                size={38}
                className="shrink-0 rounded-lg ring-1 ring-inset ring-white/10"
              />
              <div className="min-w-0">
                <div className="truncate text-[14px] font-medium text-text-header">
                  {phase.offer.deviceName}
                </div>
                <div className="font-mono text-[11px] tracking-[0.08em] text-text-muted">
                  {phase.offer.fingerprint}
                </div>
              </div>
            </div>
            <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-[12px] leading-snug text-danger">
              {t('pair.admit.confirm.warn')}
            </p>
          </div>
        )}

        {phase.kind === 'failed' && (
          <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-[13px] text-danger">
            {t(failureText(phase.reason))}
          </p>
        )}

        {phase.kind === 'done' && (
          <p className="rounded-lg border border-ok/30 bg-ok/10 px-3 py-2.5 text-[13px] text-ok">
            {t('pair.admit.done')}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={close}>
            {phase.kind === 'done' ? t('common.close') : t('common.cancel')}
          </Button>
          {phase.kind === 'found' && (
            <Button type="button" variant="primary" onClick={() => void admit()}>
              {t('pair.admit.confirm.action')}
            </Button>
          )}
          {phase.kind === 'failed' && (
            <Button type="button" variant="primary" onClick={() => setPhase({ kind: 'entry' })}>
              {t('pair.retry')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Поле на шесть цифр и, если движок умеет, камера. */
function CodeEntry({
  value,
  busy,
  onChange,
  onSubmit,
  onScan,
}: {
  value: string;
  busy: boolean;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onScan: (text: string) => void;
}) {
  const t = useT();
  const [scanning, setScanning] = useState(false);
  const ready = readPairCode(value) !== null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^\d\s]/g, ''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && ready) onSubmit();
          }}
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          maxLength={PAIR_CODE_DIGITS + 2}
          placeholder={t('pair.admit.placeholder')}
          className="min-w-0 flex-1 rounded-lg border border-black/40 bg-bg-deep/70 px-3 py-2.5 text-center font-mono text-[20px] tracking-[0.18em] text-text-header outline-none focus:border-accent"
        />
        <Button type="button" variant="primary" disabled={!ready || busy} onClick={onSubmit}>
          {t('pair.admit.next')}
        </Button>
      </div>

      {scanning ? (
        <Scanner onFound={onScan} onGiveUp={() => setScanning(false)} />
      ) : (
        canScan() && (
          <button
            type="button"
            onClick={() => setScanning(true)}
            className="rounded-[8px] px-3 py-2 text-[13px] text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text"
          >
            {t('pair.admit.scan')}
          </button>
        )
      )}
    </div>
  );
}

/**
 * Камера. Декодер берём системный (`BarcodeDetector`) и не тащим свой: он есть
 * не везде, но там, где его нет, у человека остаётся ровно то же поле на шесть
 * цифр — а сорок килобайт распознавателя в бандле остались бы у всех и навсегда
 * ради экрана, который видят раз в жизни устройства.
 */
function Scanner({ onFound, onGiveUp }: { onFound: (text: string) => void; onGiveUp: () => void }) {
  const t = useT();
  const video = useRef<HTMLVideoElement>(null);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let alive = true;

    void (async () => {
      try {
        // Задняя камера: код показывают на другом экране, и снимают его именно
        // ею. Это пожелание, а не требование — ноутбук отдаст единственную.
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        if (!alive || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play().catch(() => {});
        const detector = new (
          window as unknown as { BarcodeDetector: BarcodeDetectorLike }
        ).BarcodeDetector({ formats: ['qr_code'] });
        timer = setInterval(async () => {
          if (!video.current) return;
          const found = await detector.detect(video.current).catch(() => []);
          const text = found[0]?.rawValue;
          if (text) onFound(text);
        }, 300);
      } catch {
        if (alive) setDenied(true);
      }
    })();

    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [onFound]);

  if (denied) {
    return (
      <p className="rounded-lg border border-line bg-bg-elev px-3 py-2.5 text-[12px] leading-snug text-text-muted">
        {t('pair.admit.scan.denied')}
      </p>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-[10px] border border-line bg-black">
      <video ref={video} muted playsInline className="h-[200px] w-full object-cover" />
      <button
        type="button"
        onClick={onGiveUp}
        className="absolute bottom-2 right-2 rounded-[8px] bg-black/60 px-2.5 py-1 text-[12px] text-white outline-none"
      >
        {t('common.cancel')}
      </button>
    </div>
  );
}

interface BarcodeDetectorLike {
  new (options: { formats: string[] }): {
    detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
  };
}

function canScan(): boolean {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window;
}
