import type { Asset, LendVenue } from "./fund-builder";
import evidence from "../data/rwa/xaut/snapshot.json" with { type: "json" };
import { stockLiquiditySufficient } from "./stock-liquidity-policy";

export const XAUT_TOKEN = "0x21caef8a43163eea865baee23b9c2e327696a3bf";
const USDT = "0x55d398326f99059ff775485246999027b3197955";
export const XAUT_ENABLED = evidence.chainId === 56 && evidence.token === XAUT_TOKEN && evidence.symbol === "XAUt"
  && evidence.decimals === 6 && evidence.liquidity.entry.method === "pancake-v3"
  && stockLiquiditySufficient({ ...evidence.liquidity.entry, method: "pancake-v3" });
export const XAUT_CHECK = { chainId: evidence.chainId, checkedAt: evidence.checkedAt, blockNumber: evidence.blockNumber, blockHash: evidence.blockHash };
export const XAUT_ASSET: Asset = { key: "XAUT", name: "Tether Gold", symbol: "XAUt", token: XAUT_TOKEN, decimals: 6,
  targetId: "rwa:XAUt", category: "rwa", status: "preview", earn: {} };
export type PlanningMarkets = {
  holding: readonly { venue: LendVenue; market: string; kind: string }[];
  borrow: readonly { venue: LendVenue; market: string; loanToken: string }[];
};
export const XAUT_MARKETS: PlanningMarkets = {
  holding: XAUT_ENABLED && evidence.lista.vault.asset.toLowerCase() === XAUT_TOKEN && !evidence.lista.vault.problems.length
    ? [{ venue: "lista", market: evidence.lista.vault.vault.toLowerCase(), kind: "vault" }] : [],
  borrow: XAUT_ENABLED && evidence.lista.borrow.params.collateralToken.toLowerCase() === XAUT_TOKEN
    && evidence.lista.borrow.params.loanToken.toLowerCase() === USDT && !evidence.lista.borrow.problems.length
    ? [{ venue: "lista", market: evidence.lista.borrow.id, loanToken: USDT }] : [],
};
