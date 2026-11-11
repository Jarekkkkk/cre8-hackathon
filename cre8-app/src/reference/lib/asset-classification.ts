// Product-facing exposure classes. The builder's legacy `category` describes execution handling;
// every tokenized security keeps that handling regardless of its display class.
import { STOCK_CATALOG } from "./stock-catalog";
import { XAUT_TOKEN } from "./rwa-assets";

export type AssetClass = "crypto" | "stock" | "rwa";
export type RwaType = "commodity" | "treasury" | "fixed-income" | "alternative";
export type AssetClassification = { assetClass: AssetClass; label: string; searchTerms: string; rwaType?: RwaType };

// Reviewed against the complete 2026-11-04 issuer identity snapshot and the underlying fund mandates.
// Exact underlying tickers, never a name keyword: Gold/Silver miners and Goldman Sachs are equities.
export const RWA_EXPOSURES: Readonly<Record<string, RwaType>> = {
  BIL: "treasury", IEF: "treasury", IEI: "treasury", SGOV: "treasury", SHY: "treasury",
  TIP: "treasury", TLT: "treasury", USFR: "treasury",
  AGG: "fixed-income", BINC: "fixed-income", BRHY: "fixed-income", BRLN: "fixed-income",
  BRTR: "fixed-income", CLOA: "fixed-income", CLOI: "fixed-income", EUHY: "fixed-income",
  FLHY: "fixed-income", GGOV: "fixed-income", HYDB: "fixed-income", HYG: "fixed-income",
  HYGW: "fixed-income", HYS: "fixed-income", IGEB: "fixed-income", JAAA: "fixed-income",
  LEMB: "fixed-income", NEAR: "fixed-income", QLTA: "fixed-income", SECU: "fixed-income",
  SYSB: "fixed-income", USHY: "fixed-income", YEAR: "fixed-income",
  BNO: "commodity", CPER: "commodity", DBC: "commodity", FGDL: "commodity",
  FTGC: "commodity", GLD: "commodity", GLTR: "commodity", IAU: "commodity",
  PALL: "commodity", PDBC: "commodity", PPLT: "commodity", SLV: "commodity",
  UNG: "commodity", USO: "commodity",
  BWET: "alternative", IALT: "alternative",
};
export const CRYPTO_FUND_TICKERS: ReadonlySet<string> = new Set(["BITA", "ETHA", "FSOL", "IBIT"]);
const RWA_LABEL: Record<RwaType, string> = {
  commodity: "RWA · Commodities", treasury: "RWA · US Treasuries",
  "fixed-income": "RWA · Bonds", alternative: "RWA · Alternatives",
};
const RWA_SEARCH: Record<RwaType, string> = {
  commodity: "commodity commodities 商品 大宗商品",
  treasury: "treasury treasuries government bond 國債 国债 美債 美债 債券 债券",
  "fixed-income": "bond bonds fixed income credit 債券 债券 固定收益",
  alternative: "alternatives futures 另類資產 另类资产 期貨 期货",
};
const EXTRA_SEARCH: Readonly<Record<string, string>> = {
  GLD: "gold 黃金 黄金", IAU: "gold 黃金 黄金", FGDL: "gold 黃金 黄金",
  GLTR: "gold silver precious metals 黃金 黄金 白銀 白银 貴金屬 贵金属",
  SLV: "silver 白銀 白银", PALL: "palladium 鈀金 钯金", PPLT: "platinum 鉑金 铂金",
  CPER: "copper 銅 铜", BNO: "oil 原油", USO: "oil 原油", UNG: "gas 天然氣 天然气",
};
const productsByToken = new Map(STOCK_CATALOG.products.filter(p => p.chainId === 56).map(p => [p.address.toLowerCase(), p]));

/** Identity-bound classification: NEAR the crypto and NEAR the bond ETF are different tokens. */
export function classifyAsset(asset: { category: "crypto" | "stock" | "rwa"; token: string }): AssetClassification {
  if (asset.token.toLowerCase() === XAUT_TOKEN) return { assetClass: "rwa", rwaType: "commodity", label: "RWA · Gold", searchTerms: "RWA gold Tether XAUt 黃金 黄金 真實世界資產" };
  if (asset.category === "rwa") return { assetClass: "rwa", label: "RWA", searchTerms: "RWA real world assets 真實世界資產" };
  if (asset.category === "crypto") return { assetClass: "crypto", label: "Crypto", searchTerms: "crypto 加密 加密貨幣 加密货币" };
  const ticker = productsByToken.get(asset.token.toLowerCase())?.ticker;
  if (ticker && CRYPTO_FUND_TICKERS.has(ticker)) return { assetClass: "crypto", label: "Crypto ETF", searchTerms: "crypto ETF fund 加密 加密ETF" };
  const rwaType = ticker ? RWA_EXPOSURES[ticker] : undefined;
  if (rwaType) return {
    assetClass: "rwa", rwaType, label: RWA_LABEL[rwaType],
    searchTerms: `RWA real world assets 真實世界資產 真实世界资产 ${RWA_SEARCH[rwaType]} ${EXTRA_SEARCH[ticker!] ?? ""}`,
  };
  return { assetClass: "stock", label: "Stock / equity ETF", searchTerms: "stock stocks equity equities 股票 美股" };
}

const RWA_NAMES: Readonly<Record<string, string>> = {
  GLD: "Gold ETF · SPDR", IAU: "Gold ETF · iShares", FGDL: "Gold ETF · Franklin", GLTR: "Precious metals",
  SLV: "Silver", PALL: "Palladium", PPLT: "Platinum", CPER: "Copper",
  SGOV: "US Treasury 0–3M", BIL: "US Treasury 1–3M", SHY: "US Treasury 1–3Y", IEI: "US Treasury 3–7Y",
  IEF: "US Treasury 7–10Y", TLT: "US Treasury 20Y+", TIP: "Inflation-linked bonds", USFR: "Floating-rate Treasury",
  USO: "WTI crude oil", BNO: "Brent crude oil", UNG: "Natural gas",
};
const RWA_ORDER = ["GLD", "IAU", "SLV", "SGOV", "BIL", "SHY", "IEF", "TLT", "USFR", "PALL", "PPLT", "USO", "UNG"];
/** Short exposure names for cards; full issuer names and token symbols remain available. */
export function assetPickerName(asset: { category: "crypto" | "stock" | "rwa"; token: string; name: string }): string {
  if (asset.token.toLowerCase() === XAUT_TOKEN) return "Gold";
  const product = productsByToken.get(asset.token.toLowerCase());
  if (!product || classifyAsset(asset).assetClass !== "rwa") return asset.name;
  const kind = RWA_EXPOSURES[product.ticker];
  return RWA_NAMES[product.ticker] ?? (kind ? `${RWA_LABEL[kind].replace("RWA · ", "")} · ${product.ticker}` : asset.name);
}
export function rwaPickerOrder(asset: { token: string }): number {
  if (asset.token.toLowerCase() === XAUT_TOKEN) return 0;
  const index = RWA_ORDER.indexOf(productsByToken.get(asset.token.toLowerCase())?.ticker ?? "");
  return index < 0 ? 1000 : index + 1;
}
