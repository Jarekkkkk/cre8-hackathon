/**
 * 純格式化層：沒有 DOM、沒有 fetch、沒有 React，所以可以直接用 `bun -e` 驗算。
 *
 * 金額一律從 **1e8 定點的十進位字串**（後端的 `usdE8`）換算，過程走 BigInt —— 用 Number 會在
 * 大額（> 2^53）失真，而這個 app 顯示的是投組價值，失真不可接受。
 */

/**
 * `"51133807293686"` → `"$511,338.07"`。
 *
 * **截斷，不是四捨五入。** 刻意的：後端自己的文字摘要也是逐資產整數除法截斷，兩邊用同一種規則才不會
 * 出現「app 說 $1.005、後端說 $1.00」。代價是逐列相加可能比總額少 0.01 —— 那不是算錯。
 */
export function formatUsdE8(usdE8: string): string {
  const negative = usdE8.startsWith('-');
  const digits = negative ? usdE8.slice(1) : usdE8;
  const padded = digits.padStart(9, '0');
  const whole = padded.slice(0, -8);
  const fraction = padded.slice(-8).slice(0, 2);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${grouped}.${fraction}`;
}

/** `2006` → `"+2006 bps"`；`0` → `"0 bps"`。 */
export function formatBps(bps: number): string {
  if (bps === 0) return '0 bps';
  return `${bps > 0 ? '+' : ''}${bps} bps`;
}

/** 位元組層級的方向語意：正 = 超配、負 = 低配。 */
export function toneForBps(bps: number): 'pos' | 'neg' | 'muted' {
  if (bps === 0) return 'muted';
  return bps > 0 ? 'pos' : 'neg';
}

/** `"0x2b082fadf8f3d620eaa242a9e36817af8640d042"` → `"0x2b08…d042"`。 */
export function shortAddress(address: string, head = 6, tail = 4): string {
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

/** ISO → `"2027-11-06 17:11"`（本地時區；顯示用，不參與計算）。 */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** 到期前還剩幾天（可為負）。`null` = 解析不出來。 */
export function daysUntil(iso: string, now: Date = new Date()): number | null {
  const target = new Date(iso);
  if (Number.isNaN(target.getTime())) return null;
  return Math.floor((target.getTime() - now.getTime()) / 86_400_000);
}
