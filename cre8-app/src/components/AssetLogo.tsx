import {assetBySymbol} from '../lib/public-funds';
import { useState } from 'react';
import type { ReactNode } from 'react';

/**
 * 一個代幣／股票的圓形 logo。
 *
 * 路徑照原站（`/logos/stocks/underlying/nvda.png`），但我們的資產清單比原站寬（WBNB、CRCLB…），
 * 而 logo 檔不是每個符號都有。所以依序試幾個候選路徑，全部失敗就不 render ——
 * **不畫一個假的圓圈**：缺圖比錯圖誠實。
 */
function candidates(symbol: string): string[] {
  const lower = symbol.toLowerCase();
  // bStock 的顯示符號常常帶尾碼 B（NVDAB / CRCLB），底層 logo 沒有那個 B。
  const underlying = lower.endsWith('b') ? lower.slice(0, -1) : lower;
  return [
    ...(assetBySymbol(symbol)?.logo?[assetBySymbol(symbol)!.logo]:[]),
    `/logos/tokens/${lower}.png`,
    `/logos/stocks/underlying/${underlying}.png`,
    `/logos/stocks/${lower}.png`,
  ];
}

export function AssetLogo({ symbol }: { symbol: string }): ReactNode {
  const list = candidates(symbol);
  const [index, setIndex] = useState(0);

  if (index >= list.length) return null;

  return (
    <img
      src={list[index]}
      alt=""
      loading="lazy"
      // 找不到就試下一個候選；全部都沒有就讓它消失（`.fund-row-logos img` 是 16px 的圓形）。
      onError={() => setIndex((current) => current + 1)}
    />
  );
}

/** 一列前 4 個資產的 logo（原站的 `fund-row-logos` 也是 4 個）。 */
export function AssetLogos({ symbols }: { symbols: readonly string[] }): ReactNode {
  return (
    <span className="fund-row-logos">
      {symbols.slice(0, 4).map((symbol) => (
        <AssetLogo key={symbol} symbol={symbol} />
      ))}
    </span>
  );
}
