import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn 的慣例：合併 class，後面的 Tailwind 工具類別會覆蓋前面的衝突。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
