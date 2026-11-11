import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  chartGeometry,
  periodMetrics,
  periodSeries,
  currentFundAssets,
} from "../../reference/lib/fund-explore";
import type { Period } from "../../reference/lib/fund-explore";
import { assetBySymbol, pct } from "../../lib/public-funds";
import type { ReferenceFund } from "../../lib/public-funds";
import { FundSource, FundPortrait, FundName } from "./Profile";
export function FundRow({
  fund,
  period,
  returnTo,
  showSource = true,
  href,
  meta,
}: {
  fund: ReferenceFund;
  period: Period;
  returnTo: string;
  showSource?: boolean;
  /** 取代 `FundSource` 的說明行（社群策略沒有 X handle，但要顯示 owner 與鏈上 id）。 */
  meta?: ReactNode;
  /**
   * 覆寫列的目標網址。
   *
   * 為什麼需要：社群策略（`/vaults` 的 Community 區塊）不是參考目錄裡的基金，
   * 沒有 `/funds/:slug` 這條路由 —— 它們的細節頁是 `/strategies/:id`。
   * 沒有這個參數就只能複製一份 `.fund-row` 的 markup，那會讓兩邊的樣式遲早不同步。
   */
  href?: string;
}) {
  const metrics = periodMetrics(fund, period),
    assets = currentFundAssets(fund);
  const trend = chartGeometry(periodSeries(fund, period), 72, 32);
  const tone = metrics.returnPct === null ? "" : metrics.returnPct >= 0 ? "pos" : "neg";
  const url = href ?? `/funds/${fund.slug}?period=${period}&returnTo=${encodeURIComponent(returnTo)}`;
  return (
    <article className="fund-row" data-slug={fund.slug}>
      <div className="fund-row-link">
        <FundPortrait fund={fund} url={url} />
        <div className="fund-list-body">
          <h3>
            <FundName fund={fund} url={url} />
          </h3>
          {meta !== undefined ? (
            <span className="fund-row-creator">{meta}</span>
          ) : (
            showSource && <FundSource fund={fund} />
          )}
        </div>
        {trend && (
          <svg className={`fund-list-trend ${tone}`} viewBox="0 0 72 32" aria-hidden="true">
            <path d={trend.path} fill="none" stroke="currentColor" strokeWidth="1.5"
              strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </svg>
        )}
        <span className="fund-list-result">
          <strong className={tone}>
            {pct(metrics.returnPct)}
          </strong>
        </span>
        <span
          className="fund-asset-icons"
          aria-label={assets.map((a) => a.symbol).join(", ")}
        >
          {assets.slice(0, 3).map(({ symbol, logo }) => {
            const asset = assetBySymbol(symbol);
            const image = asset?.logo || (logo ? `/logos/${logo}` : null);
            return (
              <Link
                key={symbol}
                to={
                  asset
                    ? `/asset/${asset.slug}?returnTo=${encodeURIComponent(returnTo)}`
                    : url
                }
                title={asset?.name || symbol}
              >
                {image ? (
                  <img src={image} alt={symbol} />
                ) : (
                  <span>{symbol}</span>
                )}
              </Link>
            );
          })}
          {assets.length > 3 && (
            <span className="fund-assets-more">+{assets.length - 3}</span>
          )}
        </span>
      </div>
    </article>
  );
}
