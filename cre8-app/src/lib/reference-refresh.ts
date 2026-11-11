import {
  REFERENCE_FUNDS,
  REFERENCE_METADATA,
  RISK_FREE,
  HISTORY_THROUGH,
  updateReferenceMeta,
  referenceHoldings,
} from "./public-funds";
import {
  recentModelTrades,
  modelTradeUpdates,
} from "../reference/lib/recent-trades";
import type { ReferenceFund } from "./public-funds";
import {
  analyzeFundPerformance,
  periodSeries,
} from "../reference/lib/fund-explore";
const isDate = (value: unknown): value is string =>
  typeof value === "string" &&
  /^20\d{2}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
const DAY = 86400000,
  listeners = new Set<() => void>();
let revision = 0,
  pending: Promise<boolean> | null = null,
  retryAfter = 0;
export const subscribeReference = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const referenceRevision = () => revision;
// 僅接受同一份目錄的完整觀察；失敗保留原始截止日，絕不補平價格或套用新配置回寫歷史。
export function validReferenceUpdate(
  value: unknown,
  through: string,
): value is {
  schema: string;
  through: string;
  funds: ReferenceFund[];
  riskFree: typeof RISK_FREE;
} {
  if (!value || typeof value !== "object") return false;
  try {
    const data = value as {
      schema?: string;
      through?: string;
      funds?: ReferenceFund[];
      profileHistoryBasis?: string;
    };
    if (
      data.schema !== "cre8/demo-funds@1" ||
      data.profileHistoryBasis !== "source-events@2" ||
      !isDate(data.through) ||
      !isDate(through) ||
      !/^20\d{2}-\d{2}-\d{2}$/.test(data.through) ||
      data.through <= HISTORY_THROUGH ||
      data.through > through ||
      !Array.isArray(data.funds) ||
      data.funds.length !== REFERENCE_FUNDS.length
    )
      return false;
    if (new Set(data.funds.map((f) => f.slug)).size !== REFERENCE_FUNDS.length)
      return false;
    return data.funds.every((f) => {
      const original = REFERENCE_FUNDS.find((old) => old.slug === f.slug);
      const days =
        (Date.parse(data.through!) - Date.parse(HISTORY_THROUGH)) / DAY;
      const completeHistory =
        !!original &&
        Array.isArray(f.nav) &&
        f.nav.length === (original.nav?.length ?? 0) + days &&
        f.nav.every((point, i) =>
          i < (original.nav?.length ?? 0)
            ? point.t === original.nav![i].t
            : point.t - f.nav![i - 1].t === DAY,
        );
      return (
        !!original &&
        completeHistory &&
        (original.sourceModel
          ? !!f.sourceModel &&
            (original.sourceModel.updates ?? []).every((old) =>
              (f.sourceModel!.updates ?? []).some(
                (update) =>
                  update.id === old.id &&
                  update.date === old.date &&
                  old.trades.every((trade) =>
                    update.trades.some((next) => next.id === trade.id),
                  ),
              ),
            )
          : !f.sourceModel) &&
        original.name === f.name &&
        original.asset === f.asset &&
        Array.isArray(f.nav) &&
        f.nav.length >= 2 &&
        f.nav[0].t === original.nav?.[0]?.t &&
        Number.isFinite(f.sharePrice) &&
        f.sharePrice > 0 &&
        Math.abs(f.sharePrice - f.nav.at(-1)!.v) <
          1e-12 * Math.max(1, f.sharePrice) &&
        ["returns", "maxDrawdown"].every((key) => {
          const values = f[key as "returns" | "maxDrawdown"];
          return (
            values &&
            ["7D", "30D", "90D", "ALL"].every(
              (p) => values[p] === null || Number.isFinite(values[p]),
            )
          );
        }) &&
        (["7D", "30D", "90D", "ALL"] as const).every((period) => {
          const stats = analyzeFundPerformance(periodSeries(f, period), null);
          return (
            stats.returnPct !== null &&
            f.returns[period] !== null &&
            stats.maxDrawdown !== null &&
            f.maxDrawdown[period] !== null &&
            Math.abs(stats.returnPct - f.returns[period]!) < 1e-8 &&
            Math.abs(stats.maxDrawdown - f.maxDrawdown[period]!) < 1e-8
          );
        }) &&
        f.nav.every(
          (p, i) =>
            Number.isFinite(p.t) &&
            Math.abs(p.t) < 8.64e15 &&
            Number.isFinite(p.v) &&
            p.v > 0 &&
            (!i || p.t > f.nav![i - 1].t),
        ) &&
        new Date(f.nav.at(-1)!.t).toISOString().slice(0, 10) === data.through &&
        Array.isArray(f.positions) &&
        f.positions.every(
          (p) =>
            typeof p.p === "string" &&
            typeof p.loc === "string" &&
            Number.isFinite(p.w) &&
            p.w >= 0 &&
            p.w <= 100 + 1e-8,
        ) &&
        f.backtest?.through === data.through &&
        Array.isArray(f.backtest.targets) &&
        f.backtest.targets.every(
          (t) =>
            typeof t.id === "string" &&
            typeof t.symbol === "string" &&
            Number.isFinite(t.weight),
        ) &&
        (!f.sourceModel ||
          (f.backtest.rebalance === "source" &&
            f.sourceModel.historyBasis === "source-events@2" &&
            typeof f.sourceModel.scope === "string" &&
            typeof f.sourceModel.description === "string" &&
            Array.isArray(f.sourceModel.notes) &&
            f.sourceModel.notes.every((n) => typeof n === "string") &&
            typeof f.sourceModel.source === "string" &&
            f.sourceModel.source.startsWith("https://") &&
            f.sourceModel.backtested &&
            Array.isArray(f.sourceModel.updates) &&
            f.sourceModel.updates.every(
              (u) =>
                isDate(u.date) &&
                typeof u.summary === "string" &&
                Array.isArray(u.assets) &&
                u.assets.every((a) => typeof a === "string") &&
                Array.isArray(u.positions) &&
                u.positions.every(
                  (p) =>
                    typeof p.asset === "string" &&
                    Number.isFinite(p.beforePct) &&
                    Number.isFinite(p.afterPct),
                ) &&
                Array.isArray(u.trades) &&
                u.trades.every(
                  (t) =>
                    typeof t.asset === "string" &&
                    isDate(t.date) &&
                    ["buy", "sell"].includes(t.side) &&
                    typeof t.id === "string" &&
                    (t.navSharePct === null || Number.isFinite(t.navSharePct)),
                ),
            )))
      );
    });
  } catch {
    return false;
  }
}
export async function refreshReferenceData(
  now = Date.now(),
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const through = new Date(Math.floor(now / DAY) * DAY - DAY)
    .toISOString()
    .slice(0, 10);
  if (through <= HISTORY_THROUGH || now < retryAfter) return false;
  if (pending) return pending;
  pending = (async () => {
    try {
      const response = await fetcher("/reference-data/demo-funds", {
        credentials: "omit",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error("Reference unavailable");
      const value: unknown = await response.json();
      if (!validReferenceUpdate(value, through))
        throw new Error("Invalid historical reference");
      const prepared = value.funds.map((fund) => ({
        fund,
        updates:
          fund.sourceModel?.updates ??
          modelTradeUpdates(
            recentModelTrades(fund),
            fund.backtest.rebalance,
            fund.backtest.allocationUpdates,
          ),
        holdings: referenceHoldings(fund.positions || []),
      }));
      for (const item of prepared) {
        const fund = item.fund,
          target = REFERENCE_FUNDS.find((f) => f.slug === fund.slug)!;
        for (const key of [
          "nav",
          "positions",
          "returns",
          "maxDrawdown",
          "sharePrice",
          "tvl",
          "runtimeDays",
          "backtest",
          "sourceModel",
        ] as const)
          Object.defineProperty(target, key, {
            value: fund[key],
            writable: true,
            enumerable: true,
            configurable: true,
          });
        Object.assign(REFERENCE_METADATA[fund.slug], {
          updates: item.updates,
          holdings: item.holdings,
        });
      }
      updateReferenceMeta(value.through, value.riskFree ?? null);
      revision++;
      listeners.forEach((listener) => listener());
      return true;
    } catch {
      retryAfter = now + 3600000;
      return false;
    } finally {
      pending = null;
    }
  })();
  return pending;
}
