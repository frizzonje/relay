'use client';

/**
 * `setParameters` видео-sender'а — с запасным ходом и с отчётом.
 *
 * Вызов атомарный: движок, которому не понравилось одно поле, отвергает все
 * разом. `degradationPreference` — поле, которое знают не все движки и не во
 * всех версиях, и вместе с ним молча пропадали битрейт, кадры и масштаб слоёв:
 * смена разрешения в настройках не делала ровно ничего. Поэтому отказ с ним
 * повторяем без него — что беречь при нехватке, менее важно, чем сам кадр.
 */
export async function setSenderParameters(
  sender: RTCRtpSender,
  edit: (params: RTCRtpSendParameters) => void,
  degradation?: RTCDegradationPreference,
): Promise<string | null> {
  const attempt = async (withDegradation: boolean) => {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    edit(params);
    if (withDegradation && degradation) params.degradationPreference = degradation;
    await sender.setParameters(params);
  };
  try {
    await attempt(true);
    return null;
  } catch (first) {
    if (!degradation) return errorText(first);
    try {
      await attempt(false);
      return `degradationPreference refused (${errorText(first)})`;
    } catch (second) {
      console.warn('[video] setParameters failed:', second);
      return errorText(second);
    }
  }
}

function errorText(err: unknown): string {
  const e = err as { name?: string; message?: string } | null;
  return `${e?.name ?? 'Error'}: ${e?.message ?? String(err)}`.slice(0, 80);
}

/**
 * Кодировки, как их видит sender, и отказ, если был: «r0 /2.00 1.5M 30fps |
 * r1 /1.00 8.0M 30fps · maintain-resolution». Принятое движком — рядом с
 * отказом: это и есть «поменял настройку — ничего не изменилось».
 */
export function describeSender(sender: RTCRtpSender, failed: string | null): string {
  let accepted: string;
  try {
    const params = sender.getParameters();
    const layers = (params.encodings ?? []).map((e) => {
      const scale =
        e.scaleResolutionDownBy != null ? `/${e.scaleResolutionDownBy.toFixed(2)}` : '/?';
      const rate = e.maxBitrate != null ? `${(e.maxBitrate / 1e6).toFixed(1)}M` : '?M';
      const fps = e.maxFramerate != null ? `${e.maxFramerate}fps` : '?fps';
      return `${e.rid ?? '-'}${e.active === false ? ' off' : ''} ${scale} ${rate} ${fps}`;
    });
    accepted = `${layers.join(' | ')} · ${params.degradationPreference ?? 'deg?'}`;
  } catch {
    accepted = 'parameters unavailable';
  }
  return failed ? `${accepted} failed: ${failed}` : accepted;
}
