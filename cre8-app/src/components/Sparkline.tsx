import type { ReactNode } from 'react';

/**
 * 一條 sparkline。座標點來自參考站（見 `data/mock-performance.ts`），viewBox 也是它們的 320×64。
 *
 * `aria-label` 說明這是模擬區間，因為它看起來像真實走勢圖 —— 不標就會被當成事實。
 */
export function Sparkline({
  points,
  positive,
  label,
}: {
  points: readonly (readonly [number, number])[];
  positive: boolean;
  label: string;
}): ReactNode {
  if (points.length < 2) return null;
  const d = points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x},${y}`).join(' ');
  return (
    <svg viewBox="0 0 320 64" role="img" aria-label={label} className={positive ? 'pos' : 'neg'}>
      <path d={d} />
    </svg>
  );
}
