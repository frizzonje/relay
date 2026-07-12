import { cn } from '@/lib/utils';

/**
 * SVG line-icons, отрисованные как CSS-маска и покрашенные currentColor
 * (см. `.ico` в globals.css). Имя = файл в /img/icons/<name>.svg.
 */
export type IconName =
  | 'chevron-up'
  | 'headphone-off'
  | 'headphones'
  | 'maximize-2'
  | 'mic-off'
  | 'mic'
  | 'minimize-2'
  | 'phone-off'
  | 'plus'
  | 'screen-share-off'
  | 'screen-share'
  | 'video-off'
  | 'video'
  | 'volume-2'
  | 'volume-x';

interface IconProps extends React.HTMLAttributes<HTMLSpanElement> {
  name: IconName;
}

export function Icon({ name, className, style, ...props }: IconProps) {
  return (
    <span
      aria-hidden
      className={cn('ico', className)}
      style={{ ['--icon' as string]: `url(/img/icons/${name}.svg)`, ...style }}
      {...props}
    />
  );
}
