import { useId, useState } from "react";
import { AppIcon } from "../../components/AppIcon";
import { useMobile } from "../../lib/use-mobile";
import { useSearchParams } from "react-router-dom";
import {
  periodSeries,
  periodMetrics,
  analyzeFundPerformance,
} from "../../reference/lib/fund-explore";
import type { Period } from "../../reference/lib/fund-explore";
import { RISK_FREE, pct, date } from "../../lib/public-funds";
import type { ReferenceFund } from "../../lib/public-funds";
import { ReferenceSheet } from "./ReferenceSheet";
export const PERIODS: Period[] = ["7D", "30D", "90D", "1Y", "ALL"];
function PeriodPicker({
  period,
  onChange,
}: {
  period: Period;
  onChange: (p: Period) => void;
}) {
  return (
    <div
      className="seg public-periods"
      role="group"
      aria-label="Performance period"
    >
      {PERIODS.map((p) => (
        <button
          key={p}
          className={p === period ? "on" : ""}
          aria-pressed={p === period}
          onClick={() => onChange(p)}
        >
          {p === "ALL" ? "All" : p}
        </button>
      ))}
    </div>
  );
}
export function Performance({
  fund,
  period,
  onChange,
}: {
  fund: ReferenceFund;
  period: Period;
  onChange: (p: Period) => void;
}) {
  const fillId = useId();
  const mobile = useMobile();
  const [params, setParams] = useSearchParams(),
    open = params.get("performance") === "1";
  const setOpen = (value: boolean) => {
    const next = new URLSearchParams(params);
    if (value) next.set("performance", "1");
    else next.delete("performance");
    setParams(next, { replace: true });
  };
  const [hover, setHover] = useState<number | null>(null),
    points = periodSeries(fund, period),
    metrics = periodMetrics(fund, period),
    stats = analyzeFundPerformance(points, RISK_FREE),
    first = points[0],
    last = points.at(-1);
  const values = points.map((p) => (p.v / (first?.v || 1) - 1) * 100),
    lo = Math.min(0, ...values),
    hi = Math.max(0, ...values),
    pad = Math.max((hi - lo) * 0.12, 0.02),
    min = lo - pad,
    max = hi + pad;
  const x = (index: number) => (index / Math.max(1, points.length - 1)) * 842,
    y = (value: number) => 8 + ((max - value) / (max - min)) * 240;
  const axisValues = [max, (max + min) / 2, min];
  const graph =
    points.length > 1
      ? {
          path: values
            .map(
              (v, i) => `${i ? "L" : "M"}${x(i).toFixed(2)},${y(v).toFixed(2)}`,
            )
            .join(" "),
        }
      : null;
  const positive = (metrics.returnPct ?? 0) >= 0,
    basis =
      fund.sourceModel?.historyKind === "post-replay"
        ? "Public-post replay"
        : fund.sourceModel
          ? "Holdings reconstruction"
          : "Simulated";
  const range =
    first && last
      ? `${date(first.t)} – ${date(last.t)}`
      : "Historical observations unavailable";
  const metric = (name: string, value: string, detail: string) => (
    <div key={name}>
      <dt>
        {name}
        <span>{detail}</span>
      </dt>
      <dd>{value}</dd>
    </div>
  );
  const chartPeriods = (
    <PeriodPicker
      period={period}
      onChange={(next) => {
        setHover(null);
        onChange(next);
      }}
    />
  );
  return (
    <>
      <div className="app-performance-card">
      <section className="vault-performance">
        <div className="performance-head">
          <p className={`performance-return ${positive ? "pos" : "neg"}`}>
            {pct(metrics.returnPct)}
          </p>
          <div className="performance-meta">
            <p className="performance-dates">{range}</p>
            <p className="performance-description">Model return</p>
          </div>
        </div>
        {mobile && chartPeriods}
        <div
          className={`chart public-chart ${positive ? "pos" : "neg"}`}
          tabIndex={0}
          role="group"
          aria-label="Share price history. Use arrow keys to explore."
          onPointerMove={(e) => {
            const rect = e.currentTarget
              .querySelector("svg")
              ?.getBoundingClientRect();
            if (!rect?.width) return;
            setHover(
              Math.round(
                Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) *
                  (points.length - 1),
              ),
            );
          }}
          onPointerLeave={() => setHover(null)}
          onBlur={() => setHover(null)}
          onKeyDown={(e) => {
            if (
              ["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(
                e.key,
              )
            ) {
              e.preventDefault();
              setHover(
                e.key === "Escape"
                  ? null
                  : e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? points.length - 1
                      : Math.max(
                          0,
                          Math.min(
                            points.length - 1,
                            (hover ?? points.length - 1) +
                              (e.key === "ArrowLeft" ? -1 : 1),
                          ),
                        ),
              );
            }
          }}
        >
          {graph ? (
            <>
              <svg
                viewBox="0 0 842 256"
                preserveAspectRatio="none"
                role="img"
                aria-label={`${fund.name} cumulative return, ${range}`}
              >
                <defs>
                  <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0"
                      stopColor="currentColor"
                      stopOpacity=".14"
                    />
                    <stop offset="1" stopColor="currentColor" stopOpacity="0" />
                  </linearGradient>
                </defs>
                {axisValues.map((value) => (
                  <line
                    key={value}
                    className="public-chart-grid"
                    x1="0"
                    x2="842"
                    y1={y(value)}
                    y2={y(value)}
                    stroke="var(--hair)"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                <path
                  d={`${graph.path} L842,248 L0,248 Z`}
                  fill={`url(#${fillId})`}
                />
                <path
                  d={graph.path}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              <div className="public-chart-axis" aria-hidden="true">
                {axisValues.map((value) => (
                  <span
                    key={value}
                    style={{ top: `${(y(value) / 256) * 100}%` }}
                  >
                    {value.toFixed(1)}%
                  </span>
                ))}
              </div>
            </>
          ) : (
            <div className="vault-chart-empty">
              Insufficient history for this period.
            </div>
          )}
          {hover !== null && points[hover] && first && (
            <span className="public-chart-readout" role="status">
              {date(points[hover].t)} ·{" "}
              {pct((points[hover].v / first.v - 1) * 100)} ·{" "}
              {points[hover].v.toFixed(4)} USDT
            </span>
          )}
        </div>
        {!mobile && chartPeriods}
      </section>
      <dl id="keyfig" className="keyfig dk-kpis public-kpis">
        <div>
          <dt>Max drawdown</dt>
          <dd>{pct(metrics.maxDrawdown)}</dd>
        </div>
        <div>
          <dt>Share price</dt>
          <dd>
            {fund.sharePrice.toFixed(4)}
            <small> USDT</small>
          </dd>
        </div>
      </dl>
      <button
        className="performance-details-open"
        onClick={() => setOpen(true)}
      >
        Performance details <AppIcon name="right" size={15} />
      </button>
      </div>
      <ReferenceSheet
        open={open}
        onOpenChange={setOpen}
        title="Performance details"
      >
        <p>{range}</p>
        <PeriodPicker period={period} onChange={onChange} />
        <dl className="performance-detail-metrics">
          {metric("Return", pct(metrics.returnPct), "Change over this period")}
          {metric(
            "Max drawdown",
            pct(metrics.maxDrawdown),
            "Largest peak-to-trough decline",
          )}
          {metric(
            "Sharpe ratio",
            stats.sharpe == null ? "—" : stats.sharpe.toFixed(2),
            stats.riskNote ||
              stats.sharpeNote ||
              "Return per unit of risk · annualized",
          )}
          {metric(
            "Volatility",
            stats.volatility == null ? "—" : stats.volatility.toFixed(2) + "%",
            stats.riskNote || "Daily return variability · annualized",
          )}
        </dl>
        <p className="fine">
          {stats.observations} daily returns · {basis} · Before fees
        </p>
        <details className="vault-details">
          <summary>How these are calculated</summary>
          <div className="performance-methodology">
            <p>
              Return and maximum drawdown use the selected period. Drawdown is
              the largest peak-to-trough decline.
            </p>
            <p>
              Volatility is the sample standard deviation of daily returns ×
              √365. Sharpe is mean daily excess return divided by its sample
              standard deviation × √365. Both require at least 90 consecutive
              daily returns.
            </p>
            <p>
              Sharpe uses the previous NAV day’s latest{" "}
              <a
                href="https://fred.stlouisfed.org/series/DGS3MO"
                target="_blank"
                rel="noopener noreferrer"
              >
                U.S. 3-month Treasury yield (FRED)
              </a>
              , converted as (1 + yield)^(1/365) − 1. Rates carry forward up to
              seven days. Missing reference data leaves Sharpe unavailable.
            </p>
            <p>
              All series use calendar days, including unchanged prices on market
              closures. Annualized estimates can be unstable over short
              histories or correlated returns.
            </p>
            <p>{fund.backtest.basis}</p>
            {fund.sourceModel && <p>{fund.sourceModel.scope}</p>}
          </div>
        </details>
      </ReferenceSheet>
    </>
  );
}
