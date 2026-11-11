import { useState } from "react";
import { AppIcon } from "../../components/AppIcon";
import { Link, useSearchParams } from "react-router-dom";
import {
  modelPositionGroups,
  positionWeightLabels,
  recentUpdateSources,
  tradeUpdateDate,
} from "../../reference/lib/recent-trades";
import type { ModelTradeUpdate } from "../../reference/lib/recent-trades";
import {
  REFERENCE_METADATA,
  assetBySymbol,
  date,
} from "../../lib/public-funds";
import type { ReferenceFund } from "../../lib/public-funds";
import { ReferenceSheet } from "./ReferenceSheet";
import { FUND_DISCLOSURES } from "./fund-disclosures";
import { collectionOf } from "../../reference/lib/fund-explore";
export function RecentTrades({ fund }: { fund: ReferenceFund }) {
  const [params, setParams] = useSearchParams();
  const isTheme = collectionOf(fund) === "themes";
  const isReplay = fund.sourceModel?.historyKind === "post-replay";
  // 社群策略（`community-N`）沒有參考目錄的 updates；直接存取 undefined 會讓整頁崩掉
  // （實測：`/funds/strategy/2` 白屏，錯誤是 `Cannot read properties of undefined`）。
  const updates = (REFERENCE_METADATA[fund.slug]?.updates ?? [])
    .filter(
      (update) =>
        isTheme ||
        (fund.sourceModel &&
          recentUpdateSources(update, fund.group).length > 0),
    )
    .sort((a, b) => b.date.localeCompare(a.date));
  const selected = updates.find((update) => update.id === params.get("update"));
  const open = params.get("trades") === "1" || !!selected;
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState("all");
  const setOpen = (value: boolean) => {
    const next = new URLSearchParams(params);
    if (value) next.set("trades", "1");
    else {
      next.delete("trades");
      next.delete("update");
    }
    setParams(next, { replace: true });
  };
  const setSelected = (value: ModelTradeUpdate | null) => {
    const next = new URLSearchParams(params);
    next.set("trades", "1");
    if (value) next.set("update", value.id);
    else next.delete("update");
    setFilter("all");
    setParams(next, { replace: true });
  };
  const sources = (update: ModelTradeUpdate) =>
    isTheme ? [] : recentUpdateSources(update, fund.group);
  const sourceLinks = (update: ModelTradeUpdate) => {
    const links = sources(update);
    if (!links.length) return null;
    return (
      <span className="trade-source-links">
        {links.map((s, index) => (
          <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer">
            {s.label}
            {links.length > 1 ? ` ${index + 1}` : ""} ↗
          </a>
        ))}
      </span>
    );
  };
  const displaySymbol = (symbol: string) =>
    symbol.toLowerCase() === "cash" ? "USDT" : symbol;
  const icons = (symbols: string[]) =>
    symbols.slice(0, 3).map((symbol) => {
      const asset = assetBySymbol(displaySymbol(symbol));
      return asset?.logo ? (
        <img src={asset.logo} alt={asset.symbol} key={symbol} />
      ) : (
        <span key={symbol}>{displaySymbol(symbol)}</span>
      );
    });
  const timeline = (items: ModelTradeUpdate[]) => (
    <ol className="trade-update-timeline">
      {items.map((u, i) => (
        <li key={u.id} className={i === 0 ? "latest" : ""}>
          <button
            type="button"
            className="trade-update-link"
            onClick={() => {
              setSelected(u);
            }}
          >
            <time>{tradeUpdateDate(u.date).label}</time>
            <p>{u.summary}</p>
            <span className="trade-update-assets">
              {icons(u.assets)}
              {u.assets.length > 3 && (
                <small>+{u.assets.length - 3} more</small>
              )}
            </span>
            <span className="trade-update-chevron" aria-hidden="true">
              ›
            </span>
          </button>
          {sourceLinks(u)}
        </li>
      ))}
    </ol>
  );
  if (!updates.length) {
    if (isTheme) return null;
    const disclosures = FUND_DISCLOSURES[fund.slug] ?? [];
    return (
      <section className="recent-trades">
        <h2>
          {disclosures.length
            ? "Public disclosures"
            : "Recent holdings changes"}
        </h2>
        <p className="recent-trades-note">
          {disclosures.length
            ? "Official filings provide context for this reference fund. Its allocations and performance follow the CRE8 model."
            : "No verified holdings history is available for this fund."}
        </p>
        {disclosures.length > 0 && (
          <ul className="fund-disclosures">
            {disclosures.map((disclosure) => (
              <li key={disclosure.url}>
                <time dateTime={disclosure.date}>{date(disclosure.date)}</time>
                <h3>
                  <a
                    href={disclosure.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {disclosure.title} ↗
                  </a>
                </h3>
                <p>{disclosure.detail}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }
  const heading = isTheme
    ? "Recent trades"
    : isReplay
      ? "Recent trades"
      : "Recent holdings changes";
  const groups = selected ? modelPositionGroups(selected.positions) : null;
  const renderGroup = (key: keyof NonNullable<typeof groups>, title: string) =>
    !groups?.[key].length ? null : (
      <section className="trade-position-group" key={key}>
        <h3>{title}</h3>
        {groups[key].map((p) => {
          const symbol = displaySymbol(p.asset);
          const asset = assetBySymbol(symbol);
          const labels = positionWeightLabels(p.beforePct, p.afterPct);
          const identity = (
            <>
              {asset?.logo && <img src={asset.logo} alt="" />}
              <strong>{asset?.symbol || symbol}</strong>
            </>
          );
          return (
            <div className="trade-position-row" key={p.asset}>
              {asset ? (
                <Link
                  to={`/asset/${asset.slug}?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`}
                >
                  {identity}
                </Link>
              ) : (
                <span className="trade-position-identity">{identity}</span>
              )}
              <span>
                {key === "unchanged" ? (
                  labels.after
                ) : (
                  <>
                    <small>{labels.before} → </small>
                    {labels.after}
                  </>
                )}
              </span>
            </div>
          );
        })}
      </section>
    );
  return (
    <section className="recent-trades">
      <header className="recent-trades-heading">
        <h2>{heading}</h2>
      </header>
      <p className="recent-trades-note">
        {fund.sourceModel?.historyKind === "post-replay"
          ? "Public-post model updates. Source links included."
          : fund.sourceModel
            ? "Changes between reported holdings. Filing dates and sources included."
            : "Allocation updates from the historical model."}
      </p>
      {timeline(updates.slice(0, 2))}
      <button
        className="trade-updates-more"
        onClick={() => {
          setPage(0);
          setSelected(null);
        }}
      >
        See more <AppIcon name="right" size={16} />
      </button>
      <p className="recent-trades-asof">Through {fund.backtest.through}</p>
      <ReferenceSheet
        open={open}
        onOpenChange={setOpen}
        title={
          heading === "Recent holdings changes"
            ? selected
              ? "Holdings change"
              : "Holdings changes"
            : selected
              ? "Trade update"
              : "Trade updates"
        }
      >
        {selected ? (
          <>
            <button
              className="trade-updates-back"
              onClick={() => setSelected(null)}
            >
              <AppIcon name="left" size={16} /> All updates
            </button>
            <time className="trade-detail-date">{date(selected.date)}</time>
            <p className="trade-detail-summary">{selected.summary}</p>
            {selected.asOf && (
              <p className="fine">
                Holdings as of {selected.asOf}
                {selected.published ? ` · Published ${selected.published}` : ""}
              </p>
            )}
            {selected.postedAt && (
              <p className="fine">Source posted {selected.postedAt}</p>
            )}
            {sourceLinks(selected)}
            <p className="recent-trades-note">
              Portfolio weights immediately before → after this update.{" "}
              {fund.sourceModel
                ? "Source holdings changes or model signals; not verified executions."
                : ""}
            </p>
            {renderGroup("new", "New positions")}
            {renderGroup("closed", "Closed positions")}
            {renderGroup("increased", "Increased positions")}
            {renderGroup("decreased", "Decreased positions")}
            {groups?.unchanged.length ? (
              <details>
                <summary>
                  Unchanged positions ({groups.unchanged.length})
                </summary>
                {renderGroup("unchanged", "Unchanged positions")}
              </details>
            ) : null}
            {selected.trades.length > 0 && (
              <details className="trade-ledger">
                <summary>Transaction log</summary>
                <div className="trade-filter">
                  {["all", "buy", "sell"].map((f) => (
                    <button
                      key={f}
                      aria-pressed={filter === f}
                      onClick={() => setFilter(f)}
                    >
                      {f === "all" ? "All" : f === "buy" ? "Buys" : "Sells"}
                    </button>
                  ))}
                </div>
                {selected.trades
                  .filter((t) => filter === "all" || t.side === filter)
                  .map((t) => (
                    <p key={t.id}>
                      {t.side === "buy" ? "Buy" : "Sell"} ·{" "}
                      {displaySymbol(t.asset)} ·{" "}
                      {t.navSharePct?.toFixed(2) ?? "—"}% of model NAV
                    </p>
                  ))}
              </details>
            )}
          </>
        ) : (
          <>
            {timeline(updates.slice(page * 12, page * 12 + 12))}
            {updates.length > 12 && (
              <nav className="trade-pagination" aria-label="Trade update pages">
                <button
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  ← Previous
                </button>
                <span>
                  {page + 1} / {Math.ceil(updates.length / 12)}
                </span>
                <button
                  disabled={(page + 1) * 12 >= updates.length}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next →
                </button>
              </nav>
            )}
          </>
        )}
      </ReferenceSheet>
    </section>
  );
}
