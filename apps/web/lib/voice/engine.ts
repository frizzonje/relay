'use client';

/**
 * WebKit — Safari и десктоп-оболочка macOS (WKWebView). У него свои пределы
 * там, где у остальных движков их нет: кодеки (sfu/screen-codec.ts) и захват
 * экрана (camera.ts). Экран WebKit снимает в точках, а не в пикселях, и не
 * чаще 30 кадров в секунду: на ретине 2560×1600 это 1280×800 при любых
 * ограничениях со стороны страницы (`DisplayCaptureSourceCocoa`, проверено на
 * Safari 27 2026-10-04).
 */
export function isWebKit(): boolean {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return /AppleWebKit\//.test(ua) && !/Chrome\/|Chromium\/|Edg\//.test(ua);
}

/** Потолок кадров захвата экрана в WebKit. */
export const WEBKIT_SCREEN_MAX_FPS = 30;
