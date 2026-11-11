// Issuer selection is separate from route admission. A selected product is not permission to trade it.
// The complete issuer lists, not the smaller executable-assets list, establish whether bStock exists.
import snapshot from "./stock-catalog-data";

export type StockIssuer = "bstock" | "ondo";
export type StockProduct = {
  issuer: StockIssuer;
  chainId: number;
  /** Exact underlying ticker including share class, e.g. BRK.B. Never a fuzzy company-name match. */
  ticker: string;
  name: string;
  symbol: string;
  address: string;
  decimals: number;
  sourceUrl: string;
  /** Value the actual token. Do not assume one raw token is one underlying share. */
  pricingBasis: "token-total-return";
};
export type StockCatalogSource = {
  issuer: StockIssuer;
  chainId: number;
  url: string;
  fetchedAt: string;
  sha256: string;
  complete: boolean;
  /** Product count on this chain, after explicit exclusions (cash/portfolio products). */
  productCount: number;
  rawChainTokenCount: number;
  excludedTokenCount: number;
};
export type StockCatalog = {
  schema: "cre8-stock-catalog-v1";
  policy: "bstock-first-existence-only";
  sources: StockCatalogSource[];
  products: StockProduct[];
};

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Cached official identity metadata; it does not certify pools, oracle freshness, eligibility or execution. */
export const STOCK_CATALOG: StockCatalog = freeze(snapshot);
/** Absence is useful evidence only while the entire catalog is fresh. */
export const STOCK_CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const TICKER = /^[A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)?$/;
const SYMBOL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const ISSUERS: readonly StockIssuer[] = ["bstock", "ondo"];
export const STOCK_CATALOG_SOURCE_URLS: Record<StockIssuer, string> = {
  bstock: "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai?type=3",
  ondo: "https://raw.githubusercontent.com/ondoprotocol/ondo-global-markets-token-list/main/tokenlist.json",
};

/** Preserve punctuation/share class; casing and surrounding ASCII whitespace are the only normalization. */
export function normalizeStockTicker(value: string): string | null {
  if (typeof value !== "string") return null;
  const ticker = value.trim().toUpperCase();
  return TICKER.test(ticker) && ticker.length <= 20 ? ticker : null;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Structural checks for trusted source snapshots. A user-supplied catalog is never an authority for absence. */
export function validateStockCatalog(value: unknown): string[] {
  if (!object(value) || value.schema !== "cre8-stock-catalog-v1" || value.policy !== "bstock-first-existence-only"
    || !Array.isArray(value.sources) || !Array.isArray(value.products)) return ["invalid-catalog"];
  const errors: string[] = [];
  const sources = new Map<string, StockCatalogSource>();
  for (const row of value.sources) {
    if (!object(row) || !ISSUERS.includes(row.issuer as StockIssuer) || !integer(row.chainId) || !row.chainId
      || row.url !== STOCK_CATALOG_SOURCE_URLS[row.issuer as StockIssuer]
      || typeof row.fetchedAt !== "string" || !Number.isFinite(Date.parse(row.fetchedAt))
      || typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256)
      || row.complete !== true || !integer(row.productCount) || row.productCount === 0
      || !integer(row.rawChainTokenCount) || !integer(row.excludedTokenCount)
      || row.rawChainTokenCount !== row.productCount + row.excludedTokenCount) {
      errors.push("invalid-or-incomplete-source");
      continue;
    }
    const key = `${row.chainId}:${row.issuer}`;
    if (row.chainId === 56 && row.productCount < (row.issuer === "bstock" ? 105 : 474)) errors.push("catalog-below-reviewed-baseline");
    if (sources.has(key)) errors.push("duplicate-source");
    sources.set(key, row as StockCatalogSource);
  }
  const identities = new Set<string>(), addresses = new Set<string>(), counts = new Map<string, number>();
  for (const row of value.products) {
    if (!object(row) || !ISSUERS.includes(row.issuer as StockIssuer) || !integer(row.chainId) || !row.chainId
      || typeof row.ticker !== "string" || normalizeStockTicker(row.ticker) !== row.ticker
      || typeof row.name !== "string" || !row.name.trim()
      || typeof row.symbol !== "string" || !SYMBOL.test(row.symbol)
      || typeof row.address !== "string" || !ADDRESS.test(row.address) || /^0x0{40}$/.test(row.address)
      || !integer(row.decimals) || row.decimals > 36 || row.pricingBasis !== "token-total-return") {
      errors.push("invalid-product");
      continue;
    }
    const sourceKey = `${row.chainId}:${row.issuer}`, source = sources.get(sourceKey);
    if (!source || row.sourceUrl !== source.url) errors.push("missing-product-source");
    const identity = `${sourceKey}:${row.ticker}`, address = `${row.chainId}:${row.address}`;
    if (identities.has(identity)) errors.push("ambiguous-ticker");
    if (addresses.has(address)) errors.push("duplicate-token-address");
    identities.add(identity); addresses.add(address);
    counts.set(sourceKey, (counts.get(sourceKey) ?? 0) + 1);
  }
  if (!sources.size || !value.products.length) errors.push("empty-catalog");
  for (const [key, source] of sources) if (counts.get(key) !== source.productCount) errors.push("incomplete-product-list");
  return [...new Set(errors)];
}

export type StockResolution = {
  status: "selected" | "blocked" | "unavailable";
  requestedTicker: string;
  resolvedTicker: string;
  reason: "bstock-exists" | "ondo-fills-absent-bstock" | "not-listed" | "invalid-request" | "invalid-catalog"
    | "catalog-chain-unavailable" | "catalog-stale" | "catalog-from-future" | "unsupported-substitution";
  product?: StockProduct;
  /** A non-null value records the explicitly requested, reviewed share-class substitution. */
  substitution?: { from: "GOOG"; to: "GOOGL" };
};

export function resolveStockProduct(input: {
  ticker: string;
  chainId: number;
  catalog?: StockCatalog;
  nowMs?: number;
  /** Only the separately reviewed GOOG → GOOGL choice is supported; never applied implicitly. */
  substituteTicker?: string;
}): StockResolution {
  const requestedTicker = normalizeStockTicker(input.ticker) ?? "";
  let resolvedTicker = requestedTicker;
  const base = (): Pick<StockResolution, "requestedTicker" | "resolvedTicker"> => ({ requestedTicker, resolvedTicker });
  const blocked = (reason: StockResolution["reason"]): StockResolution => ({ ...base(), status: "blocked", reason });
  const nowMs = input.nowMs ?? Date.now(), catalog = input.catalog ?? STOCK_CATALOG;
  if (!requestedTicker || !Number.isSafeInteger(input.chainId) || input.chainId <= 0 || !Number.isFinite(nowMs)) return blocked("invalid-request");
  let substitution: StockResolution["substitution"];
  if (input.substituteTicker !== undefined) {
    const substitute = normalizeStockTicker(input.substituteTicker);
    if (requestedTicker !== "GOOG" || substitute !== "GOOGL") return blocked("unsupported-substitution");
    substitution = { from: "GOOG", to: "GOOGL" };
    resolvedTicker = substitute;
  }
  if (validateStockCatalog(catalog).length) return blocked("invalid-catalog");
  for (const issuer of ISSUERS) {
    const source = catalog.sources.find((row) => row.chainId === input.chainId && row.issuer === issuer);
    if (!source) return blocked("catalog-chain-unavailable");
    const age = nowMs - Date.parse(source.fetchedAt);
    if (age < 0) return blocked("catalog-from-future");
    if (age > STOCK_CATALOG_MAX_AGE_MS) return blocked("catalog-stale");
  }
  const matches = catalog.products.filter((row) => row.chainId === input.chainId && row.ticker === resolvedTicker);
  // Do not consult routes, liquidity, pauses, allowlists or price feeds to determine issuer existence.
  const product = matches.find((row) => row.issuer === "bstock") ?? matches.find((row) => row.issuer === "ondo");
  if (!product) return { ...base(), status: "unavailable", reason: "not-listed", ...(substitution ? { substitution } : {}) };
  return { ...base(), status: "selected", product, reason: product.issuer === "bstock" ? "bstock-exists" : "ondo-fills-absent-bstock", ...(substitution ? { substitution } : {}) };
}

/**
 * Admission guard for a NEW stock selection, including callers that submit a token address directly.
 * Never apply this guard to held inventory or exits: catalog expiry/issuer changes must not strand assets.
 * The optional catalog is for trusted source injection/tests, not an untrusted request or saved fund file.
 */
export function assertPreferredStockToken(input: {
  chainId: number;
  token: string;
  issuer: StockIssuer;
  catalog?: StockCatalog;
  nowMs?: number;
}): StockProduct {
  const catalog = input.catalog ?? STOCK_CATALOG;
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0 || !ISSUERS.includes(input.issuer)
    || typeof input.token !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(input.token) || /^0x0{40}$/i.test(input.token)) {
    throw new Error("Stock token selection rejected: invalid-request");
  }
  if (validateStockCatalog(catalog).length) throw new Error("Stock token selection rejected: invalid-catalog");
  const token = input.token.toLowerCase();
  const product = catalog.products.find((row) => row.chainId === input.chainId && row.issuer === input.issuer && row.address === token);
  if (!product) throw new Error("Stock token selection rejected: token-not-in-authoritative-catalog");
  const resolved = resolveStockProduct({ ticker: product.ticker, chainId: input.chainId, catalog, nowMs: input.nowMs });
  if (resolved.status !== "selected" || !resolved.product) throw new Error(`Stock token selection rejected: ${resolved.reason}`);
  if (resolved.product.address !== token || resolved.product.issuer !== input.issuer) {
    throw new Error(`Stock token selection rejected: preferred-issuer-mismatch (${resolved.reason})`);
  }
  return resolved.product;
}
