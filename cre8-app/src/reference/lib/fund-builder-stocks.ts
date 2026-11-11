import { STOCK_CATALOG, validateStockCatalog, type StockCatalog } from "./stock-catalog";
import type { Asset } from "./fund-builder";

/** Complete App planning roster. Existing reviewed assets keep their keys and testnet admission state. */
export function additionalBstockPlanningAssets(reviewed: readonly Asset[], catalog: StockCatalog = STOCK_CATALOG): Asset[] {
  if (validateStockCatalog(catalog).length) return [];
  const known = new Set(reviewed.filter(asset => asset.category === "stock").map(asset => asset.token.toLowerCase()));
  return catalog.products.filter(product => product.chainId === 56 && product.issuer === "bstock" && !known.has(product.address))
    .map(product => ({
      key: `bstock:${product.ticker}`,
      name: catalog.products.find(other => other.chainId === 56 && other.issuer === "ondo" && other.ticker === product.ticker)?.name.replace(/\s*\(Ondo Tokenized\)$/, "") ?? product.ticker,
      symbol: product.symbol,
      token: product.address,
      targetId: `bstock:${product.symbol}`,
      category: "stock" as const,
      issuer: "bstock" as const,
      status: "preview" as const,
      earn: {},
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
}

/**
 * Snapshot identities for the App's saved designs, not trading admission. Keep the complete
 * same-chain bStock roster as the authority even when a bStock has no reviewed builder route.
 * Snapshot age does not erase a saved design; execution still requires fresh SDK evidence.
 */
export function ondoPlanningAssets(catalog: StockCatalog = STOCK_CATALOG, includeBstockAlternatives = false): Asset[] {
  if (validateStockCatalog(catalog).length) return [];
  const products = catalog.products.filter(product => product.chainId === 56);
  const bstocks = new Set(products.filter(product => product.issuer === "bstock").map(product => product.ticker));
  return products.filter(product => product.issuer === "ondo" && (includeBstockAlternatives || !bstocks.has(product.ticker)))
    .map(product => ({
      // Namespacing keeps stock tickers from colliding with crypto keys such as ETH.
      key: `ondo:${product.ticker}`,
      name: product.name.replace(/\s*\(Ondo Tokenized\)$/, ""),
      symbol: product.symbol,
      token: product.address,
      targetId: `ondo:${product.symbol}`,
      category: "stock" as const,
      issuer: "ondo" as const,
      status: "preview" as const,
      earn: {},
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
}
