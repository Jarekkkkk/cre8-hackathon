import { displayAssetSymbol } from "./asset-display";

/** The underlying has one page; source contracts remain separate instruments. */
export function underlyingSlug(asset: { key: string; symbol: string; category: string }): string {
  if (asset.key === "XAUT") return "commodity-gold";
  const symbol = asset.category === "stock" ? displayAssetSymbol(asset.symbol) : asset.key;
  return `${asset.category === "stock" ? "stock" : "crypto"}-${symbol.toLowerCase()}`;
}
export function holdingAssetSlug(marketKey: string | undefined): string | null {
  if (!marketKey || !/^(stock|crypto|commodity):[A-Z0-9][A-Z0-9.-]*$/i.test(marketKey)) return null;
  return marketKey.replace(":", "-").toLowerCase();
}
/** An explicit return path may only refer to a known same-origin app page. */
export function assetReturnUrl(href: string, fallback: string): string {
  const here = new URL(href), home = new URL(fallback, here);
  const raw = here.searchParams.get("returnTo");
  if (!raw || raw.length > 4096) return home.href;
  try {
    const target = new URL(raw, here), root = home.pathname.replace(/vaults\/?$/, "");
    if (target.origin !== here.origin || target.username || target.password || ![`${root}create`, `${root}create/`, `${root}vaults`, `${root}vaults/`].includes(target.pathname) && !new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:vault|funds)/[a-z0-9-]+/?$`).test(target.pathname)) return home.href;
    return target.href;
  } catch { return home.href; }
}
