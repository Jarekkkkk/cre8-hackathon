import { useSearchParams } from "react-router-dom";
import { AppIcon } from "../../components/AppIcon";
import { useEffect, useId, useRef, useState } from "react";
import { attachAssetPreviews } from "../../reference/lib/asset-preview";
import type { HoldingSort } from "../../reference/lib/fund-holdings";
import { REFERENCE_METADATA, compact, pct } from "../../lib/public-funds";
import type { ReferenceFund } from "../../lib/public-funds";
import { ReferenceSheet } from "./ReferenceSheet";
export function Assets({ fund }: { fund: ReferenceFund }) {
  const [params] = useSearchParams();
  const root = useRef<HTMLDivElement>(null),
    card = useRef<HTMLDivElement>(null),
    id = useId(),
    [sort, setSort] = useState<HoldingSort>("weight"),
    [asc, setAsc] = useState(false),
    [tokens, setTokens] = useState(params.get("tokens") === "1"),
    // 同上：社群策略沒有 holdings metadata，用空陣列退回 fund.positions / backtest.targets。
    rows = REFERENCE_METADATA[fund.slug]?.holdings ?? [];
  useEffect(() => {
    if (!root.current || !card.current) return;
    const binding = attachAssetPreviews(
      root.current,
      card.current,
      (key) => {
        const row = rows.find((r) => r.id === key);
        return row?.preview
          ? {
              asset: row.preview,
              url: `/asset/${row.preview.slug}/?returnTo=${encodeURIComponent(location.pathname + location.search)}`,
            }
          : null;
      },
      "/logos/",
    );
    return () => binding.abort();
  }, [rows]);
  const sorted = [...rows].sort((a, b) => {
    const av = sort === "asset" ? a.preview?.name || a.asset : a[sort],
      bv = sort === "asset" ? b.preview?.name || b.asset : b[sort];
    if (av == null && bv == null) return a.asset.localeCompare(b.asset);
    if (av == null || bv == null) return av == null ? 1 : -1;
    return (
      (typeof av === "string" && typeof bv === "string"
        ? av.localeCompare(bv)
        : Number(av) - Number(bv)) * (asc ? 1 : -1)
    );
  });
  const header = (key: HoldingSort, label: string, shortLabel?: string) => (
    <th
      key={key}
      aria-sort={sort === key ? (asc ? "ascending" : "descending") : "none"}
    >
      <button
        aria-label={label}
        className={sort === key && asc ? "holding-sort-ascending" : undefined}
        onClick={() => {
          if (sort === key) setAsc(!asc);
          else {
            setSort(key);
            setAsc(key === "asset");
          }
        }}
      >
        {shortLabel ? (
          <>
            <span className="holding-label-full">{label}</span>
            <span className="holding-label-short" aria-hidden="true">
              {shortLabel}
            </span>
          </>
        ) : (
          label
        )}{" "}
        <AppIcon name={sort === key ? "down" : "sort"} size={12} />
      </button>
    </th>
  );
  return (
    <section className="vault-allocation dk-sec" ref={root}>
      <header className="holdings-heading">
        <h2>Assets</h2>
        <button className="btn ghost sm" onClick={() => setTokens(true)}>
          <AppIcon name="document" size={17} /> Token details
        </button>
      </header>
      <div className="dk-wrap">
        <table className="dk-table vault-where holdings-table">
          <thead>
            <tr>
              {header("asset", "Assets")}
              {header("weight", "Weight")}
              {header("size", "Market cap / AUM", "Cap / AUM")}
              {header("change24h", "24H")}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={row.id}>
                <td>
                  <button
                    className="holding-identity holding-asset-trigger"
                    data-asset-preview={row.id}
                    aria-haspopup="dialog"
                    aria-controls={id}
                    aria-label={`View ${row.preview?.name || row.asset} asset info`}
                  >
                    {row.preview?.logo && (
                      <img
                        src={row.preview.logo}
                        alt=""
                        width="32"
                        height="32"
                      />
                    )}
                    <span className="holding-asset-label">
                      <strong>{row.preview?.name || row.asset}</strong>
                      {row.preview?.name !== row.asset && (
                        <small>{row.asset}</small>
                      )}
                    </span>
                  </button>
                </td>
                <td>
                  {row.weight == null
                    ? "—"
                    : row.weight.toFixed(row.weight < 0.1 ? 2 : 1) + "%"}
                </td>
                <td title={row.quote?.sizeAsOf || row.quote?.asOf || ""}>
                  {row.asset === "USDT" ? "" : compact(row.size)}
                </td>
                <td className={(row.change24h ?? 0) >= 0 ? "pos" : "neg"}>
                  {row.asset === "USDT" ? "" : pct(row.change24h)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div
        ref={card}
        id={id}
        className="asset-preview-card"
        popover="manual"
        role="dialog"
        aria-label="Underlying asset preview"
      />
      <ReferenceSheet
        open={tokens}
        onOpenChange={setTokens}
        title="Token details"
      >
        <p className="fine">
          On-chain instruments are separate from the underlying assets. Issuer
          terms, rights and availability can differ.
        </p>
        {rows.map((row) => (
          <section key={row.id} className="public-token-row">
            <h3>{row.preview?.name || row.asset}</h3>
            <p>
              {row.identity?.issuer || "Instrument identity unavailable"} ·{" "}
              {row.symbol}
            </p>
            {row.identity && (
              <a
                href={`https://bscscan.com/token/${row.identity.address}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {row.identity.address} ↗
              </a>
            )}
          </section>
        ))}
      </ReferenceSheet>
    </section>
  );
}
