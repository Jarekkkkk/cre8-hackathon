// App planning only. Execution still uses the separately reviewed SDK/contract admission policy.
import snapshot from "../data/stock-liquidity/source-comparison.json" with { type: "json" };
import { STOCK_CATALOG, validateStockCatalog, type StockCatalog, type StockIssuer } from "./stock-catalog";
import { STOCK_LIQUIDITY_POLICY, stockLiquiditySufficient, type StockLiquidityEntry } from "./stock-liquidity-policy";

export type SourceQuotes = {
  schema: string; chainId: number; indicativeOnly: boolean; sourceUrl: string; capturedAt: string;
  entries: (StockLiquidityEntry & { ticker: string; issuer: StockIssuer })[];
};
export const SOURCE_QUOTE_MAX_AGE_MS = 15 * 60 * 1000;
const DEFAULT_CATALOG_VALID = validateStockCatalog(STOCK_CATALOG).length === 0;
export type SourceRecommendation = { issuer: StockIssuer; basis: "comparable-quotes" | "bstock-fallback" | "only-source"; detail: string };
export function recommendStockSource(ticker: string, options: { quotes?: SourceQuotes; nowMs?: number; catalog?: StockCatalog } = {}): SourceRecommendation {
  const catalog = options.catalog ?? STOCK_CATALOG;
  const valid = catalog === STOCK_CATALOG ? DEFAULT_CATALOG_VALID : validateStockCatalog(catalog).length === 0;
  const products = valid ? catalog.products.filter(p => p.chainId === 56 && p.ticker === ticker) : [];
  const bstock = products.find(p => p.issuer === "bstock"), ondo = products.find(p => p.issuer === "ondo");
  if (!bstock && ondo) return { issuer: "ondo", basis: "only-source", detail: "Only Ondo is listed for this stock." };
  const fallback: SourceRecommendation = { issuer: "bstock", basis: "bstock-fallback", detail: "bStock preferred: comparable open-market quotes are unavailable or stale. You can switch sources manually." };
  if (!bstock || !ondo) return bstock ? { issuer: "bstock", basis: "only-source", detail: "Only bStock is listed for this stock." } : fallback;
  const quotes = options.quotes ?? snapshot as SourceQuotes, now = options.nowMs ?? Date.now();
  const captured = Date.parse(quotes.capturedAt);
  if (quotes.schema !== "cre8/stock-source-quotes@1" || quotes.chainId !== 56 || quotes.indicativeOnly !== true
    || quotes.sourceUrl !== "https://x.pancakeswap.com/order-price/get-price" || !Array.isArray(quotes.entries)
    || !Number.isFinite(now) || !Number.isFinite(captured) || captured > now || now - captured > SOURCE_QUOTE_MAX_AGE_MS) return fallback;
  const rows = [bstock, ondo].map(product => {
    const matches = quotes.entries.filter(e => e.token === product.address);
    return matches.length === 1 && matches[0].issuer === product.issuer && matches[0].ticker === ticker ? matches[0] : null;
  });
  if (rows.some(row => !row || row.method !== "pcsx-indicative-rfq" || row.errors?.length || !stockLiquiditySufficient(row))) return fallback;
  const legs = rows.flatMap(row => [row!.small!, row!.buy!, row!.sell!]);
  const times = legs.map(q => Date.parse(q.quotedAt));
  if (legs.some(q => q.marketStatus !== "open") || Math.max(...times) - Math.min(...times) > 60000
    || times.some(at => at > captured || now - at > SOURCE_QUOTE_MAX_AGE_MS)) return fallback;
  // Compare the same 50,000-USDT round trip with both quoted output floors, never pool TVL vs RFQ size.
  const size = BigInt(STOCK_LIQUIDITY_POLICY.notionalRaw);
  const loss = rows.map(row => size > BigInt(row!.sell!.minOutputRaw) ? size - BigInt(row!.sell!.minOutputRaw) : 0n);
  const issuer = loss[1] < loss[0] ? "ondo" : "bstock";
  return { issuer, basis: "comparable-quotes", detail: `${issuer === "ondo" ? "Ondo" : "bStock"} has the better indicative 50,000-USDT round-trip quote (or ties in bStock's favor). Checked ${quotes.capturedAt}. A fill is not guaranteed.` };
}
