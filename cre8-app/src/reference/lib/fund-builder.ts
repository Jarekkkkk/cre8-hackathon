// Fund builder for the mixed composite vault (strategy v3): the assets a creator can pick, the strategy each one
// runs, the fund-wide rules, and the checks that keep a design inside what one fund can run on BNB Chain.
// Pure data and functions: the Create page renders them, and fund-builder.test.ts checks every number below
// against its source (registry, yields snapshot, Top30 admission snapshot, keeper status and runbook).
import { additionalBstockPlanningAssets, ondoPlanningAssets } from "./fund-builder-stocks";
import { hasStockLiquidity } from "./stock-liquidity";
import { STOCK_CATALOG, type StockIssuer } from "./stock-catalog";
import stockIcons from "./stock-icons.generated";
import { displayAssetSymbol } from "./asset-display";
import { reviveFundCover, type FundCover } from "./fund-cover";
import { normalizeXHandle, X_MODEL_DISCLAIMER } from "./x-profile";
export { displayAssetSymbol } from "./asset-display";
import { recommendStockSource } from "./stock-source-selection";
import { STOCK_VENUES, STOCK_VENUE_CHECK } from "./stock-venue-data";
import { classifyAsset } from "./asset-classification";
import { XAUT_ASSET, XAUT_CHECK, XAUT_ENABLED, XAUT_MARKETS, XAUT_TOKEN, type PlanningMarkets } from "./rwa-assets";
export { classifyAsset, assetPickerName, rwaPickerOrder, type AssetClass } from "./asset-classification";
export { hasStockLiquidity, stockLiquidityLabel, STOCK_LIQUIDITY_CHECKED_AT } from "./stock-liquidity";

/** Where an asset stands for trading in a fund (the Top30 and bStock recheck snapshots of 2026-10-15). */
export type Availability =
  // Every admission check passed, or the only one missing was the pool's price-history capacity and that capacity
  // is now raised on chain (deployments/cardinality/status-*.json): the pool activates it with its own trading, and
  // until then the contracts refuse its trades on their own. Either way it waits only for deployment and governance.
  | "ready"
  | "history" // the pool needs more price-history slots (observation cardinality) before it qualifies
  | "thin" // the pool holds less than the 50,000 USDT quote reserve the admission rule requires
  | "no-feed" // no reviewed Chainlink USD feed on BNB Chain; the swap adapter cannot price it
  | "preview"; // selectable in an App design only; no trading or on-chain admission

/** Demo saves intent; execution keeps the reviewed asset, venue and gas restrictions. */
export type BuilderMode = "execution" | "demo";

export type LendVenue = "venus" | "aave" | "lista";
export type Venue = "hold" | LendVenue | "stake";

export type Asset = {
  key: string;
  name: string;
  /** BNB Chain token symbol (BTC is BTCB, BNB is WBNB, NVIDIA is NVDAB). */
  symbol: string;
  token: string;
  decimals?: number;
  targetId: string;
  /**
   * Crypto is priced by a reviewed Chainlink feed. Stocks (bStocks) have none: their fund route prices them by
   * the PancakeSwap pool's own 30-minute TWAP (decided 2026-10-12); lent or borrowed against, they are valued the
   * same way, and their sales are also floored at the pool's 5-minute mean.
   */
  /** Execution family (tokenized securities use stock handling); display uses classifyAsset(). */
  category: "crypto" | "stock" | "rwa";
  /** Explicit for Ondo; legacy stock entries are bStocks. */
  issuer?: "bstock" | "ondo";
  /** Global market-cap rank (crypto only). */
  rank?: number;
  status: Availability;
  /** Base lending APY in percent (phase1-yields.json, rounded to 0.01); 0 is an open market that pays nothing now. */
  earn: Partial<Record<LendVenue, number>>;
  /** Each earning venue's market: the Venus vToken, Aave aToken or Lista vault (the deepest open one). */
  market?: Partial<Record<LendVenue, string>>;
  /** Lista vault name when the asset has one. */
  lista?: string;
  stake?: boolean;
  stable?: boolean;
  /** A deep PancakeSwap V3 pool against USDT exists. */
  lp?: boolean;
  /**
   * Markets a borrowing position can post this asset to as collateral for USDT (provider-gated Lista markets
   * excluded). Venus lists stocks as collateral-only markets (borrowing the stock itself is off).
   */
  borrow?: LendVenue[];
};

// Top30 assets that have a reviewed BNB Chain representation, by market-cap rank. USDT is the fund's cash.
const REVIEWED_ASSETS: readonly Asset[] = [
  { key: "BTC", name: "Bitcoin", symbol: "BTCB", token: "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c", category: "crypto", targetId: "crypto:BTCB", rank: 1, status: "ready", earn: { venus: 0.2, lista: 0.17, aave: 0 }, market: { venus: "0x882c173bc7ff3b7786ca16dfed3dfffb9ee7847b", lista: "0xe46b8e65006e6450bdd8cb7d3274ab4f76f4c705", aave: "0x56a7ddc4e848ebf43845854205ad71d5d5f72d3d" }, lista: "Lista BTCB vault", lp: true, borrow: ["aave", "venus", "lista"] },
  { key: "ETH", name: "Ethereum", symbol: "ETH", token: "0x2170ed0880ac9a755fd29b2688956bd959f933f8", category: "crypto", targetId: "crypto:ETH", rank: 2, status: "ready", earn: { venus: 0.77, aave: 0.5 }, market: { venus: "0xf508fcd89b8bd15579dc79a6827cb4686a3592c8", aave: "0x2e94171493fabe316b6205f1585779c887771e2f" }, lp: true, borrow: ["aave", "venus", "lista"] },
  { key: "BNB", name: "BNB", symbol: "WBNB", token: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", category: "crypto", targetId: "crypto:WBNB", rank: 4, status: "ready", earn: { venus: 0.06, lista: 0.21, aave: 0 }, market: { venus: "0x6bca74586218db34cdb402295796b79663d816e9", lista: "0x57134a64b7cd9f9eb72f8255a671f5bf2fe3e2d0", aave: "0x9b00a09492a626678e5a3009982191586c444df9" }, lista: "Gauntlet × Lista BNB vault", stake: true, lp: true, borrow: ["aave", "venus"] },
  { key: "XRP", name: "XRP", symbol: "XRP", token: "0x1d2f0da169ceb9fc7b3144628db156f3f6c60dbe", category: "crypto", targetId: "crypto:XRP", rank: 5, status: "ready", earn: { venus: 0.3, lista: 0 }, market: { venus: "0xb248a295732e0225acd3337607cc01068e3b9c10", lista: "0x0fca33dbe0889dc7ea2d9bd568422be2401b4c02" }, lista: "Hyperithm XRP vault", borrow: ["venus"] },
  { key: "USDC", name: "USDC", symbol: "USDC", token: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", category: "crypto", targetId: "crypto:USDC", rank: 6, status: "ready", earn: { venus: 3.76, lista: 0.82, aave: 3.17 }, market: { venus: "0xeca88125a5adbe82614ffc12d0db554e2e2867c8", lista: "0x8a06ac91265dbebe6d4606f45b10993e9a571869", aave: "0x00901a076785e0906d1028c7d6372d247bec7d61" }, lista: "Lista USDC vault", stable: true },
  { key: "SOL", name: "Solana", symbol: "SOL", token: "0x570a5d26f7765ecb712c0924e4de545b89fd43df", category: "crypto", targetId: "crypto:SOL", rank: 7, status: "ready", earn: { venus: 0.53 }, market: { venus: "0xbf515ba4d1b52ffdceabf20d31d705ce789f2cec" }, borrow: ["venus"] },
  { key: "TRX", name: "TRON", symbol: "TRX", token: "0xce7de646e7208a4ef112cb6ed5038fa6cc6b12e3", category: "crypto", targetId: "crypto:TRX", rank: 8, status: "ready", earn: {} },
  { key: "ZEC", name: "Zcash", symbol: "ZEC", token: "0x1ba42e5193dfa8b03d15dd1b86a3113bbbef8eeb", category: "crypto", targetId: "crypto:ZEC", rank: 10, status: "no-feed", earn: {} },
  { key: "DOGE", name: "Dogecoin", symbol: "DOGE", token: "0xba2ae424d960c26247dd6c32edc70b295c744c43", category: "crypto", targetId: "crypto:DOGE", rank: 12, status: "ready", earn: { venus: 0 }, market: { venus: "0xec3422ef92b2fb59e84c8b02ba73f1fe84ed8d71" } },
  { key: "LINK", name: "Chainlink", symbol: "LINK", token: "0xf8a0bf9cf54bb92f17374d9e9a321e6a111a51bd", category: "crypto", targetId: "crypto:LINK", rank: 15, status: "ready", earn: { venus: 0.04 }, market: { venus: "0x650b940a1033b8a1b1873f78730fcfc73ec11f1f" } },
  { key: "ADA", name: "Cardano", symbol: "ADA", token: "0x3ee2200efb3400fabb9aacf31297cbdd1d435d47", category: "crypto", targetId: "crypto:ADA", rank: 17, status: "ready", earn: { venus: 0.04 }, market: { venus: "0x9a0af7fdb2065ce470d72664de73cae409da28ec" } },
  { key: "NEAR", name: "NEAR Protocol", symbol: "NEAR", token: "0x1fa4a73a3f0133f0025378af00236f3abdee5d63", category: "crypto", targetId: "crypto:NEAR", rank: 19, status: "ready", earn: {} },
  { key: "BCH", name: "Bitcoin Cash", symbol: "BCH", token: "0x8ff795a6f4d97e7887c79bea79aba5cc76444adf", category: "crypto", targetId: "crypto:BCH", rank: 22, status: "ready", earn: {} },
  { key: "USDE", name: "Ethena USDe", symbol: "USDe", token: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", category: "crypto", targetId: "crypto:USDe", rank: 23, status: "ready", earn: { venus: 2.38 }, market: { venus: "0x74ca6930108f775cc667894eea33843e691680d7" }, stable: true },
  { key: "LTC", name: "Litecoin", symbol: "LTC", token: "0x4338665cbb7b2485a8855a139b75d5e34ab0db94", category: "crypto", targetId: "crypto:LTC", rank: 24, status: "ready", earn: { venus: 0.04 }, market: { venus: "0x57a5297f2cb2c0aac9d554660acd6d385ab50c6b" } },
  { key: "UNI", name: "Uniswap", symbol: "UNI", token: "0xbf5140a22578168fd562dccf235e5d43a02ce9b1", category: "crypto", targetId: "crypto:UNI", rank: 25, status: "ready", earn: { venus: 0.05 }, market: { venus: "0x27ff564707786720c71a2e5c1490a63266683612" } },
  { key: "DAI", name: "Dai", symbol: "DAI", token: "0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3", category: "crypto", targetId: "crypto:DAI", rank: 26, status: "ready", earn: { venus: 2.43 }, market: { venus: "0x334b3ecb4dca3593bccc3c7ebd1a1c1d1780fbf1" }, stable: true },
  { key: "AVAX", name: "Avalanche", symbol: "AVAX", token: "0x1ce0c2827e2ef14d5c4f29a091d735a204794041", category: "crypto", targetId: "crypto:AVAX", rank: 27, status: "ready", earn: {} },
  // Tokenized US stocks (bStocks, issued by BTech Holdings) with their pool's admission state, deepest first.
  { key: "NVDA", name: "NVIDIA", symbol: "NVDAB", token: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436", targetId: "bstock:NVDAB", category: "stock", status: "ready", earn: { venus: 0 }, market: { venus: "0xeb8ca841cbe1bc4832a10b15c7dab1081edad371" }, borrow: ["venus"] },
  { key: "SPCX", name: "SpaceX", symbol: "SPCXB", token: "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1", targetId: "bstock:SPCXB", category: "stock", status: "ready", earn: { venus: 0 }, market: { venus: "0xc36dfacc7a125859c106f29b9f2d874ccf29a55a" }, borrow: ["venus"] },
  { key: "GOOGL", name: "Alphabet", symbol: "GOOGLB", token: "0x3f53de71c126bdabae20f9cd64848d317f6c3238", targetId: "bstock:GOOGLB", category: "stock", status: "ready", earn: {} },
  { key: "AAPL", name: "Apple", symbol: "AAPLB", token: "0x431a3bee82e2ca41e49895cbece5bb0f76a89b7a", targetId: "bstock:AAPLB", category: "stock", status: "ready", earn: {} },
  { key: "QQQ", name: "Nasdaq-100 ETF", symbol: "QQQB", token: "0x205812cdbed920aff76c6580abd681a46d11efc7", targetId: "bstock:QQQB", category: "stock", status: "ready", earn: {} },
  { key: "SPY", name: "S&P 500 ETF", symbol: "SPYB", token: "0x7138b48df7d98d7e3cc221bfe7192d0a178182d8", targetId: "bstock:SPYB", category: "stock", status: "ready", earn: {} },
  { key: "TSLA", name: "Tesla", symbol: "TSLAB", token: "0x5b1910eaad6450e50f816082aa078c41f10c292f", targetId: "bstock:TSLAB", category: "stock", status: "ready", earn: { venus: 0 }, market: { venus: "0x97421799419eb782628e73e7220d8e0a207469a3" }, borrow: ["venus"] },
  { key: "BABA", name: "Alibaba", symbol: "BABAB", token: "0x4ef9d3062c7f6eba4aae4990c5036598c6eff4ec", targetId: "bstock:BABAB", category: "stock", status: "ready", earn: {} },
  { key: "CRCL", name: "Circle", symbol: "CRCLB", token: "0x80f3d493ebce97e343c53d29a137942416b4ffc0", targetId: "bstock:CRCLB", category: "stock", status: "ready", earn: {} },
  { key: "SKHY", name: "SK hynix", symbol: "SKHYB", token: "0xca750ef65f295bbecd685abf54e82caf297bdb61", targetId: "bstock:SKHYB", category: "stock", status: "ready", earn: { venus: 0 }, market: { venus: "0x3e281461efb3d53ec20db207674373ed8ef3bba9" }, borrow: ["venus"] },
  { key: "MSTR", name: "Strategy", symbol: "MSTRB", token: "0xe87afb3076aeb0f9b14e368de8145ae6a2826a14", targetId: "bstock:MSTRB", category: "stock", status: "ready", earn: {} },
  { key: "MSFT", name: "Microsoft", symbol: "MSFTB", token: "0x80106cb3ead06659a5ad19df39d9b4733863b9b0", targetId: "bstock:MSFTB", category: "stock", status: "ready", earn: {} },
  { key: "META", name: "Meta", symbol: "METAB", token: "0x7425889fe94f9d693e8daefe88bcced6acfef4c0", targetId: "bstock:METAB", category: "stock", status: "ready", earn: {} },
  { key: "BNC", name: "CEA Industries", symbol: "BNCB", token: "0x4902c5ebc598265ed2212b559b042de8a5eeec3f", targetId: "bstock:BNCB", category: "stock", status: "ready", earn: {} },
  { key: "AMZN", name: "Amazon", symbol: "AMZNB", token: "0x1a4b499833a79a09ad7cf1d42d7dacf71e92eb00", targetId: "bstock:AMZNB", category: "stock", status: "ready", earn: {} },
  { key: "GME", name: "GameStop", symbol: "GMEB", token: "0x46ceefda28dd7207059ed19b0acdc026955bb15c", targetId: "bstock:GMEB", category: "stock", status: "ready", earn: {} },
  { key: "NFLX", name: "Netflix", symbol: "NFLXB", token: "0xd6829ea836b6fa224d099d40e54b31262f874631", targetId: "bstock:NFLXB", category: "stock", status: "thin", earn: {} },
  { key: "INTC", name: "Intel", symbol: "INTCB", token: "0xe614e2fc6c787035ff51f452e8e826bfd32d5283", targetId: "bstock:INTCB", category: "stock", status: "thin", earn: {} },
  { key: "TSM", name: "TSMC", symbol: "TSMB", token: "0xab78b89b5bb00236be0b4b20704cbfa04efc711c", targetId: "bstock:TSMB", category: "stock", status: "thin", earn: {} },
  { key: "HOOD", name: "Robinhood", symbol: "HOODB", token: "0xa394dcea3fd3847fd793afbfd163e2e3858b7c65", targetId: "bstock:HOODB", category: "stock", status: "thin", earn: {} },
  { key: "MRNA", name: "Moderna", symbol: "MRNAB", token: "0x5fd86da9b05abe396fe9d02a4a213a7c00556503", targetId: "bstock:MRNAB", category: "stock", status: "thin", earn: {} },
  { key: "SOXS", name: "3X Semiconductor Bear ETF", symbol: "SOXSB", token: "0xe28cd11c99af2df76bb8ada4cd0ef3904378280f", targetId: "bstock:SOXSB", category: "stock", status: "thin", earn: {} },
  { key: "SNDK", name: "Sandisk", symbol: "SNDKB", token: "0x3ee4df61bd4f867e349beae8bfe07bc31b4850fb", targetId: "bstock:SNDKB", category: "stock", status: "thin", earn: {} },
  { key: "SQQQ", name: "3X Short QQQ ETF", symbol: "SQQQB", token: "0x25e572b466d152604d9e6c3e53b432b978825342", targetId: "bstock:SQQQB", category: "stock", status: "thin", earn: {} },
  { key: "TQQQ", name: "3X Long QQQ ETF", symbol: "TQQQB", token: "0x462b5f13b7c7748279358962925c5de83bb9e598", targetId: "bstock:TQQQB", category: "stock", status: "thin", earn: {} },
  { key: "NOK", name: "Nokia", symbol: "NOKB", token: "0x7c4d7a180d737dd5a70d8065a90e6746a69c37ea", targetId: "bstock:NOKB", category: "stock", status: "thin", earn: {} },
  { key: "BMNR", name: "Bitmine", symbol: "BMNRB", token: "0x3548da95a9effe481e8604664d75e95821e557f5", targetId: "bstock:BMNRB", category: "stock", status: "thin", earn: {} },
  { key: "SOXL", name: "3X Semiconductor Bull ETF", symbol: "SOXLB", token: "0xd97d097a89113fa59b76c572e5b2eb647e8eefaf", targetId: "bstock:SOXLB", category: "stock", status: "thin", earn: {} },
  { key: "AMC", name: "AMC Entertainment", symbol: "AMCB", token: "0x96e7d606e229448ef817a7f35fd7394c3e15d00c", targetId: "bstock:AMCB", category: "stock", status: "thin", earn: {} },
  { key: "FLNC", name: "Fluence Energy", symbol: "FLNCB", token: "0x4af1d41cd9dd950dca43984b43aaa2a8702714ac", targetId: "bstock:FLNCB", category: "stock", status: "thin", earn: {} },
  { key: "DJT", name: "Trump Media", symbol: "DJTB", token: "0xf2ec508422174ee564de98187db9359d318afb6b", targetId: "bstock:DJTB", category: "stock", status: "thin", earn: {} },
  { key: "MU", name: "Micron", symbol: "MUB", token: "0xcdf2f3e0fa43c47a6662a91c9e4a7c5f69762699", targetId: "bstock:MUB", category: "stock", status: "ready", earn: {} },
  { key: "SNXX", name: "2X Long SNDK ETF", symbol: "SNXXB", token: "0x9e82e3da8f1115b73d24bb24113ab836ffdab6b6", targetId: "bstock:SNXXB", category: "stock", status: "thin", earn: {} },
];
export const ASSETS: readonly Asset[] = [...REVIEWED_ASSETS, ...additionalBstockPlanningAssets(REVIEWED_ASSETS), ...ondoPlanningAssets(undefined, true), XAUT_ASSET];
export const ASSET_BY_KEY: ReadonlyMap<string, Asset> = new Map(ASSETS.map((asset) => [asset.key, asset]));
const ASSET_BY_TOKEN = new Map(ASSETS.map(asset => [asset.token.toLowerCase(), asset]));
const STOCK_BY_TOKEN = new Map(STOCK_CATALOG.products.filter(p => p.chainId === 56).map(p => [p.address, p]));
export function stockSourceChoices(asset: Asset): Asset[] {
  const product = STOCK_BY_TOKEN.get(asset.token.toLowerCase());
  return asset.category !== "stock" || !product ? [] : STOCK_CATALOG.products.filter(p => p.chainId === 56 && p.ticker === product.ticker)
    .map(p => ASSET_BY_TOKEN.get(p.address)).filter((a): a is Asset => !!a);
}
export const stockSourceRecommendation = (asset: Asset) => recommendStockSource(STOCK_BY_TOKEN.get(asset.token.toLowerCase())?.ticker ?? "");
/** Keep a saved/manual source visible even when the current default recommendation changes. */
export const stockSourceInDesign = (asset: Asset, rows: readonly Row[]) => stockSourceChoices(asset).find(source => rows.some(row => row.key === source.key)) ?? asset;
export const assetOf = (key: string): Asset => {
  const asset = ASSET_BY_KEY.get(key);
  if (!asset) throw new Error(`Unknown asset ${key}`);
  return asset;
};
export const canAdd = (asset: Asset) => asset.status === "ready" || asset.status === "history" || asset.status === "preview";
/** App planning can include every official bStock; this does not grant trading or testnet admission. */
export const isPlanningOnly = (asset: Asset) => asset.status === "preview" || (asset.category === "stock" && asset.status === "thin");
export function canPickAsset(asset: Asset): boolean {
  if (asset.category === "rwa") return asset.token.toLowerCase() === XAUT_TOKEN && XAUT_ENABLED && canAdd(asset);
  if (asset.category !== "stock") return canAdd(asset);
  if (stockSourceChoices(asset).length > 1) return (asset.issuer ?? "bstock") === stockSourceRecommendation(asset).issuer;
  return asset.issuer === "ondo" ? canAdd(asset) && hasStockLiquidity(asset) : canAdd(asset) || asset.status === "thin";
}
/** One underlying brand per exact ticker. Token issuer artwork stays available in its original files. */
const STOCK_BY_SYMBOL = new Map(STOCK_CATALOG.products.filter(p => p.chainId === 56).map(p => [`${p.issuer}:${p.symbol.toLowerCase()}`, p]));
export const STOCK_LOGOS_BY_SYMBOL = Object.fromEntries(STOCK_CATALOG.products.filter(p => p.chainId === 56)
  .map(p => [p.symbol.toUpperCase(), stockIcons[p.ticker].replace(/^\/logos\//, "")]));
export function logoPath(asset: Pick<Asset, "category" | "key" | "symbol" | "issuer">): string {
  if (asset.key === "XAUT") return "/logos/tokens/xaut.svg";
  if (asset.category === "stock" || asset.issuer === "ondo") {
    const product = STOCK_BY_SYMBOL.get(`${asset.issuer ?? "bstock"}:${asset.symbol.toLowerCase()}`);
    const icon = product && stockIcons[product.ticker];
    if (!icon) throw new Error(`Missing underlying stock logo: ${asset.symbol}`);
    return icon;
  }
  return `/logos/tokens/${asset.key.toLowerCase()}.png`;
}
export const STATUS_TEXT: Record<Availability, string> = {
  ready: "Ready",
  history: "Price history pending",
  thin: "Pool under 50,000 USDT",
  "no-feed": "No price feed on BNB Chain",
  preview: "Preview only",
};
export const STATUS_DETAIL: Record<Availability, string> = {
  ready: "Passes every trading check.",
  history: "Its pool needs more on-chain price history before trades are allowed. That is being prepared.",
  thin: "Its PancakeSwap pool is too small to trade safely. It opens if the pool grows past 50,000 USDT.",
  "no-feed": "There is no Chainlink price feed for it on BNB Chain, so a fund cannot price it.",
  preview: "Add this stock to a saved design. On-chain trading is not enabled.",
};
export const CASH = { key: "USDT", name: "Tether USD", symbol: "USDT" } as const;
/** Where idle USDT can be lent (registry cashMarkets) and its base APY in percent (phase1-yields.json cashMarkets). */
export const CASH_MARKET: Record<LendVenue, string> = {
  venus: "0xfd5840cd36d94d7229439859c0112a4185bc0255", // Venus vUSDT
  aave: "0xa9251ca9de909cb71783723713b21e4233fbf1b1", // Aave V3 aBnbUSDT
  lista: "0x6d6783c146f2b0b2774c1725297f1845dc502525", // Gauntlet USDT Vault
};
export const CASH_APY: Record<LendVenue, number> = { venus: 3.45, aave: 2.96, lista: 3.46 };

// ---------- Current price (a reference for levels entered as prices) ----------
/**
 * Where the create page reads an asset's price today: its reviewed Chainlink USD feed (registry Top30 feed), or for a
 * stock the PancakeSwap pool its route uses (the bStock snapshot's selected pool, or the pool waiting for history).
 */
export type PriceSource = { feed: string; decimals: number } | { pool: string; decimals: number };
export const PRICE_SOURCE: Readonly<Record<string, PriceSource>> = {
  BTC: { feed: "0x264990fbd0a4796a3e3d8e37c4d5f87a3aca5ebf", decimals: 8 },
  ETH: { feed: "0x9ef1b8c0e4f7dc8bf5719ea496883dc6401d5b2e", decimals: 8 },
  BNB: { feed: "0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee", decimals: 8 },
  XRP: { feed: "0x93a67d414896a280bf8ffb3b389fe3686e014fda", decimals: 8 },
  USDC: { feed: "0x51597f405303c4377e36123cbc172b13269ea163", decimals: 8 },
  SOL: { feed: "0x0e8a53dd9c13589df6382f13da6b3ec8f919b323", decimals: 8 },
  TRX: { feed: "0xf4c5e535756d11994fcbb12ba8add0192d9b88be", decimals: 8 },
  DOGE: { feed: "0x3ab0a0d137d4f946fbb19eecc6e92e64660231c8", decimals: 8 },
  LINK: { feed: "0xca236e327f629f9fc2c30a4e95775ebf0b89fac8", decimals: 8 },
  ADA: { feed: "0xa767f745331d267c7751297d982b050c93985627", decimals: 8 },
  NEAR: { feed: "0x0fe4d87883005fcafaf56b81d09473d9a29dcdc3", decimals: 8 },
  UNI: { feed: "0xb57f259e7c24e56a1da00f66b55a5640d9f9e7e4", decimals: 8 },
  BCH: { feed: "0x43d80f616daf0b0b42a928eed32147dc59027d41", decimals: 8 },
  USDE: { feed: "0x10402b01cd2e6a9ed6dbe683cbc68f78ff02f8fc", decimals: 8 },
  LTC: { feed: "0x74e72f37a8c415c8f1a98ed42e78ff997435791d", decimals: 8 },
  DAI: { feed: "0x132d3c0b1d2cea0bc552588063bdbb210fdeecfa", decimals: 8 },
  AVAX: { feed: "0x5974855ce31ee8e1fff2e76591cbf83d7110f151", decimals: 8 },
  NVDA: { pool: "0x8fb4243b553ac29ba088acf00b9b7da24bd6690c", decimals: 18 },
  SPCX: { pool: "0x977daffc095b33872e2741c19568925015c35b4d", decimals: 18 },
  GOOGL: { pool: "0x89001d846f7ca36ee089f73eefc25657e1798144", decimals: 18 },
  AAPL: { pool: "0xe9b9998b2ec5430d2246c7f1f8d9f298c97d7365", decimals: 18 },
  QQQ: { pool: "0xe531fcb1f5a195de7608b9f4f9518544c2cdb693", decimals: 18 },
  SPY: { pool: "0x7aa6d92fc369a8c1edc631a3aac44efb0808ddbf", decimals: 18 },
  TSLA: { pool: "0xb0f5e5400e8f0f7c242f2b7740c004f020579c41", decimals: 18 },
  BABA: { pool: "0xfd95cb1391999006eb91797a7c62acfe88b20292", decimals: 18 },
  CRCL: { pool: "0x29967c54c5bf12e8158c8894376064b30ebab297", decimals: 18 },
  SKHY: { pool: "0xd7d30f434b12f7ed9b0ae11ff1c754745a10ad52", decimals: 18 },
  MSTR: { pool: "0x692081209619735f25700557078ab084d3e5d007", decimals: 18 },
  MSFT: { pool: "0x5018b018ceb7645c927c5cf246786f89ebcbe7ea", decimals: 18 },
  META: { pool: "0xc2151a561e928d16576d75ea88544543ac63d80b", decimals: 18 },
  BNC: { pool: "0x32c51041f3d7a66ac14aba7485444efb6e15efe1", decimals: 18 },
  AMZN: { pool: "0x7530beb7bde5843f668cf31b996fa1f748c9b6b1", decimals: 18 },
  GME: { pool: "0x908d49048eb3a7bedfd238972403842805eaf2be", decimals: 18 },
  MU: { pool: "0x9e75ced0a01590890917c5180c3e3ed6a86a071e", decimals: 18 },
};
/** Public BNB Chain endpoint the page reads prices from (the registry's discovery endpoint; no credentials). */
export const PRICE_RPC = "https://bsc-dataseed.bnbchain.org";
const USDT_TOKEN = "0x55d398326f99059ff775485246999027b3197955"; // 18 decimals
/** The read for an asset's price: Chainlink latestRoundData() or the pool's slot0(). */
export function priceCall(key: string): { to: string; data: string } | null {
  const source = PRICE_SOURCE[key];
  if (!source) return null;
  return "feed" in source ? { to: source.feed, data: "0xfeaf968c" } : { to: source.pool, data: "0x3850c7bd" };
}
/** USDT per whole token from that read's return data, or null when it is not a usable price. */
export function decodePrice(key: string, result: string): number | null {
  const source = PRICE_SOURCE[key], asset = ASSET_BY_KEY.get(key);
  if (!source || !asset || !/^0x[0-9a-fA-F]*$/.test(result) || result.length < 2 + 64 * ("feed" in source ? 5 : 7)) return null;
  const word = (index: number) => BigInt("0x" + result.slice(2 + 64 * index, 66 + 64 * index));
  let price: number;
  if ("feed" in source) {
    const answer = BigInt.asIntN(256, word(1));
    price = Number(answer) / 10 ** source.decimals;
  } else {
    // sqrtPriceX96 squared is token1 per token0 in raw units; USDT has 18 decimals.
    const ratio = (Number(word(0)) / 2 ** 96) ** 2 * 10 ** (source.decimals - 18);
    price = asset.token.toLowerCase() < USDT_TOKEN ? ratio : 1 / ratio;
  }
  return Number.isFinite(price) && price > 0 ? price : null;
}
/** Venus BNB Core comptroller (deployments/bsc.addresses.json): it holds every Venus market's supply cap. */
export const VENUS_COMPTROLLER = "0xfd36e2c2a6789db23113685031d7f16329158384";
/**
 * The reads that tell whether a lending market takes new deposits now: a Venus market's supply cap, total supply
 * and exchange rate, or a Lista vault's maxDeposit. Aave is not read (its caps are rarely the limit).
 */
export function roomCalls(venue: LendVenue, market: string): { to: string; data: string }[] | null {
  if (!/^0x[0-9a-f]{40}$/.test(market)) return null;
  const word = market.slice(2).padStart(64, "0");
  if (venue === "venus") return [{ to: VENUS_COMPTROLLER, data: "0x02c3bcbb" + word }, { to: market, data: "0x18160ddd" }, { to: market, data: "0x182df0f5" }];
  // maxDeposit for an ordinary address with no special allowance.
  if (venue === "lista") return [{ to: market, data: "0x402d267d" + "000000000000000000000000000000000000000000000000000000000000dead" }];
  return null;
}
/**
 * Whether the market has room: a Venus market less than 0.1% under its cap (or capped at zero) is full, as is a
 * Lista vault that would take nothing. null when the answer cannot be read.
 */
export function decodeRoom(venue: LendVenue, results: string[]): boolean | null {
  const value = (hex: string | undefined) => (typeof hex === "string" && /^0x[0-9a-fA-F]{64}$/.test(hex) ? BigInt(hex) : null);
  if (venue === "venus") {
    const [cap, supply, rate] = results.map(value);
    if (cap === null || cap === undefined || supply === null || supply === undefined || rate === null || rate === undefined) return null;
    const supplied = (supply * rate) / 10n ** 18n;
    return cap > 0n && supplied + cap / 1000n < cap;
  }
  if (venue === "lista") {
    const maximum = value(results[0]);
    return maximum === null ? null : maximum > 0n;
  }
  return null;
}
/** Where a borrowing position borrows USDT: Venus vUSDT and the Aave USDT reserve are shared by every collateral. */
export const AAVE_DATA_PROVIDER = "0xc90df74a7c16245c5f5c5870327ceb38fe5d5328";
export const LISTA_MOOLAH = "0x8f73b65b4caaf64fba2af91cc5d4a2a1318e5d8c";
/**
 * The Lista Moolah market that lends USDT against each asset (bsc.addresses.json lista.markets, no collateral
 * provider). WBNB and slisBNB take collateral only through Lista's own provider contracts, so BNB has none.
 */
export const LISTA_USDT_MARKET: Readonly<Record<string, string>> = {
  BTC: "0x975f4cf3db16812d995f60e19bec91a96108d47429237acc8d208bc0519c5b19",
  ETH: "0x98736236a21390ea3697d1776974c4adcd7d8fe2961c9296cb744c3627b8b349",
};
/**
 * The reads for how much USDT can be borrowed now: Venus cash with its borrow cap and total borrows, the Aave
 * reserve's liquidity with its borrow cap and total debt, or the Lista market's supply less its borrows.
 */
export function borrowCalls(venue: LendVenue, key: string): { to: string; data: string }[] | null {
  const word = (address: string) => address.slice(2).padStart(64, "0");
  if (venue === "venus") {
    const market = CASH_MARKET.venus;
    return [{ to: market, data: "0x3b1d21a2" }, { to: VENUS_COMPTROLLER, data: "0x4a584432" + word(market) }, { to: market, data: "0x47bd3718" }];
  }
  if (venue === "aave") {
    return [
      { to: USDT_TOKEN, data: "0x70a08231" + word(CASH_MARKET.aave) },
      { to: AAVE_DATA_PROVIDER, data: "0x46fbe558" + word(USDT_TOKEN) },
      { to: AAVE_DATA_PROVIDER, data: "0x4d44ac4f" + word(USDT_TOKEN) },
    ];
  }
  const id = LISTA_USDT_MARKET[key];
  return id ? [{ to: LISTA_MOOLAH, data: "0x5c60e39a" + id.slice(2) }] : null;
}
/** USDT (raw, 18 decimals) that can be borrowed now, or null when the reads are not usable. */
export function decodeBorrowRoom(venue: LendVenue, results: string[]): bigint | null {
  const words = (hex: string | undefined, count: number) => {
    if (typeof hex !== "string" || !/^0x[0-9a-fA-F]*$/.test(hex) || hex.length < 2 + 64 * count) return null;
    return Array.from({ length: count }, (_, i) => BigInt("0x" + hex.slice(2 + 64 * i, 66 + 64 * i)));
  };
  const left = (cap: bigint, used: bigint) => (cap > used ? cap - used : 0n);
  if (venue === "venus") {
    const [cash, cap, borrows] = [words(results[0], 1), words(results[1], 1), words(results[2], 1)];
    if (!cash || !cap || !borrows) return null;
    // A Venus Core borrow cap of 0 means no cap.
    return cap[0] === 0n ? cash[0] : [cash[0], left(cap[0], borrows[0])].reduce((a, b) => (a < b ? a : b));
  }
  if (venue === "aave") {
    const [liquidity, caps, debt] = [words(results[0], 1), words(results[1], 2), words(results[2], 1)];
    if (!liquidity || !caps || !debt) return null;
    // The borrow cap is in whole tokens; 0 means no cap.
    const cap = caps[0] * 10n ** 18n;
    return caps[0] === 0n ? liquidity[0] : [liquidity[0], left(cap, debt[0])].reduce((a, b) => (a < b ? a : b));
  }
  const market = words(results[0], 6);
  return market ? left(market[0], market[2]) : null;
}
/** A dollar amount in short form: $42.7M, $204K, $35. */
export function compactUsd(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "$0";
  if (value >= 1e6) return `$${Number((value / 1e6).toPrecision(3))}M`;
  if (value >= 1e3) return `$${Number((value / 1e3).toPrecision(3))}K`;
  return `$${Math.floor(value)}`;
}
/** Why a market a user may expect is not offered for borrowing. */
export const BORROW_NOTE: Readonly<Record<string, string>> = {
  BNB: "Lista lends USDT against BNB only through its own BNB and slisBNB provider contracts, which a fund's loan account can't use yet.",
};
/** Below this, a borrowing position would borrow little or nothing there. */
export const BORROW_ROOM_LOW = 10_000;

/** A price to a few significant figures, for prefilled levels. */
export const roundPrice = (value: number) => (value > 0 && Number.isFinite(value) ? Number(value.toPrecision(value >= 1000 ? 5 : 4)) : 0);
/** A USDT price as people read it: no cents above 1,000, four significant figures under 1. */
export function usd(value: number): string {
  if (!(value > 0) || !Number.isFinite(value)) return "$0";
  if (value >= 1000) return "$" + Math.round(value).toLocaleString("en-US");
  if (value >= 1) return "$" + value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return "$" + Number(value.toPrecision(4)).toString();
}

export const VENUE_NAME: Record<LendVenue | "pancakeswap", string> = { venus: "Venus", aave: "Aave", lista: "Lista", pancakeswap: "PancakeSwap" };
/** Where idle cash is lent on testnet, in words: on a named venue it admits, or in the sandbox's generic lending vault. */
export const idleWhere = (named: readonly LendVenue[], venue: LendVenue) => (named.includes(venue) ? `on ${VENUE_NAME[venue]}` : "in the sandbox lending vault");
/** Protocols where an asset can earn, in a fixed order: lending, vaults and staking, then pools. */
export function venuesOf(asset: Asset): (LendVenue | "pancakeswap")[] {
  const out: (LendVenue | "pancakeswap")[] = [];
  if ("venus" in asset.earn) out.push("venus");
  if ("lista" in asset.earn || asset.stake) out.push("lista");
  if ("aave" in asset.earn) out.push("aave");
  if (asset.lp) out.push("pancakeswap");
  return out;
}

// ---------- Limits (contracts and runbook) ----------
/** Distinct assets per fund (registry policy.maxTargets). */
export const MAX_ASSETS = 7;
/** Spot scopes plus native positions per fund (MandateCompositeMixedVault.configureScope, PositionBook.register). */
export const MAX_POSITIONS = 8;
/** Demo reserves one additional position for idle cash, alongside ten distinct assets. */
export const builderLimits = (mode: BuilderMode = "execution") => mode === "demo"
  ? { assets: 10, positions: 11 }
  : { assets: MAX_ASSETS, positions: MAX_POSITIONS };
/**
 * A fund that borrows keeps at least 5% in cash: with a borrowing position its caps total at most 9,500 bps
 * (MandateCompositeNativeCatalog.validateCapacity) and buys and funding leave 5% of NAV free. A fund that does
 * not borrow may invest all of it (caps up to 10,000 bps).
 */
export const BORROWING_CASH_MIN = 5;
/** joinEnvelope = 1,000,000 + 2,000,000 per spot scope + each native position's joinGas, at most 16,277,216. */
export const JOIN_BASE = 1_000_000;
export const JOIN_SPOT = 2_000_000;
export const JOIN_LIMIT = 16_277_216;
/**
 * Per-deposit gas a native position reserves (its catalog joinGas). Mainnet values come from the runbook §5 fork
 * measurements; the rest are the measured sandbox keys (testnet record) until a mainnet fork measures them.
 */
export const NATIVE_JOIN_GAS = {
  idleVenus: 1_200_000, // Venus USDT supply, mainnet fork
  idleAave: 1_050_000, // Aave USDT supply, mainnet fork
  idleLista: 3_850_000, // Lista Gauntlet USDT vault supply, mainnet fork (withdraw queue 22)
  lendFx: 3_150_000, // a non-cash asset lent on Venus or Aave: FX over supply, sandbox key
  lendListaFx: 4_000_000, // Lista vault supply 3,850,000 (mainnet, USDT) plus the FX wrapper
  stake: 3_100_000, // slisBNB staking, sandbox key
  lp: 4_000_000, // PancakeSwap V3 LP, sandbox key
  borrowAave: 13_600_000, // mainnet fork, runbook §5
  borrowLista: 13_400_000,
  borrowVenus: 15_277_216, // over the single-key limit at 1.5x; capped at the limit
} as const;

/** Per-deposit gas of the idle-cash position on each venue. */
export const IDLE_JOIN_GAS: Record<LendVenue, number> = { venus: NATIVE_JOIN_GAS.idleVenus, aave: NATIVE_JOIN_GAS.idleAave, lista: NATIVE_JOIN_GAS.idleLista };

// ---------- Strategies ----------
export type Play = "hold" | "stack" | "dips" | "range" | "trend" | "lp" | "carry" | "custom";
export type Exit = "none" | "trail" | "target";
export type Every = "daily" | "weekly" | "monthly" | "quarterly";
export type Lookback = "4h" | "12h" | "1d" | "3d" | "1w" | "1m";
/**
 * How a level is entered: a % move, or a USDT price. A take-profit or stop-loss % is measured from what the fund paid
 * (AVERAGE_BUY_PRICE); range bounds and a buy-below level are measured from the launch price (LAUNCH_PRICE).
 */
export type LevelBy = "pct" | "price";
/**
 * What a take-profit or stop-loss % of a token held as itself is measured from: the keeper's cost basis, which adds
 * each buy's cost and fee into the one holding it sells (execution/strategy-v3/inventory.mjs, rounds.mjs).
 */
export const AVERAGE_BUY_PRICE = "the average price the fund paid for it, fees included";
/**
 * What range bounds, a buy-below level, a hard stop and the buy ceilings a design leaves open are measured from. A
 * design records no price: these levels become prices only when CRE8's keeper first sets up the fund's strategy.
 */
export const LAUNCH_PRICE = "the price when CRE8's keeper first sets up this fund's strategy";
/** Take profit and stop loss: `tp`/`sl` in % when `by` is "pct", `tpPrice`/`slPrice` in USDT (0 = not set) when "price". */
export type ExitSettings = { exit: Exit; trail: number; by: LevelBy; tp: number; sl: number; tpPrice: number; slPrice: number };
export type Settings = {
  hold: { venue: Venue; reinvest: number; hours: number } & ExitSettings;
  /** `time` is "HH:MM" in the creator's time zone (a testnet design keeps it: TestnetTerms.timeZone); `ceiling` 0 leaves the buy ceiling to CRE8. */
  stack: { every: Every; day: number; date: number; time: string; buys: number; ceiling: number } & ExitSettings;
  dips: { dip: number; bounce: number; tp: number; rebuy: number; lots: number; valid: number };
  /** ±`width`% around the launch price (LAUNCH_PRICE), or from `low` to `high` USDT when `by` is "price". */
  range: { by: LevelBy; width: number; low: number; high: number; lines: number; spacing: "even" | "pct"; follow: boolean; stop: number };
  trend: { lookback: Lookback; adds: number; step: number; trail: number; stop: number };
  lp: { width: "full" | "wide" | "narrow"; reinvest: number; recenter: boolean; outside: number; perDay: number };
  carry: { ltv: number; borrowOn: LendVenue; lendOn: LendVenue };
  /** "below" buys under `below`% from the launch price (LAUNCH_PRICE), or under `belowPrice` USDT when `buyBy` is "price". */
  custom: { buy: "once" | "dca" | "dip" | "below"; every: Every; dip: number; below: number; buyBy: LevelBy; belowPrice: number; venue: Venue; reinvest: number } & ExitSettings;
};
export type Row = { [P in Play]: { id: number; key: string; share: number; auto: boolean; play: P; p: Settings[P] } }[Play];

export const PLAYS: Record<Play, { name: string; line: string }> = {
  hold: { name: "Buy & hold", line: "Buy at launch and keep it, earning where it can." },
  stack: { name: "Stack", line: "Buy the same slice on a fixed schedule." },
  dips: { name: "Buy dips", line: "Buy pullbacks, take profit on each rally, repeat." },
  range: { name: "Range trade", line: "Buy low and sell high between two prices." },
  trend: { name: "Ride the trend", line: "Buy breakouts, add as it climbs, exit when it turns." },
  lp: { name: "Earn fees", line: "Pair it with USDT in a PancakeSwap pool." },
  carry: { name: "Borrow & earn", line: "Keep it as collateral, borrow USDT and lend that out." },
  custom: { name: "Custom", line: "Choose how it's bought, held and sold." },
};
export const PLAY_ORDER: readonly Play[] = ["hold", "stack", "dips", "range", "trend", "lp", "carry", "custom"];
export const LOOKBACK: readonly [Lookback, string, string][] = [["4h", "4H", "4-hour"], ["12h", "12H", "12-hour"], ["1d", "1D", "1-day"], ["3d", "3D", "3-day"], ["1w", "1W", "1-week"], ["1m", "1M", "1-month"]];
/** Trend bars: hourly bars for lookbacks up to three days, daily bars for a week or a month (keeper lookback ≤ 96 bars). */
export const LOOKBACK_BARS: Record<Lookback, { interval: number; bars: number }> = {
  "4h": { interval: 3600, bars: 4 }, "12h": { interval: 3600, bars: 12 }, "1d": { interval: 3600, bars: 24 },
  "3d": { interval: 3600, bars: 72 }, "1w": { interval: 86400, bars: 7 }, "1m": { interval: 86400, bars: 30 },
};
export const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
/** Operation fee cap every keeper order carries (decided: fixed at 0.5%). */
export const MAX_FEE_BPS = 50;

const EXIT: ExitSettings = { exit: "none", trail: 20, by: "pct", tp: 40, sl: 25, tpPrice: 0, slPrice: 0 };
export function defaults<P extends Play>(play: P): Settings[P] {
  const all: Settings = {
    hold: { venue: "hold", reinvest: 100, hours: 6, ...EXIT },
    stack: { every: "weekly", day: 0, date: 1, time: "09:00", buys: 12, ceiling: 0, ...EXIT },
    dips: { dip: 10, bounce: 3, tp: 15, rebuy: 5, lots: 3, valid: 14 },
    range: { by: "pct", width: 15, low: 0, high: 0, lines: 10, spacing: "even", follow: false, stop: 10 },
    trend: { lookback: "1d", adds: 3, step: 5, trail: 8, stop: 15 },
    lp: { width: "wide", reinvest: 100, recenter: true, outside: 6, perDay: 1 },
    carry: { ltv: 50, borrowOn: "aave", lendOn: "venus" },
    custom: { buy: "once", every: "weekly", dip: 10, below: 10, buyBy: "pct", belowPrice: 0, venue: "hold", reinvest: 100, ...EXIT },
  };
  return structuredClone(all[play]);
}

// ---------- Setting ranges ----------
/**
 * The range of a number setting. The slider, the typed box, a draft read back from storage and `problem()` all use
 * it. `slide` is where the slider stops when the range is wide; the box takes the rest. `hard` names the contract or
 * keeper bound that keeps the range from going wider. Every other bound is the product's own and sits inside what the
 * keeper accepts: a fall of 1–9,999 bps, a rise of up to 100,000 bps, signals of up to 365 days, 96 TWAP slices.
 */
export type Limit = { min: number; max: number; step?: number; slide?: number; hard?: string };
export const EXIT_LIMITS = { trail: { min: 1, max: 90 }, tp: { min: 1, max: 1000, slide: 300 }, sl: { min: 1, max: 95 } } satisfies Record<string, Limit>;
export const LIMITS = {
  hold: { ...EXIT_LIMITS, hours: { min: 1, max: 168 } },
  stack: { ...EXIT_LIMITS, date: { min: 1, max: 28 }, buys: { min: 2, max: 1000, slide: 156 } },
  dips: {
    dip: { min: 1, max: 90 }, bounce: { min: 1, max: 50 }, tp: { min: 1, max: 1000, slide: 300 }, rebuy: { min: 1, max: 90 },
    lots: { min: 1, max: 16, hard: "A fund keeps at most 16 open buys per asset (contract limit)." }, valid: { min: 1, max: 365 },
  },
  range: { width: { min: 1, max: 90 }, lines: { min: 2, max: 16, hard: "A fund trades at most 16 levels per range." }, stop: { min: 1, max: 90 } },
  trend: { trail: { min: 1, max: 90 }, adds: { min: 1, max: 7, hard: "A fund adds at most 7 times after the first buy." }, step: { min: 1, max: 100 }, stop: { min: 1, max: 95 } },
  lp: { outside: { min: 1, max: 96 }, perDay: { min: 1, max: 24, hard: "A pool is re-centered at most 24 times a day." } },
  carry: { ltv: { min: 10, max: 60, step: 5, hard: "Higher is not offered: the contracts keep each loan at least 15 points under its market's liquidation level." } },
  custom: { ...EXIT_LIMITS, dip: { min: 1, max: 90 }, below: { min: 1, max: 95 } },
} satisfies { [P in Play]: Partial<Record<keyof Settings[P], Limit>> };
export const RULE_LIMITS = {
  idle: { max: { min: 10, max: 100, step: 10 } },
  rebalance: { drift: { min: 1, max: 50 } },
  pair: { width: { min: 1, max: 90 }, levels: { min: 2, max: 16, hard: "A fund trades at most 16 levels per range." } },
  exit: { sl: { min: 1, max: 95 }, tp: { min: 0, max: 1000 }, cooldown: { min: 1, max: 365 } },
} satisfies { [K in keyof FundRules]?: Partial<Record<keyof FundRules[K], Limit>> };
const limitsOf = (play: Play) => LIMITS[play] as Record<string, Limit>;
/** A value brought inside its range and onto its step. */
export function clampTo(limit: Limit, value: number): number {
  const step = limit.step ?? 1, stepped = Number.isFinite(value) ? Math.round(value / step) * step : limit.min;
  return Math.max(limit.min, Math.min(limit.max, stepped));
}
const within = (limit: Limit, value: unknown) => typeof value === "number" && clampTo(limit, value) === value;
/** Whether every number setting of the row, and of every rule that is on, is inside its range. */
function outOfRange(state: Builder): string | null {
  for (const row of state.rows) {
    if (Object.entries(limitsOf(row.play)).some(([field, limit]) => !within(limit, (row.p as Record<string, unknown>)[field]))) return `One of ${assetOf(row.key).name}'s settings is outside the range a fund can run. Open it and set it again.`;
  }
  for (const key of rulesOn(state.rules)) {
    const limits = (RULE_LIMITS as Record<string, Record<string, Limit>>)[key] ?? {};
    if (Object.entries(limits).some(([field, limit]) => !within(limit, (state.rules[key] as Record<string, unknown>)[field]))) return "A whole-fund rule is set outside the range a fund can run. Set it again.";
  }
  return null;
}

/** Fees and slippage a level has to clear: every keeper order may pay up to MAX_FEE_BPS. */
const FEE_NOTE = `each buy or sell can pay up to ${MAX_FEE_BPS / 100}% in fees plus slippage`;
/** Settings that run but tend to lose to fees or to ordinary swings; shown, never enforced. */
export function settingWarnings(row: Row): string[] {
  const out: string[] = [];
  const swing = (what: string, value: number) => { if (value < 3) out.push(`${what} of ${value}% can be hit by an ordinary day's swing.`); };
  const gain = (what: string, value: number) => { if (value < 3) out.push(`${what} of +${value}% leaves little once ${FEE_NOTE}.`); };
  const exit = (p: ExitSettings) => {
    if (p.exit === "trail") swing("A trailing stop", p.trail);
    if (p.exit === "target" && !pricedExit(row)) { gain("A take profit", p.tp); swing("A stop loss", p.sl); }
  };
  switch (row.play) {
    case "hold": case "stack": exit(row.p); break;
    case "custom": if (row.p.buy === "dip" && row.p.dip < 3) out.push(`Drops of ${row.p.dip}% happen most days, so it would buy often.`); exit(row.p); break;
    case "dips": if (row.p.dip < 3) out.push(`Drops of ${row.p.dip}% happen most days, so it would buy often.`); gain("Selling each buy at a profit", row.p.tp); break;
    case "trend": swing("A trailing stop", row.p.trail); break;
    case "range": {
      const p = row.p, span = p.by === "price" ? (p.low > 0 && p.high > p.low ? (p.high / p.low - 1) * 100 : 0) : (2 * p.width * 100) / (100 - p.width);
      const step = span / Math.max(1, p.lines - 1);
      if (span > 0 && step < 1.5) out.push(`Levels are about ${step.toFixed(1)}% apart, and ${FEE_NOTE}; a step this small may not profit. Use fewer levels or a wider range.`);
      break;
    }
  }
  return out;
}

/** Why a strategy cannot run on an asset, or null when it can. */
export function playBlock(play: Play, asset: Asset, mode: BuilderMode = "execution"): string | null {
  if (mode === "demo" && asset.category !== "crypto") {
    if (play === "lp" && !asset.lp) return `No supported LP position for ${displayAssetSymbol(asset.symbol)}.`;
    if (play === "carry" && !borrowChoices(asset, mode).length) return `No verified USDT borrowing market for ${displayAssetSymbol(asset.symbol)}.`;
    return null;
  }
  if (isPlanningOnly(asset) && play !== "hold") return "Stock preview supports allocation planning with “Just hold it”. Trading strategies are not enabled.";
  if (asset.category === "stock" && play === "lp") return "Pools for stocks come later.";
  if (play === "lp" && !asset.lp) return `No approved PancakeSwap pool for ${asset.name} yet.`;
  if (play === "carry" && !asset.borrow?.length) return `No borrowing market takes ${asset.name} yet.`;
  if (asset.stable && (play === "dips" || play === "range" || play === "trend" || play === "lp" || play === "carry")) return `${asset.name} is a stablecoin; its price barely moves.`;
  return null;
}

/** Holding venues a row may use: just hold, the asset's lending markets, and slisBNB staking for BNB. */
const stockMarkets = (asset: Asset): PlanningMarkets | undefined => asset.token.toLowerCase() === XAUT_TOKEN ? XAUT_MARKETS : STOCK_VENUES.find(row => row.token === asset.token.toLowerCase());
export function venueChoices(asset: Asset, mode: BuilderMode = "execution"): Venue[] {
  if (mode === "demo" && asset.category !== "crypto") return ["hold", ...new Set(stockMarkets(asset)?.holding.map(m => m.venue) ?? [])];
  return ["hold", ...(Object.keys(asset.earn) as LendVenue[]), ...(asset.stake ? (["stake"] as const) : [])];
}
export const borrowChoices = (asset: Asset, mode: BuilderMode = "execution"): LendVenue[] =>
  mode === "demo" && asset.category !== "crypto" ? [...new Set(stockMarkets(asset)?.borrow.map(m => m.venue) ?? [])] : asset.borrow ?? [];
const venueOfRow = (row: Row): Venue => (row.play === "hold" ? row.p.venue : row.play === "custom" && row.p.buy === "once" ? row.p.venue : "hold");
export const rowVenue = venueOfRow;
/** Whether the row's holding venue is chosen in the drawer (only assets bought once at launch can be lent or staked). */
export const usesVenue = (row: Row) => row.play === "hold" || (row.play === "custom" && row.p.buy === "once");
/** A venue the drawer would not offer for this asset (a saved draft is revived from browser storage). */
export function venueProblem(row: Row, mode: BuilderMode = "execution"): string | null {
  const asset = assetOf(row.key);
  if (usesVenue(row) && !venueChoices(asset, mode).includes(venueOfRow(row))) return `${asset.name} cannot be held on that venue.`;
  if (row.play === "carry" && !borrowChoices(asset, mode).includes(row.p.borrowOn)) return `${asset.name} cannot borrow on that market.`;
  if (row.play === "carry" && !carryLendChoices(row.p.borrowOn).includes(row.p.lendOn)) return "Borrowed cash cannot be lent on the market it was borrowed from.";
  return null;
}

/** Repair obsolete demo choices without deleting an allocation or another strategy's parameters. */
function repairDemoStockRow(row: Row): Row {
  const asset = assetOf(row.key);
  if (asset.category === "crypto") return row;
  if (playBlock(row.play, asset, "demo")) return { ...row, play: "hold", p: defaults("hold") };
  if (row.play === "carry") {
    const choices = borrowChoices(asset, "demo");
    return { ...row, p: carryLend({ ...row.p, borrowOn: choices.includes(row.p.borrowOn) ? row.p.borrowOn : choices[0] }) };
  }
  if (usesVenue(row) && !venueChoices(asset, "demo").includes(venueOfRow(row))) return { ...row, p: { ...row.p, venue: "hold" } } as Row;
  return row;
}

/**
 * Whether the row's take profit and stop loss are prices. Only a token held as itself can: a lent or staked position
 * exits on a % move of its share value (the keeper takes no absolute price for a native position).
 */
export function pricedExit(row: Row): boolean {
  if (row.play !== "hold" && row.play !== "stack" && row.play !== "custom") return false;
  return row.p.by === "price" && !(usesVenue(row) && venueOfRow(row) !== "hold");
}
const isPrice = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
/** A level entered as a price that is missing or out of order, or null. */
export function levelProblem(row: Row): string | null {
  const asset = assetOf(row.key);
  if ((row.play === "hold" || row.play === "stack" || row.play === "custom") && row.p.exit === "target" && pricedExit(row)) {
    const { tpPrice, slPrice } = row.p;
    if (!isPrice(tpPrice) || !isPrice(slPrice) || (tpPrice === 0 && slPrice === 0)) return `Enter a take-profit or stop-loss price for ${asset.name}.`;
    if (tpPrice > 0 && slPrice > 0 && tpPrice <= slPrice) return `${asset.name}'s take-profit price has to be above its stop-loss price.`;
  }
  if (row.play === "range" && row.p.by === "price" && !(isPrice(row.p.low) && row.p.low > 0 && isPrice(row.p.high) && row.p.high > row.p.low)) return `Enter ${asset.name}'s range as a low and a higher high price.`;
  if (row.play === "custom" && row.p.buy === "below" && row.p.buyBy === "price" && !(isPrice(row.p.belowPrice) && row.p.belowPrice > 0)) return `Enter the price ${asset.name} has to fall below.`;
  return null;
}

/** Keeper tools (D03 T01–T19) a row runs. */
export function rowTools(row: Row): string[] {
  const venue = venueOfRow(row);
  const hold = venue === "stake" ? ["T18"] : venue === "hold" ? [] : ["T14"];
  const reinvest = venue !== "hold" && (row.play === "hold" || row.play === "custom") && row.p.reinvest > 0 ? ["T10"] : [];
  const exit = (e: Exit) => (e === "trail" ? ["T12"] : e === "target" ? ["T11"] : []);
  switch (row.play) {
    case "hold": return ["T13", ...hold, ...reinvest, ...exit(row.p.exit)];
    case "stack": return ["T01", ...exit(row.p.exit)];
    case "dips": return ["T06", "T04"];
    case "range": return ["T03", "T11"];
    case "trend": return ["T05", "T12"];
    case "lp": return ["T08", ...(row.p.recenter ? ["T09"] : []), ...(row.p.reinvest > 0 ? ["T10"] : [])];
    case "carry": return ["T19"];
    case "custom": {
      const buy = row.p.buy === "once" ? "T13" : row.p.buy === "dca" ? "T01" : row.p.buy === "dip" ? "T06" : "T11";
      return [...new Set([buy, ...hold, ...reinvest, ...exit(row.p.exit)])];
    }
  }
}
/** Tools a real BNB Chain fork suite has exercised (strategy-v3-status.ts "verified-fork"); the rest are local only. */
export const FORK_VERIFIED_TOOLS: ReadonlySet<string> = new Set(["T01", "T08", "T09", "T10", "T14", "T18", "T19"]);
export const isBeta = (tools: string[]) => tools.some((tool) => !FORK_VERIFIED_TOOLS.has(tool));
/** A row is Beta when a tool has no fork suite, or when it holds a stock priced by its own pool. */
export const rowBeta = (row: Row) => !isPlanningOnly(assetOf(row.key)) && (isBeta(rowTools(row)) || assetOf(row.key).category === "stock");

/** Positions and per-deposit join gas one row needs. */
export function rowCost(row: Row): { positions: number; gas: number } {
  if (row.play === "lp") return { positions: 1, gas: NATIVE_JOIN_GAS.lp };
  if (row.play === "carry") return { positions: 1, gas: row.p.borrowOn === "aave" ? NATIVE_JOIN_GAS.borrowAave : row.p.borrowOn === "lista" ? NATIVE_JOIN_GAS.borrowLista : NATIVE_JOIN_GAS.borrowVenus };
  const venue = venueOfRow(row);
  if (venue === "stake") return { positions: 1, gas: NATIVE_JOIN_GAS.stake };
  if (venue === "lista") return { positions: 1, gas: NATIVE_JOIN_GAS.lendListaFx };
  if (venue !== "hold") return { positions: 1, gas: NATIVE_JOIN_GAS.lendFx };
  return { positions: 1, gas: JOIN_SPOT };
}

// ---------- Fund-wide rules ----------
export type FundRules = {
  idle: { on: boolean; max: number; venue: LendVenue };
  rebalance: { on: boolean; how: "drift" | "schedule"; drift: number; every: "monthly" | "quarterly"; weight: "custom" | "equal" | "cap" };
  rotate: { on: boolean; top: number; every: "weekly" | "monthly" | "quarterly"; lookback: 30 | 90 | 180 };
  pair: { on: boolean; a: string; b: string; width: number; levels: number };
  exit: { on: boolean; sl: number; tp: number; restart: boolean; cooldown: number };
};
export const defaultRules = (): FundRules => ({
  idle: { on: false, max: 80, venue: "venus" },
  rebalance: { on: false, how: "drift", drift: 5, every: "quarterly", weight: "custom" },
  rotate: { on: false, top: 2, every: "monthly", lookback: 90 },
  pair: { on: false, a: "", b: "", width: 10, levels: 8 },
  exit: { on: false, sl: 20, tp: 0, restart: false, cooldown: 7 },
});
export const RULE_TOOLS: Record<keyof FundRules, string> = { idle: "T14", rebalance: "T02", rotate: "T07", pair: "T17", exit: "T16" };
export function rulesOn(rules: FundRules): (keyof FundRules)[] {
  return (Object.keys(RULE_TOOLS) as (keyof FundRules)[]).filter((key) => rules[key].on);
}

// ---------- Builder state ----------
export type Builder = { name: string; cover?: FundCover; collection?: "themes" | "public-figures" | "x-voices"; xHandle?: string; rows: Row[]; rules: FundRules; nextId: number };
export const emptyBuilder = (): Builder => ({ name: "", rows: [], rules: defaultRules(), nextId: 1 });
export const assetKeys = (rows: readonly Row[]) => [...new Set(rows.map((row) => row.key))];
export const totalShare = (rows: readonly Row[]) => rows.reduce((sum, row) => sum + (Number.isFinite(row.share) ? row.share : 0), 0);
export const cashShare = (rows: readonly Row[]) => Math.max(0, 100 - totalShare(rows));
/** The cash a design has to keep: 5% when any row borrows, otherwise none. */
export const cashMin = (rows: readonly Row[]) => (rows.some((row) => row.play === "carry") ? BORROWING_CASH_MIN : 0);

/** Shares nobody has typed split what is left evenly, so cash never starts as a big block. */
export function autoSplit(rows: Row[]): Row[] {
  const auto = rows.filter((row) => row.auto);
  if (!auto.length) return rows;
  const fixed = rows.filter((row) => !row.auto).reduce((sum, row) => sum + row.share, 0);
  const room = Math.max(0, 100 - cashMin(rows) - fixed);
  const each = Math.floor(room / auto.length), extra = room - each * auto.length;
  let index = 0;
  return rows.map((row) => (row.auto ? { ...row, share: Math.max(1, each + (index++ < extra ? 1 : 0)) } : row));
}

export function newRow<P extends Play>(id: number, key: string, play: P): Row {
  return { id, key, share: 0, auto: true, play, p: defaults(play) } as Row;
}
/** Strategies offered first when an asset is added again, so each of its rows runs a different one. */
const NEXT_PLAY: readonly Play[] = ["hold", "stack", "dips", "range", "trend", "custom", "lp"];
/** The first strategy this asset does not run yet and can run (borrowing is chosen by hand: it needs the whole fund). */
export function nextPlay(rows: readonly Row[], key: string, mode: BuilderMode = "execution"): Play {
  const used = new Set(rows.filter((row) => row.key === key).map((row) => row.play)), asset = assetOf(key);
  return NEXT_PLAY.find((play) => !used.has(play) && !playBlock(play, asset, mode)) ?? "custom";
}
/** Every position the fund already uses (rows and idle-cash lending): a new row needs one more. */
export const positionsFull = (state: Builder, mode: BuilderMode = "execution") => capacity(state).positions >= builderLimits(mode).positions;
/**
 * Adds an asset, or another row for an asset already in the fund: the same asset can run several strategies (a core
 * position plus slices). The new row sits after the asset's other rows and starts with a strategy it does not run
 * yet, within the mode's distinct-asset and position limits.
 */
export function addAsset(state: Builder, key: string, mode: BuilderMode = "execution"): Builder {
  const asset = assetOf(key), keys = assetKeys(state.rows);
  if (stockSourceChoices(asset).some(source => source.key !== key && keys.includes(source.key))) return state;
  if (mode !== "demo" && isPlanningOnly(asset) && keys.includes(key)) return state;
  if (!(canAdd(asset) || isPlanningOnly(asset)) || (!keys.includes(key) && keys.length >= builderLimits(mode).assets) || positionsFull(state, mode)) return state;
  const rows = [...state.rows], last = rows.map((row) => row.key).lastIndexOf(key);
  rows.splice(last < 0 ? rows.length : last + 1, 0, newRow(state.nextId, key, nextPlay(state.rows, key, mode)));
  return { ...state, rows: autoSplit(rows), nextId: state.nextId + 1 };
}
/** Demo preserves slices and supported settings; protocol choices are checked against the new token. */
export function switchStockSource(state: Builder, key: string, issuer: StockIssuer, editingRowId?: number, mode: BuilderMode = "execution"): Builder {
  const asset = assetOf(key), target = stockSourceChoices(asset).find(source => (source.issuer ?? "bstock") === issuer);
  const previous = state.rows.filter(row => row.key === key);
  if (!target || target.key === key || !previous.length || state.rows.some(row => row.key === target.key)) return state;
  const first = previous.find(row => row.id === editingRowId) ?? previous[0];
  const replacement = { ...newRow(first.id, target.key, "hold"), share: previous.reduce((n, row) => n + row.share, 0), auto: previous.every(row => row.auto) };
  const rows = mode === "demo" ? state.rows.map(row => row.key === key ? repairDemoStockRow({ ...row, key: target.key }) : row)
    : state.rows.flatMap(row => row.id === first.id ? [replacement] : row.key === key ? [] : [row]);
  const pair = state.rules.pair;
  const rules = { ...state.rules, pair: { ...pair, a: pair.a === key ? target.key : pair.a, b: pair.b === key ? target.key : pair.b } };
  return { ...state, rows, rules };
}
export function removeRow(state: Builder, id: number): Builder {
  const rows = autoSplit(state.rows.filter((row) => row.id !== id));
  const keys = assetKeys(rows);
  const pair = state.rules.pair;
  // A pair grid needs both of its assets in the fund.
  const rules = pair.on && !(keys.includes(pair.a) && keys.includes(pair.b) && pair.a !== pair.b) ? { ...state.rules, pair: { ...pair, on: false } } : state.rules;
  return { ...state, rows, rules };
}
export function setShare(state: Builder, id: number, value: number): Builder {
  const share = Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));
  return { ...state, rows: autoSplit(state.rows.map((row) => (row.id === id ? { ...row, share, auto: false } : row))) };
}
export function splitEvenly(state: Builder): Builder {
  return { ...state, rows: autoSplit(state.rows.map((row) => ({ ...row, auto: true }))) };
}
/**
 * Where Borrow & earn can lend what it borrowed. Not back into the market it borrowed from: on Venus or Aave the
 * borrowed USDT and the lent USDT would be the same market, whose supply rate is its borrow rate times utilization
 * after the reserve factor, so the carry is always negative and the fund would never borrow. Lista lends through its
 * USDT vault, which spans other markets, so a Lista loan may be lent there.
 */
export function carryLendChoices(borrowOn: LendVenue): LendVenue[] {
  return (["venus", "aave", "lista"] as LendVenue[]).filter((venue) => venue === "lista" || venue !== borrowOn);
}
/** A carry row's lending venue, kept among the choices its borrowing venue allows. */
function carryLend(carry: Settings["carry"]): Settings["carry"] {
  const choices = carryLendChoices(carry.borrowOn);
  return choices.includes(carry.lendOn) ? carry : { ...carry, lendOn: choices[0] };
}
/** A strategy's defaults on this asset: borrowing starts on a market that takes the asset (Aave when it does). */
function defaultsFor(play: Play, key: string, mode: BuilderMode): Settings[Play] {
  const p = defaults(play);
  if (play === "carry") {
    const carry = p as Settings["carry"], borrow = borrowChoices(assetOf(key), mode);
    if (borrow.length && !borrow.includes(carry.borrowOn)) carry.borrowOn = borrow[0];
    return carryLend(carry);
  }
  return p;
}
export function setPlay(state: Builder, id: number, play: Play, mode: BuilderMode = "execution"): Builder {
  // Borrowing changes the cash minimum, so unset shares are split again.
  return { ...state, rows: autoSplit(state.rows.map((row) => (row.id === id && row.play !== play ? ({ ...row, play, p: defaultsFor(play, row.key, mode) } as Row) : row))) };
}
export function setSetting(state: Builder, id: number, field: string, value: unknown): Builder {
  return { ...state, rows: state.rows.map((row) => {
    if (row.id !== id) return row;
    const limit = limitsOf(row.play)[field];
    const p = { ...row.p, [field]: limit && typeof value === "number" ? clampTo(limit, value) : value };
    // Moving a loan to the market it lends on moves the lending elsewhere.
    return { ...row, p: row.play === "carry" && field === "borrowOn" ? carryLend(p as Settings["carry"]) : p } as Row;
  }) };
}
/** How an Earn fees row is re-centered: after `outside` hours out of range, at most `perDay` times a day. */
export type LpRecenter = Pick<Settings["lp"], "outside" | "perDay">;
/**
 * The design with row `id`'s re-centering moved onto the nearest of those `offered` for its asset and range (on
 * testnet, the ones its admitted pool keys fix for good): its own when offered, else one with the same hours out of
 * range, else one with the same re-centers a day, else the first. Any other row, or none offered, leaves it as it is.
 */
export function fitRecenter(state: Builder, id: number, offered: (key: string, width: Settings["lp"]["width"]) => readonly LpRecenter[]): Builder {
  const row = state.rows.find((r) => r.id === id);
  if (row?.play !== "lp") return state;
  const { outside, perDay } = row.p, choices = offered(row.key, row.p.width);
  const fit = choices.find((r) => r.outside === outside && r.perDay === perDay) ?? choices.find((r) => r.outside === outside) ?? choices.find((r) => r.perDay === perDay) ?? choices[0];
  if (!fit || (fit.outside === outside && fit.perDay === perDay)) return state;
  return setSetting(setSetting(state, id, "outside", fit.outside), id, "perDay", fit.perDay);
}
/** A second strategy on the same asset takes half of the row's share (a core position plus a slice). */
export function addSlice(state: Builder, id: number, mode: BuilderMode = "execution"): Builder {
  const index = state.rows.findIndex((row) => row.id === id);
  if (index < 0) return state;
  const row = state.rows[index], asset = assetOf(row.key);
  if (mode !== "demo" && isPlanningOnly(asset)) return state;
  const half = Math.max(1, Math.floor(row.share / 2));
  const play: Play = row.play === "range" ? "stack" : playBlock("range", asset, mode) ? "stack" : "range";
  const slice = { ...newRow(state.nextId, row.key, play), share: half, auto: false };
  const rows = [...state.rows];
  rows.splice(index, 1, { ...row, share: Math.max(1, row.share - half), auto: false }, slice);
  return { ...state, rows, nextId: state.nextId + 1 };
}

export function capacity(state: Builder): { positions: number; gas: number } {
  let positions = 0, gas = JOIN_BASE;
  for (const row of state.rows) {
    const cost = rowCost(row);
    positions += cost.positions;
    gas += cost.gas;
  }
  if (state.rules.idle.on) {
    positions += 1;
    gas += IDLE_JOIN_GAS[state.rules.idle.venue] ?? NATIVE_JOIN_GAS.idleVenus;
  }
  return { positions, gas };
}

/** The first thing that keeps this design from being created, or "" when it can go to review. */
export function problem(state: Builder, mode: BuilderMode = "execution"): string {
  if (!state.rows.length) return "";
  const limits = builderLimits(mode);
  if (mode === "demo" && assetKeys(state.rows).length > limits.assets) return `A fund can hold at most ${limits.assets} assets.`;
  const total = totalShare(state.rows);
  if (state.rows.some((row) => row.share < 1)) return "Every asset needs a share of at least 1%.";
  const minimum = cashMin(state.rows);
  if (total > 100 - minimum) return minimum ? `Shares add up to ${total}%. A fund that borrows keeps at least ${minimum}% in cash; lower one.` : `Shares add up to ${total}%. Lower one to 100% or less.`;
  for (const row of state.rows) {
    const block = playBlock(row.play, assetOf(row.key), mode) ?? venueProblem(row, mode) ?? levelProblem(row);
    if (block) return block;
  }
  const range = outOfRange(state);
  if (range) return range;
  const { positions, gas } = capacity(state);
  if (positions > limits.positions || (mode !== "demo" && gas > JOIN_LIMIT)) {
    if (state.rows.some((row) => row.play === "carry") && state.rows.length > 1) return "Borrowing uses most of what one fund can run, so it has to be the fund's only asset.";
    return `This is more than one fund can run (${positions} of ${limits.positions} positions, ${formatGas(gas)} of ${formatGas(JOIN_LIMIT)} gas per deposit). Switch an asset to “Just hold it”, remove one, or turn off earning on idle cash.`;
  }
  const pair = state.rules.pair;
  if (pair.on && (pair.a === pair.b || !assetKeys(state.rows).includes(pair.a) || !assetKeys(state.rows).includes(pair.b))) return "The pair grid needs two different assets that are both in the fund.";
  if (state.rules.rotate.on && state.rules.rotate.top >= assetKeys(state.rows).length) return "“Hold the strongest” needs to keep fewer assets than the fund holds.";
  return "";
}
export const formatGas = (gas: number) => `${(gas / 1_000_000).toFixed(2)}M`;

// ---------- Words ----------
export const pct = (value: number) => (value >= 10 ? value.toFixed(1) : value.toFixed(2)) + "%";
const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const venueLabel = (asset: Asset, venue: Venue) => (venue === "lista" ? asset.lista ?? "Lista vault" : venue === "stake" ? "slisBNB staking" : VENUE_NAME[venue as LendVenue] ?? "");
const lookbackName = (value: Lookback) => (LOOKBACK.find((entry) => entry[0] === value) ?? LOOKBACK[2])[2];
/**
 * A schedule in words. Given the time zone the design keeps (a testnet design: the creator's), every period names its
 * time in that zone, since the keeper's calendar buys at that time whatever the period; without one, as the demo shows it.
 */
function schedule(p: { every: Every; day?: number; date?: number; time?: string }, timeZone?: string) {
  const at = `at ${p.time ?? "09:00"}${timeZone ? ` (${timeZone})` : ""}`;
  if (p.every === "daily") return `every day ${at}`;
  if (p.every === "monthly") return `on day ${p.date ?? 1} of each month${timeZone ? ` ${at}` : ""}`;
  if (p.every === "quarterly") return `on day ${p.date ?? 1} of each quarter${timeZone ? ` ${at}` : ""}`;
  return `every ${DAYS[p.day ?? 0]} ${at}`;
}
export function apyOf(row: Row): number {
  const venue = venueOfRow(row);
  if (venue === "hold" || venue === "stake") return 0;
  return assetOf(row.key).earn[venue] ?? 0;
}

/** One line under the strategy name in the holdings table; `timeZone` is the one the design keeps its schedule times in. */
export function summary(row: Row, timeZone?: string): string {
  const asset = assetOf(row.key);
  const earn = (venue: Venue) => (venue === "hold" ? "" : asset.category === "stock" && venue === "venus" ? " · Venus collateral" : ` · ${venue === "stake" ? "staked" : venue === "lista" ? "Lista vault" : VENUE_NAME[venue]}${venue !== "stake" && asset.earn[venue] !== undefined ? ` ${pct(asset.earn[venue]!)}` : ""}`);
  const exit = (p: ExitSettings) => {
    if (p.exit === "trail") return ` · trailing stop ${p.trail}%`;
    if (p.exit !== "target") return "";
    if (!pricedExit(row)) return ` · TP +${p.tp}% / SL −${p.sl}%`;
    return ` · ${[p.tpPrice > 0 && `TP ${usd(p.tpPrice)}`, p.slPrice > 0 && `SL ${usd(p.slPrice)}`].filter(Boolean).join(" / ")}`;
  };
  switch (row.play) {
    case "hold": return `Bought at launch${earn(row.p.venue)}${exit(row.p)}`;
    case "stack": return `${cap(schedule(row.p, timeZone))} · ${row.p.buys} buys${exit(row.p)}`;
    case "dips": return `After ${row.p.dip}% drops · each buy sold at +${row.p.tp}%`;
    case "range": return `${row.p.by === "price" ? `${usd(row.p.low)}–${usd(row.p.high)}` : `±${row.p.width}% around launch price`} · ${row.p.lines} levels${row.p.follow ? " · follows up" : ""}`;
    case "trend": return `${cap(lookbackName(row.p.lookback))} breakouts · ${row.p.adds} adds · exits −${row.p.trail}%`;
    case "lp": return `${cap(row.p.width)} range · fees ${row.p.reinvest ? `${row.p.reinvest}% reinvested` : "kept"}`;
    case "carry": return `Borrows USDT on ${VENUE_NAME[row.p.borrowOn]} to ${row.p.ltv}% · lent on ${VENUE_NAME[row.p.lendOn]}`;
    case "custom": {
      const p = row.p;
      const buy = p.buy === "once" ? "At launch" : p.buy === "dca" ? cap(p.every) : p.buy === "dip" ? `After ${p.dip}% drops` : p.buyBy === "price" ? `Below ${usd(p.belowPrice)}` : `Below −${p.below}%`;
      return `${buy}${p.buy === "once" ? earn(p.venue) : ""}${exit(p)}`;
    }
  }
}

/** The sentence holders read: `lead` is the share and asset, `text` the rest; `timeZone` as for summary(). */
export function sentence(row: Row, timeZone?: string): { lead: string; text: string } {
  const asset = assetOf(row.key), lead = `${row.share}% ${asset.name}`;
  const earn = (venue: Venue) => {
    if (venue === "hold") return "";
    if (venue === "stake") return ", staked as slisBNB";
    if (asset.category === "stock" && venue === "venus") return ", held as collateral on Venus";
    const rate = asset.earn[venue];
    return `, ${venue === "lista" ? `kept in the ${venueLabel(asset, venue)}` : `lent on ${VENUE_NAME[venue]}`}${rate !== undefined ? ` (${pct(rate)} a year)` : ""}`;
  };
  const exit = (p: ExitSettings) => {
    if (p.exit === "trail") return ` Sold if it falls ${p.trail}% from its high.`;
    if (p.exit !== "target") return "";
    // A token held as itself sells at a % of its cost basis; a lent or staked position at a % move of its value per
    // share from when the position opened (execution/strategy-v3/native-rounds.mjs).
    if (!pricedExit(row)) return usesVenue(row) && venueOfRow(row) !== "hold"
      ? ` Sold if its value rises ${p.tp}% or falls ${p.sl}% from when the position opened.`
      : ` Sold at +${p.tp}% or −${p.sl}% from ${AVERAGE_BUY_PRICE}.`;
    if (p.tpPrice > 0 && p.slPrice > 0) return ` Sold if it reaches ${usd(p.tpPrice)} or falls to ${usd(p.slPrice)}.`;
    return p.tpPrice > 0 ? ` Sold if it reaches ${usd(p.tpPrice)}.` : ` Sold if it falls to ${usd(p.slPrice)}.`;
  };
  switch (row.play) {
    case "hold": return { lead, text: `, bought at launch${earn(row.p.venue)}.${exit(row.p)}` };
    case "stack": return { lead, text: `, bought ${schedule(row.p, timeZone)} over ${row.p.buys} buys; each buy spends what is left for it divided by the buys remaining.${exit(row.p)}` };
    case "dips": return { lead, text: `, bought after a ${row.p.dip}% drop once it bounces ${row.p.bounce}%. Each buy is sold at +${row.p.tp}% and bought back ${row.p.rebuy}% lower.` };
    case "range": return { lead, text: `, traded ${row.p.by === "price" ? `between ${usd(row.p.low)} and ${usd(row.p.high)}` : `between −${row.p.width}% and +${row.p.width}% of its launch price`} with ${row.p.lines} levels${row.p.follow ? "; the range moves up if price breaks out" : ""}. Sold if it falls ${row.p.stop}% below the range.` };
    case "trend": return { lead, text: `, bought when it breaks its ${lookbackName(row.p.lookback)} high and added up to ${row.p.adds} times every ${row.p.step}% higher. Sold if it falls ${row.p.trail}% from its peak, or ${row.p.stop}% below the launch price.` };
    case "lp": return { lead, text: `, paired with USDT in a PancakeSwap pool (${row.p.width} range)${row.p.recenter ? `, re-centered after ${row.p.outside} h out of range, at most ${row.p.perDay} a day` : ""}. ${row.p.reinvest ? `${row.p.reinvest}% of fees are reinvested.` : "Fees are kept."}` };
    case "carry": return { lead, text: `, held on ${VENUE_NAME[row.p.borrowOn]} as collateral to borrow USDT up to ${row.p.ltv}% of its value; the USDT is lent on ${VENUE_NAME[row.p.lendOn]}.` };
    case "custom": {
      const p = row.p;
      const buy = p.buy === "once" ? "bought at launch" : p.buy === "dca" ? `bought ${p.every}` : p.buy === "dip" ? `bought after ${p.dip}% drops` : p.buyBy === "price" ? `bought only below ${usd(p.belowPrice)}` : `bought only ${p.below}% below its launch price`;
      return { lead, text: `, ${buy}${p.buy === "once" ? earn(p.venue) : ""}.${exit(p)}` };
    }
  }
}

/** Whether a row's words measure a level from the launch price: a % range, a trend's hard stop, a % buy-below level. */
export const namesLaunchPrice = (row: Row) =>
  (row.play === "range" && row.p.by === "pct") || row.play === "trend" || (row.play === "custom" && row.p.buy === "below" && row.p.buyBy === "pct");
/** What the review adds under the holders' sentences when one of them names the launch price, or "". */
export const launchPriceNote = (rows: readonly Row[]) => (rows.some(namesLaunchPrice) ? `The launch price is ${LAUNCH_PRICE}.` : "");

/** `words` renames the cash and where idle cash is lent (the testnet Create page: sUSD, the sandbox lending vault). */
export function fundSentences(state: Builder, words: { cash?: string; idle?: string } = {}): string[] {
  const { rules } = state, out: string[] = [];
  out.push(`It keeps ${cashShare(state.rows)}% in ${words.cash ?? CASH.symbol} as a cash buffer${rules.idle.on ? `, lending up to ${rules.idle.max}% of idle cash ${words.idle ?? `on ${VENUE_NAME[rules.idle.venue]}`}` : ""}.`);
  if (rules.rebalance.on) out.push(`It rebalances ${rules.rebalance.how === "drift" ? `when an asset is ${rules.rebalance.drift} points off its share` : rules.rebalance.every} ${rules.rebalance.weight === "equal" ? "to equal weights" : rules.rebalance.weight === "cap" ? "to market-cap weights capped at 20%" : "back to the shares above"}.`);
  if (rules.rotate.on) out.push(`It holds only the top ${rules.rotate.top} of its assets by ${rules.rotate.lookback}-day return, checked ${rules.rotate.every}.`);
  if (rules.pair.on && ASSET_BY_KEY.has(rules.pair.a) && ASSET_BY_KEY.has(rules.pair.b)) out.push(`It swaps between ${assetOf(rules.pair.a).name} and ${assetOf(rules.pair.b).name} at ${rules.pair.levels} levels within ±${rules.pair.width}% of their price ratio.`);
  if (rules.exit.on) out.push(`It sells everything if the fund falls ${rules.exit.sl}%${rules.exit.tp ? ` or rises ${rules.exit.tp}%` : ""}${rules.exit.restart ? `, then restarts after ${rules.exit.cooldown} days` : " and stays in cash"}.`);
  return out;
}

/** What cannot change once the fund is live. */
export function fixedOnceLive(state: Builder): string[] {
  const items = ["Each asset's share", "Your performance fee"];
  if (state.rules.exit.on) items.push("The fund stop / take-profit");
  if (state.rows.some((row) => (usesVenue(row) && venueOfRow(row) !== "hold") || row.play === "lp")) items.push("How much interest and fees are reinvested");
  if (state.rows.some((row) => row.play === "lp")) items.push("Pool range and re-centering rules");
  return items;
}

/** The risk a creator confirms, by the riskiest part of the design. */
export function consent(state: Builder): string {
  if (state.rows.some((row) => row.play === "carry")) return "I understand the fund borrows against its assets; all holders share the debt, and a fast drop can force repayment at a loss.";
  if (state.rows.some((row) => row.play === "lp")) return "I understand pool positions lose value when prices move apart, and my stake can be lost.";
  if (state.rows.some((row) => venueOfRow(row) === "stake")) return "I understand staked BNB takes 7–15 days to unstake, so withdrawals can be slow.";
  if (state.rows.some((row) => venueOfRow(row) !== "hold") || state.rules.idle.on) return "I understand lent assets can be stuck if a lending market runs short, and the fund can lose value.";
  return "I understand the fund can lose value and my stake is at risk.";
}

/** Base lending income per year across the fund, in percent of fund value. */
export function lendingIncome(state: Builder): number {
  const rows = state.rows.reduce((sum, row) => sum + (apyOf(row) * row.share) / 100, 0);
  const idle = state.rules.idle.on ? (CASH_APY[state.rules.idle.venue] * cashShare(state.rows) * state.rules.idle.max) / 10_000 : 0;
  return rows + idle;
}

// ---------- Launch terms ----------
/** Performance fee range a creator picks; CRE8 adds its own 10% and a 1% deposit fee. */
export const FEE = { min: 0, max: 20, default: 10, platform: 10, depositPct: 1 } as const;
/** The fund takes at most 50 times the creator's stake (the creator keeps at least 2%). */
export const STAKE = { min: 100, step: 50, default: 100, capacityMultiple: 50 } as const;
/**
 * Each scope's lifetime funding cap (`maximumFunding`, immutable once sealed): five times its share of the fund's
 * full capacity, so trading and re-buys never exhaust it while one asset can never absorb the whole fund.
 */
export const FUNDING_CAP_MULTIPLE = 5;
export function maximumFunding(share: number, stake: number): number {
  return Math.round((share / 100) * stake * STAKE.capacityMultiple * FUNDING_CAP_MULTIPLE);
}

// ---------- Design export ----------
export const DESIGN_SCHEMA = "cre8.fund-design/1";
export type Terms = { fee: number; stake: number };
export function fundDesign(state: Builder, terms: Terms, createdAt: string, mode: BuilderMode = "execution") {
  const { positions, gas } = capacity(state);
  return {
    schema: DESIGN_SCHEMA,
    createdAt,
    chainId: 56,
    name: state.name.trim(),
    ...((reviveFundCover(state.cover) || state.collection || normalizeXHandle(state.xHandle)) ? { presentation: {
      ...(reviveFundCover(state.cover) ? {cover:reviveFundCover(state.cover)} : {}),
      ...(state.collection ? {collection:state.collection} : {}),
      ...(normalizeXHandle(state.xHandle) ? {xHandle:normalizeXHandle(state.xHandle)} : {}),
      ...(state.collection === "x-voices" ? {disclaimer:X_MODEL_DISCLAIMER} : {}),
    } } : {}),
    performanceFeeBps: terms.fee * 100,
    platformFeeBps: FEE.platform * 100,
    depositFeeBps: FEE.depositPct * 100,
    stakeUsdt: terms.stake,
    capacityUsdt: terms.stake * STAKE.capacityMultiple,
    cash: { token: CASH.symbol, shareBps: cashShare(state.rows) * 100 },
    assets: state.rows.map((row) => {
      const asset = assetOf(row.key), tools = rowTools(row), classification = classifyAsset(asset);
      const supported = !isPlanningOnly(asset) && !playBlock(row.play, asset) && !venueProblem(row);
      return {
        asset: asset.key,
        symbol: asset.symbol,
        token: asset.token,
        ...(asset.decimals !== undefined ? { tokenDecimals: asset.decimals } : {}),
        assetClass: classification.assetClass,
        ...(classification.rwaType ? { rwaType: classification.rwaType } : {}),
        targetId: asset.targetId,
        availability: asset.status,
        ...(asset.category === "stock" ? { issuer: asset.issuer ?? "bstock", executionReady: false } : {}),
        ...(asset.category === "rwa" ? { executionReady: false } : {}),
        ...(mode === "demo" && asset.category !== "crypto" ? { marketCheck: asset.token.toLowerCase() === XAUT_TOKEN ? XAUT_CHECK : STOCK_VENUE_CHECK, plannedMarkets: row.play === "carry"
          ? (stockMarkets(asset)?.borrow ?? []).filter(m => m.venue === row.p.borrowOn)
          : usesVenue(row) ? (stockMarkets(asset)?.holding ?? []).filter(m => m.venue === venueOfRow(row)) : [] } : {}),
        priceSource: asset.issuer === "ondo" ? "independent-nav-pending" : asset.status === "preview" ? "unreviewed" : asset.category === "stock" ? "pancake-v3-30-minute-twap" : "chainlink",
        shareBps: row.share * 100,
        maximumFundingUsdt: maximumFunding(row.share, terms.stake),
        strategy: row.play,
        // A lent or staked row keeps % levels whatever was picked before its venue changed.
        settings: (row.play === "hold" || row.play === "stack" || row.play === "custom") && row.p.by === "price" && !pricedExit(row) ? { ...row.p, by: "pct" } : row.p,
        plannedTools: tools,
        tools: supported ? tools : [],
        beta: supported ? rowBeta(row) : false,
      };
    }),
    rules: Object.fromEntries(rulesOn(state.rules).map((key) => [key, { ...state.rules[key], tool: RULE_TOOLS[key] }])),
    capacity: { positions, maximumAssets: builderLimits(mode).assets, maximumPositions: builderLimits(mode).positions, joinGas: gas, maximumJoinGas: JOIN_LIMIT },
    keeper: { maximumFeeBps: MAX_FEE_BPS, dcaSizing: "remaining" },
    executionPolicy: { onTrigger: "attempt-if-executable", onUnavailable: "skip", requireFreshQuote: true, requireSimulation: true },
    notes: [
      "A design, not a transaction: nothing here is signed or sent.",
      `A take-profit or stop-loss set as a percentage is measured from the average price the fund paid for the asset, fees included; a lent or staked position's, from its value when the position opened. Range bounds, buy-below levels and hard stops set as percentages, and the buy ceilings a design leaves open, are measured from the launch price: ${LAUNCH_PRICE}. Levels entered as prices are USDT per token, used as entered.`,
      "Join gas for lending, staking and pool positions is estimated from sandbox measurements until a mainnet fork measures it.",
      "Demo asset trading strategies can be planned freely; protocol choices require verified exact-token markets. At a trigger, execution must verify current support, quotes and simulation; unavailable actions are skipped. This file records intent and does not start a worker or authorize a trade.",
    ],
  };
}

// ---------- Saved drafts ----------
export const DRAFT_STORAGE_KEY = "cre8.fund-builder.draft.v1";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** Keep only fields that exist in `base` with the same type; anything else falls back to the default. */
function mergeShape<T extends Record<string, unknown>>(base: T, stored: unknown): T {
  if (!isRecord(stored)) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(base)) {
    const next = stored[key];
    if (typeof next === typeof value && (typeof next !== "number" || Number.isFinite(next))) out[key] = next;
  }
  return out as T;
}
/** A draft read back from browser storage, checked field by field; null when nothing usable is there. */
export function reviveBuilder(value: unknown, mode: BuilderMode = "execution"): Builder | null {
  if (!isRecord(value) || !Array.isArray(value.rows)) return null;
  const limits = builderLimits(mode);
  let state: Builder = { ...emptyBuilder(), name: typeof value.name === "string" ? value.name.slice(0, 64) : "" };
  const cover = reviveFundCover(value.cover);
  if (cover) state.cover = cover;
  if (["themes", "public-figures", "x-voices"].includes(String(value.collection))) state.collection = value.collection as Builder["collection"];
  const xHandle = normalizeXHandle(value.xHandle);
  if (xHandle) state.xHandle = xHandle;
  for (const stored of value.rows.slice(0, limits.positions)) {
    if (!isRecord(stored) || typeof stored.key !== "string" || typeof stored.play !== "string" || !Object.hasOwn(PLAYS, stored.play)) continue;
    const asset = ASSET_BY_KEY.get(stored.key);
    if (!asset || !(canAdd(asset) || isPlanningOnly(asset))) continue;
    if (!assetKeys(state.rows).includes(asset.key) && assetKeys(state.rows).length >= limits.assets) continue;
    const play = stored.play as Play;
    const share = typeof stored.share === "number" && Number.isFinite(stored.share) ? Math.max(0, Math.min(100, Math.round(stored.share))) : 0;
    const p = mergeShape(defaults(play) as Record<string, unknown>, stored.p);
    for (const field of ["by", "buyBy"]) if (field in p && p[field] !== "pct" && p[field] !== "price") p[field] = "pct";
    for (const [field, limit] of Object.entries(limitsOf(play))) p[field] = clampTo(limit, p[field] as number);
    const original = { id: state.nextId, key: asset.key, share, auto: stored.auto !== false, play, p } as Row;
    const row = mode === "demo" ? repairDemoStockRow(original) : original;
    if (venueProblem(row, mode)) continue;
    state = { ...state, rows: [...state.rows, row], nextId: state.nextId + 1 };
  }
  const rules = defaultRules(), storedRules = isRecord(value.rules) ? value.rules : {};
  for (const key of Object.keys(rules) as (keyof FundRules)[]) {
    const rule = mergeShape(rules[key] as Record<string, unknown>, storedRules[key]);
    for (const [field, limit] of Object.entries((RULE_LIMITS as Record<string, Record<string, Limit>>)[key] ?? {})) rule[field] = clampTo(limit, rule[field] as number);
    (rules as Record<string, unknown>)[key] = rule;
  }
  if (!Object.hasOwn(CASH_MARKET, rules.idle.venue)) rules.idle.venue = "venus";
  // Demo allocations may deliberately leave cash after an unsupported strategy or issuer is changed.
  return { ...state, rows: mode === "demo" ? state.rows : autoSplit(state.rows), rules };
}
