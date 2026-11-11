import snapshot from "../data/stock-liquidity/current.json" with { type: "json" };
import { stockLiquiditySufficient, type StockLiquidityEntry } from "./stock-liquidity-policy";

export const STOCK_LIQUIDITY_CHECKED_AT = snapshot.capturedAt;
const entries = snapshot.schema === "cre8/stock-liquidity@1" && snapshot.chainId === 56
  ? snapshot.entries as StockLiquidityEntry[] : [];
const duplicate = new Set(entries.filter((entry, i) => entries.findIndex(other => other.token === entry.token) !== i).map(entry => entry.token));
const byToken = new Map(entries.filter(entry => !duplicate.has(entry.token)).map(entry => [entry.token, entry]));
/** Last verified planning snapshot, never an execution or oracle signal. Missing evidence hides new choices. */
export function hasStockLiquidity(asset: { token: string; issuer?: "bstock" | "ondo" }): boolean {
  const entry = byToken.get(asset.token.toLowerCase());
  return !!entry && entry.method === (asset.issuer === "ondo" ? "pcsx-indicative-rfq" : "pancake-v3") && stockLiquiditySufficient(entry);
}

/** Evidence labels, not an execution promise or a comparison between RFQ and pool depth. */
export function stockLiquidityLabel(asset: { token: string; issuer?: "bstock" | "ondo" }): string {
  const date = STOCK_LIQUIDITY_CHECKED_AT.slice(0, 10);
  if (hasStockLiquidity(asset)) return asset.issuer === "ondo"
    ? `Indicative quotes checked ${date}; execution liquidity is not verified.`
    : `Pool liquidity screen passed ${date}; at least 10,000 USDT depth each way within 2%.`;
  const entry = byToken.get(asset.token.toLowerCase());
  return entry
    ? `Liquidity screen not passed ${date}; evidence may be insufficient or unavailable.`
    : "Liquidity not checked; available for planning only.";
}
