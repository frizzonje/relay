import { cookies, headers } from 'next/headers';
import {
  LOCALE_COOKIE,
  isLocale,
  matchLocale,
  parseAcceptLanguage,
  type Locale,
} from './config';
import { translate, type MessageKey, type Vars } from './translate';

/**
 * The locale for this request: an explicit choice (cookie) wins, otherwise we
 * honour the browser's `Accept-Language`. Doing it server-side means the very
 * first paint is already in the right language, with no client-side swap — and
 * it works with JavaScript still loading.
 */
export async function getLocale(): Promise<Locale> {
  const chosen = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(chosen)) return chosen;
  return matchLocale(parseAcceptLanguage((await headers()).get('accept-language')));
}

/** `t` for server components and generateMetadata. */
export async function getT(): Promise<(key: MessageKey, vars?: Vars) => string> {
  const locale = await getLocale();
  return (key, vars) => translate(locale, key, vars);
}
