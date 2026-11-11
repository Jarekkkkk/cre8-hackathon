import type { AssetPreview } from "./asset-preview";
export type UnderlyingQuote = { symbol: string; name: string; kind: string; marketCap: number | null; change24h: number | null; asOf: string | null; source: string | null; marketCapNote?: string; unavailable?: string; aum?: number; estimatedValue?: number; sizeAsOf?: string; sizeSource?: string; sizeCapturedAt?: string; sizeNote?: string };
export type HoldingIdentity = { symbol: string; ticker: string; address: string; issuer: string; chainId: number; marketKey: string };
export type HoldingInput = { id: string; symbol: string; weight: number | null; chainId: number; address?: string; name?: string };
export type HoldingSizeKind = "market-cap" | "aum" | "estimated-value";
export type HoldingView = HoldingInput & { asset: string; identity: HoldingIdentity | null; quote: UnderlyingQuote | null; marketCap: number | null; size: number | null; sizeKind: HoldingSizeKind | null; change24h: number | null; preview: AssetPreview | null };
export type HoldingSort = "asset" | "weight" | "size" | "change24h";
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function createHoldingsModel(snapshot: { capturedAt: string; sizeCapturedAt?: string; assets: Record<string, UnderlyingQuote> }, identities: HoldingIdentity[], previews:Record<string,AssetPreview>={}) {
  const byAddress = new Map(identities.map(i => [`${i.chainId}:${i.address.toLowerCase()}`, i]));
  const bySymbol = new Map(identities.map(i => [`${i.chainId}:${i.symbol}`, i]));
  return {
    capturedAt: snapshot.capturedAt,
    sizeCapturedAt: snapshot.sizeCapturedAt ?? null,
    resolve(row: HoldingInput): HoldingView {
      // An explicit address must match: never replace a different token with a familiar ticker.
      const identity = (row.address ? byAddress.get(`${row.chainId}:${row.address.toLowerCase()}`) : bySymbol.get(`${row.chainId}:${row.symbol}`)) ?? null;
      const marketKey=identity?.marketKey??(!row.address&&previews[`stock:${row.symbol}`]?`stock:${row.symbol}`:null);
      const quote = marketKey&&marketKey!=="crypto:USDT" ? snapshot.assets[marketKey] ?? null : null;
      const marketCap = quote && ["equity", "crypto"].includes(quote.kind) && finite(quote.marketCap) && quote.marketCap > 0 ? quote.marketCap : null;
      const metric = quote?.kind === "etf" ? quote.aum : quote?.kind === "commodity" ? quote.estimatedValue : marketCap;
      const size = finite(metric) && metric > 0 ? metric : null;
      return { ...row, asset: identity?.ticker ?? row.symbol, identity, quote, preview: marketKey ? previews[marketKey]??null : null,
        marketCap,
        size, sizeKind: size == null ? null : quote?.kind === "etf" ? "aum" : quote?.kind === "commodity" ? "estimated-value" : "market-cap",
        change24h: quote && finite(quote.change24h) ? quote.change24h : null };
    },
    sort(rows: HoldingView[], key: HoldingSort, direction: "asc" | "desc") {
      return [...rows].sort((a, b) => {
        const av = key==="asset"?a.preview?.name??a.asset:a[key], bv = key==="asset"?b.preview?.name??b.asset:b[key];
        const missingA = av == null || typeof av === "number" && !finite(av), missingB = bv == null || typeof bv === "number" && !finite(bv);
        if (missingA !== missingB) return missingA ? 1 : -1;
        const cmp = missingA ? 0 : typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv, "en") : Number(av) - Number(bv);
        return cmp ? cmp * (direction === "asc" ? 1 : -1) : a.asset.localeCompare(b.asset, "en") || a.id.localeCompare(b.id, "en");
      });
    },
    size(value: number | null) { return value != null && finite(value) && value > 0 ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(value) : "—"; },
    change(value: number | null) {
      if (value == null || !finite(value)) return "—";
      const n = Math.abs(value) < .005 ? 0 : value;
      return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
    },
  };
}
