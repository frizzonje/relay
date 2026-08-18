import { memo } from 'react';
import { identicon } from '@/lib/identicon';
import { cn } from '@/lib/utils';

/**
 * Лицо личности — поле, выведенное из отпечатка ключа (см. lib/identicon, там
 * же почему оно вообще нужно и почему считается ровно так). Здесь только показ:
 * ни состояния, ни случая, ни сети — один и тот же отпечаток обязан дать одну и
 * ту же картинку в ленте, в составе канала и на экране первого входа.
 *
 * Разметка вставляется как есть, и это безопасно: в строку SVG не попадает сам
 * отпечаток — только числа, выведенные из его хеша. Подставить туда нечего.
 *
 * По умолчанию картинка декоративна и от скринридера спрятана: рядом с ней
 * всегда стоит ник, а описывать вслух свечение — шум. `title` включает её
 * обратно, когда identicon стоит один (кнопка, аватар без подписи).
 */
export const Identicon = memo(function Identicon({
  fingerprint,
  size = 32,
  speaking = false,
  still = false,
  title,
  className,
}: {
  fingerprint: string;
  /** Сторона в пикселях. Рисунок векторный — берёт любую; ниже 30 упрощается. */
  size?: number;
  /**
   * Человек сейчас говорит: поле бьётся поясами изнутри наружу. Берётся из того
   * же источника, что и обводка плитки, — иначе лицо и рамка спорили бы.
   */
  speaking?: boolean;
  /**
   * Совсем без движения — там, где лиц на экране может быть сколько угодно.
   * Не «остановленная анимация»: остановленная всё равно держит слой.
   */
  still?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <span
      // Речь — класс, а не другая картинка: разметка от неё не зависит вовсе,
      // поэтому React при «заговорил» меняет один атрибут и не трогает SVG, а
      // дрейф поля продолжается с того места, где шёл.
      className={cn('rl-identicon', speaking && 'rl-identicon-speaking', className)}
      style={{ width: size, height: size }}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      title={title}
      dangerouslySetInnerHTML={{ __html: identicon(fingerprint, size, { still }) }}
    />
  );
});
