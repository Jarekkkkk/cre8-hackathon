import { REFERENCE_FUNDS } from "../lib/public-funds";
import type { ReferenceFund } from "../lib/public-funds";
import type { MockFund, MockHolding } from "./mock-funds";
// 票券的目標配置取自原目標權重；不能把目前漂移後的持倉冒充 mandate。
export function catalogueTargets(fund: ReferenceFund): MockHolding[] {
  const rows = fund.backtest.targets
    .filter((t) => t.weight > 0)
    .map((t) => ({ symbol: t.symbol, weight: t.weight }));
  const cash = Math.max(0, 100 - rows.reduce((sum, t) => sum + t.weight, 0));
  if (cash > 1e-6) rows.push({ symbol: "USDT", weight: cash });
  const prepared = rows.map((row) => ({
    ...row,
    exact: row.weight * 100,
    weightBps: Math.floor(row.weight * 100),
  }));
  const missing = 10000 - prepared.reduce((sum, row) => sum + row.weightBps, 0),
    order = [...prepared].sort(
      (a, b) => b.exact - b.weightBps - (a.exact - a.weightBps),
    );
  for (let i = 0; i < missing; i++) order[i % order.length].weightBps++;
  return prepared.map(({ symbol, weightBps }) => ({ symbol, weightBps }));
}
export const PUBLIC_FUNDS: MockFund[] = REFERENCE_FUNDS.map((f) => ({
  slug: f.slug,
  name: f.name,
  symbol: f.symbol,
  thesis: f.strategy,
  subtitle: f.strategy,
  kind: f.group || "stocks",
  mark: f.symbol,
  risk: f.risk,
  rebalance:
    f.backtest.rebalance === "monthly"
      ? "monthly"
      : f.backtest.rebalance === "drift"
        ? "drift"
        : "none",
  holdings: catalogueTargets(f),
}));
