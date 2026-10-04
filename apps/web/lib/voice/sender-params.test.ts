import { describe, expect, it, vi } from 'vitest';
import { describeSender, setSenderParameters } from './sender-params';

function fakeSender(reject: (params: RTCRtpSendParameters) => Error | null) {
  let stored: RTCRtpSendParameters = {
    transactionId: 't',
    encodings: [{ rid: 'r0', scaleResolutionDownBy: 2, maxBitrate: 1_500_000, maxFramerate: 30 }],
    codecs: [],
    headerExtensions: [],
    rtcp: {},
  };
  const sender = {
    getParameters: () => structuredClone(stored),
    setParameters: vi.fn(async (params: RTCRtpSendParameters) => {
      const err = reject(params);
      if (err) throw err;
      stored = params;
    }),
  };
  return sender as unknown as RTCRtpSender & { setParameters: typeof sender.setParameters };
}

describe('setSenderParameters', () => {
  it('движок принял всё — без второй попытки', async () => {
    const sender = fakeSender(() => null);
    const failed = await setSenderParameters(
      sender,
      (p) => (p.encodings[0].maxBitrate = 8_000_000),
      'maintain-resolution',
    );
    expect(failed).toBeNull();
    expect(sender.setParameters).toHaveBeenCalledTimes(1);
    expect(sender.getParameters().degradationPreference).toBe('maintain-resolution');
  });

  /**
   * Вызов атомарный: отказ из-за одного поля уносил и битрейт, и масштаб —
   * смена разрешения не делала ничего. Без спорного поля — проходит.
   */
  it('отказ из-за degradationPreference — кодировки всё равно применяются', async () => {
    const sender = fakeSender((p) =>
      p.degradationPreference ? new DOMException('nope', 'InvalidModificationError') : null,
    );
    const failed = await setSenderParameters(
      sender,
      (p) => (p.encodings[0].scaleResolutionDownBy = 1),
      'maintain-resolution',
    );
    expect(sender.getParameters().encodings[0].scaleResolutionDownBy).toBe(1);
    expect(failed).toContain('degradationPreference refused');
  });

  it('отказ без спорного поля — его текст для лога', async () => {
    const sender = fakeSender(() => new DOMException('bad scale', 'RangeError'));
    expect(await setSenderParameters(sender, () => {})).toBe('RangeError: bad scale');
  });
});

describe('describeSender', () => {
  it('кодировки как их видит sender — и отказ рядом', () => {
    const sender = fakeSender(() => null);
    expect(describeSender(sender, 'X')).toBe('r0 /2.00 1.5M 30fps · deg? failed: X');
  });

  it('sender без параметров не роняет отчёт', () => {
    const broken = {
      getParameters: () => {
        throw new Error('closed');
      },
    } as unknown as RTCRtpSender;
    expect(describeSender(broken, null)).toBe('parameters unavailable');
  });
});
