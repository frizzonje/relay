import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Объединяет классы и схлопывает конфликтующие Tailwind-утилиты. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
