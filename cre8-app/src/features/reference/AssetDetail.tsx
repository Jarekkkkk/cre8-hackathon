"use client";
import Image from "../../reference/components/Image";
import { useState, useSyncExternalStore } from "react";
import type { UnderlyingAsset } from "../../reference/lib/underlying-assets";
import { assetReturnUrl } from "../../reference/lib/asset-navigation";
import { chartGeometry } from "../../reference/lib/fund-explore";
import styles from "../../reference/components/asset-detail.module.css";

const base = "",
  app = "";
const noSubscribe = () => () => {};
const money = (n: number) =>
  n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: n < 1 ? 6 : 2,
  });
const size = (n: number) =>
  "$" +
  (n >= 1e12
    ? (n / 1e12).toFixed(2) + "T"
    : n >= 1e9
      ? (n / 1e9).toFixed(2) + "B"
      : n >= 1e6
        ? (n / 1e6).toFixed(2) + "M"
        : n.toLocaleString("en-US"));
const date = (t: number) =>
  new Date(t).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
const kindName = (kind: string) =>
  ({
    equity: "Stock",
    etf: "ETF",
    fund: "Closed-end fund",
    crypto: "Crypto",
    stablecoin: "Stablecoin",
    commodity: "Commodity",
  })[kind] ?? "Asset";

export function AssetDetail({
  asset: a,
  showModelFunds = true,
}: {
  asset: UnderlyingAsset;
  showModelFunds?: boolean;
}) {
  const [period, setPeriod] = useState("1Y"),
    [hover, setHover] = useState<number | null>(null),
    [copied, setCopied] = useState("");
  const href = useSyncExternalStore(
    noSubscribe,
    () => window.location.href,
    () => "",
  );
  const fallback = `${app}/vaults/`,
    back = href ? assetReturnUrl(href, fallback) : fallback;
  const backLabel = /\/create\//.test(back)
    ? "Back to your fund"
    : /\/(?:vault|funds)\//.test(back)
      ? "Back to fund"
      : "All funds";
  const last = a.history.at(-1),
    days =
      period === "1M"
        ? 30
        : period === "3M"
          ? 90
          : period === "1Y"
            ? 365
            : Infinity;
  const points = last
    ? a.history.filter((p) => p.t >= last.t - days * 86400000)
    : [];
  const graph = chartGeometry(points, 900, 260),
    current = hover === null ? last : points[hover],
    first = points[0];
  const change = last && first ? (last.v / first.v - 1) * 100 : null;
  const rangeLabel =
    period === "ALL"
      ? "All time"
      : period === "1Y" && last && first && last.t - first.t < 365 * 86400000
        ? "Available history"
        : period;
  return (
    <main className={styles.page}>
      <a className={styles.back} href={back}>
        ← {backLabel}
      </a>
      <div className={styles.layout}>
        <div className={styles.main}>
          <header className={styles.identity}>
            {a.logo ? (
              <Image
                src={base + a.logo}
                alt=""
                width={64}
                height={64}
                unoptimized
              />
            ) : (
              <span className={styles.blankLogo}>{a.symbol.slice(0, 1)}</span>
            )}
            <div>
              <p className={styles.ticker}>
                {a.symbol}{" "}
                <span>· {a.symbol === "USDT" ? "Cash" : kindName(a.kind)}</span>
              </p>
              <h1>{a.name}</h1>
            </div>
          </header>
          <section className={styles.about} aria-labelledby="asset-about">
            <h2 id="asset-about">About</h2>
            {a.description ? (
              <>
                <p>
                  {a.descriptionIsExcerpt
                    ? "“" + a.description.replace(/\s*…$/, "") + "…”"
                    : a.description}
                </p>
                <p className={styles.source}>
                  <a
                    href={a.sourceUrl!}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {a.descriptionIsExcerpt
                      ? "Company profile excerpt · Nasdaq"
                      : "Read more at the source"}{" "}
                    ↗
                  </a>
                  {a.descriptionAsOf &&
                    ` · Retrieved ${a.descriptionAsOf.slice(0, 10)}`}
                </p>
              </>
            ) : (
              <>
                <p>
                  {a.name} is the underlying{" "}
                  {a.kind === "etf" ? "exchange-traded fund" : "security"}{" "}
                  identified by ticker {a.symbol}. Its provider’s instrument
                  details are linked below.
                </p>
                <p className={styles.source}>
                  A verified business description is not available yet.
                </p>
              </>
            )}
            <div className={styles.tags}>
              {[a.sector, a.industry].filter(Boolean).map((t) => (
                <span key={t}>{t}</span>
              ))}
              {a.website && (
                <a href={a.website} target="_blank" rel="noopener noreferrer">
                  Website ↗
                </a>
              )}
            </div>
          </section>
          {a.symbol !== "USDT" && (
            <section
              className={styles.price}
              aria-label="Underlying price history"
            >
              <div className={styles.priceHeader}>
                <div>
                  <span className={styles.label}>{a.historyBasis}</span>
                  <strong>
                    {current ? money(current.v) : "Price history unavailable"}
                    <small>{current ? a.historyCurrency : ""}</small>
                  </strong>
                  <p>
                    {current
                      ? date(current.t)
                      : "Historical observations have not been captured for this asset."}
                  </p>
                </div>
                {change !== null && (
                  <span
                    className={change >= 0 ? styles.positive : styles.negative}
                  >
                    {change >= 0 ? "+" : ""}
                    {change.toFixed(2)}% <small>{rangeLabel}</small>
                  </span>
                )}
              </div>
              {graph && (
                <>
                  <div
                    className={styles.chart}
                    onPointerMove={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect(),
                        fraction = Math.max(
                          0,
                          Math.min(1, (event.clientX - rect.left) / rect.width),
                        );
                      const time =
                        points[0].t +
                        fraction * (points.at(-1)!.t - points[0].t);
                      let nearest = 0;
                      for (let i = 1; i < points.length; i++)
                        if (
                          Math.abs(points[i].t - time) <
                          Math.abs(points[nearest].t - time)
                        )
                          nearest = i;
                      setHover(nearest);
                    }}
                    onPointerLeave={() => setHover(null)}
                  >
                    <svg
                      viewBox="0 0 900 260"
                      role="img"
                      aria-label={`${a.symbol} historical ${a.historyCurrency} adjusted price from ${date(first.t)} to ${date(last!.t)}`}
                    >
                      <path
                        d={graph.path}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        vectorEffect="non-scaling-stroke"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                  <div className={styles.chartDates}>
                    <span>{date(first.t)}</span>
                    <span>{date(last!.t)}</span>
                  </div>
                  <div
                    className={`${styles.periods} public-periods`}
                    role="group"
                    aria-label="Price history period"
                  >
                    {["1M", "3M", "1Y", "ALL"].map((p) => (
                      <button
                        key={p}
                        type="button"
                        aria-pressed={period === p}
                        onClick={() => {
                          setPeriod(p);
                          setHover(null);
                        }}
                      >
                        {p === "ALL" ? "All" : p}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {a.historySource && (
                <p className={styles.source}>
                  <a
                    href={a.historySource}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Historical data source ↗
                  </a>{" "}
                  · Through {a.historyThrough}.{" "}
                  {a.kind === "equity" || a.kind === "etf"
                    ? "Distribution-adjusted prices; not an executable token quote."
                    : a.symbol === "GOLD"
                      ? "Gold is represented by an XAUt price proxy."
                      : "Daily exchange observations, not an executable quote."}
                </p>
              )}
            </section>
          )}
          {showModelFunds && (
            <section className={styles.funds} aria-labelledby="asset-funds">
              <h2 id="asset-funds">Funds with {a.symbol}</h2>
              <p className={styles.source}>
                Model target weights.
              </p>
              {a.funds.length ? (
                <div>
                  {a.funds.map((f) => (
                    <a
                      className={styles.fund}
                      href={`${app}/funds/${f.slug}/`}
                      key={f.slug}
                    >
                      <strong>{f.name}</strong>
                      <span>
                        {f.targetWeight.toFixed(1)}% target{" "}
                      </span>
                    </a>
                  ))}
                </div>
              ) : (
                <p className={styles.noFunds}>
                  No funds include this asset.
                </p>
              )}
            </section>
          )}
          <details className={styles.tokens}>
            <summary>
              Tokenized &amp; on-chain versions <span>{a.tokens.length}</span>
            </summary>
            <p className={styles.source}>
              These are separate instruments. Issuer terms, rights, pricing and
              availability can differ from the underlying asset.
            </p>
            {a.tokens.map((t) => (
              <div className={styles.token} key={t.chainId + t.address}>
                <header>
                  <strong>{t.issuer}</strong>
                  <span>{t.symbol}</span>
                </header>
                <dl>
                  <div>
                    <dt>Network</dt>
                    <dd>BNB Chain · {t.chainId}</dd>
                  </div>
                  <div>
                    <dt>Contract</dt>
                    <dd>
                      <a
                        href={`https://bscscan.com/token/${t.address}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {t.address} ↗
                      </a>
                      <button
                        type="button"
                        aria-label={`Copy ${t.symbol} contract`}
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(t.address);
                            setCopied(t.address);
                          } catch {
                            setCopied("unavailable");
                          }
                        }}
                      >
                        {copied === t.address ? "Copied" : "Copy"}
                      </button>
                    </dd>
                  </div>
                </dl>
                <a
                  className={styles.source}
                  href={t.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Instrument source ↗
                </a>
              </div>
            ))}
            {!a.tokens.length && (
              <p className={styles.source}>
                No reviewed on-chain instrument is mapped to this asset.
              </p>
            )}
            {copied === "unavailable" && (
              <p role="status">
                Couldn’t copy. Select the contract address to copy it.
              </p>
            )}
          </details>
        </div>
        <aside className={styles.side}>
          <section className={styles.facts}>
            <h2>At a glance</h2>
            <dl>
              <div>
                <dt>Asset type</dt>
                <dd>{a.symbol === "USDT" ? "Cash" : kindName(a.kind)}</dd>
              </div>
              {a.symbol !== "USDT" && (
                <div>
                  <dt>{a.sizeKind}</dt>
                  <dd>{a.size === null ? "Unavailable" : size(a.size)}</dd>
                </div>
              )}
            </dl>
            {a.sizeAsOf && (
              <p className={styles.source}>
                As of {a.sizeAsOf}
                {a.sizeSource && (
                  <>
                    {" "}
                    ·{" "}
                    <a
                      href={a.sizeSource}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Source ↗
                    </a>
                  </>
                )}
              </p>
            )}
            {a.sizeNote && <p className={styles.source}>{a.sizeNote}</p>}
          </section>
          {a.builderKey && (
            <section className={styles.create}>
              <h2>Make it part of your fund</h2>
              <a
                className="btn"
                href={`${app}/create/?asset=${encodeURIComponent(a.builderKey)}`}
              >
                Create with {a.symbol} →
              </a>
            </section>
          )}
        </aside>
      </div>
    </main>
  );
}
