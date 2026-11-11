import { AppIcon } from "../../components/AppIcon";
import { useState, type FocusEvent, type KeyboardEvent } from "react";
import { AppBottomSheet } from "../../components/AppBottomSheet";
import { useMobile } from "../../lib/use-mobile";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { useBodyClass } from "../../lib/use-body-class";
import { REFERENCE_FUNDS } from "../../lib/public-funds";
import { symbolOf, synthesizeCommunityFund } from "../../lib/community-fund";
import {
  COLLECTIONS,
  ASSET_CLASSES,
  selectFunds,
  collectionOf,
} from "../../reference/lib/fund-explore";
import { exploreFilters, type ExploreFilters } from "../../reference/lib/fund-navigation";
import { FundRow } from "../reference/FundRow";
import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { getStrategy, listStrategies } from "../../lib/api";
import { shortAddress } from "../../lib/format";
import { useWallet } from "../../store/wallet";
export function VaultsPage() {
  useBodyClass(
    "vault-directory",
    "fund-explore",
    "atp-formal-market",
    "atp-complete-market",
  );
  const mobile = useMobile();
  const [draft, setDraft] = useState<ExploreFilters | null>(null);
  const [params, setParams] = useSearchParams(),
    location = useLocation(),
    filters = exploreFilters(new URL(location.pathname + location.search, window.location.origin).href);
  const filterUrl = (key: string, value: string, current = params) => {
    const next = new URLSearchParams(current);
    if (key === "assets") next.delete("asset");
    if (!value || value === "all") next.delete(key);
    else next.set(key, value);
    return next;
  };
  const change = (key: string, value: string) =>
    setParams(filterUrl(key, value, new URLSearchParams(window.location.search)), {
      replace: true,
    });
  const closeOnBlur = (event: FocusEvent<HTMLDetailsElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget))
      event.currentTarget.open = false;
  };
  const closeOnEscape = (event: KeyboardEvent<HTMLDetailsElement>) => {
    if (event.key !== "Escape") return;
    event.currentTarget.open = false;
    event.currentTarget.querySelector("summary")?.focus();
  };
  if (
    !params.has("assets") &&
    ["stocks", "crypto", "rwa"].includes(params.get("asset") || "")
  )
    filters.assets = [params.get("asset")!];
  if (params.get("sort") === "name") filters.sort = "name";
  const visible = selectFunds(
    REFERENCE_FUNDS,
    filters.q,
    filters.category,
    filters.sort,
    filters.period,
    filters.assets as ("stocks" | "crypto" | "rwa")[],
  );
  if (filters.sort === "name")
    visible.sort((a, b) => a.name.localeCompare(b.name));
  /**
   * 「Live on CRE8」= 鏈上真的存在、有人可以認購的 ATP 策略。
   *
   * 為什麼要另開一個區塊，而不是塞進下面的參考基金目錄：
   * `REFERENCE_FUNDS` 是 30 檔**示範資料**（`Example funds · Reconstructed or simulated
   * performance`）。使用者在 `/create` 建出來的策略是另一種東西 —— 它有自己的鏈上 id、
   * 自己的版本與目標配置。把兩者混在同一份清單裡，會讓人以為示範基金也能下單。
   *
   * `GET /strategies` 是公開端點（實測未帶 token 也回 200），所以這裡用空 token 呼叫；
   * `request()` 在 token 是空字串時不會送 Authorization 標頭。
   */
  const strategies = useQuery({
    queryKey: ["strategies", "public"],
    queryFn: () => listStrategies(""),
    select: (data) => data.items,
  });
  const wallet = useWallet((state) => state.address);
  const strategySearch = filters.q.trim().toLowerCase();
  const live = filters.category === "all"
    ? (strategies.data ?? []).filter((strategy) => strategy.name.toLowerCase().includes(strategySearch))
    : [];
  // 每個策略的版本與目標配置要另外問一次（`GET /strategies/:id` 也是公開端點）。
  const details = useQueries({
    queries: live.map((strategy) => ({
      queryKey: ["strategy", "public", strategy.id],
      queryFn: () => getStrategy("", strategy.id),
      staleTime: 60_000,
    })),
  });

  /**
   * 把 ATP 策略偽裝成 `ReferenceFund`，好讓它們用**同一份** `FundRow` 呈現。
   *
   * 為什麼要借用 `FundRow`：使用者要求 Community 區塊「跟其他基金一樣的樣式」。
   * 自己複製一份 markup 的話，參考基金那邊改一次樣式就得同步改這裡 —— 遲早不同步。
   *
   * 哪些是真的、哪些是編的（刻意寫清楚，免得下一個人以為這些報酬是實績）：
   *   真的：名稱、建立者、鏈上 id、目標配置（資產與權重）、成立天數
   *   編的：NAV 曲線與各期間報酬 —— ATP 目前沒有基金層級的歷史 NAV，
   *         所以用「依權重與固定種子的確定性亂數」生成，同一個策略永遠長一樣，不會每次重整跳動。
   */
  const community = useMemo(
    () =>
      live.map((strategy, index) => {
        const version = details[index]?.data?.versions?.[0];
        const allocation = version?.allocation?.assets ?? [];
        const symbols = allocation.map((asset) => symbolOf(asset.address));
        const positions = allocation.map((asset, i) => ({
          p: symbols[i] ?? 'USDT',
          loc: symbols[i] ?? 'USDT',
          w: asset.weightBps / 100,
        }));
        return synthesizeCommunityFund({
          id: strategy.id,
          name: strategy.name,
          provider: strategy.provider,
          onchainId: strategy.onchainId,
          description: strategy.description,
          createdAt: strategy.createdAt,
          positions,
          // seed 用 strategy.id，與詳情頁（`/funds/strategy/:id`）一致 ——
          // 用陣列 index 的話，列表與詳情會算出**不同**的報酬（實測 +19.15% vs −23.81%）。
          seed: strategy.id,
        });
      }),
    // `details` 每次 render 都是新陣列，用它當依賴會無限重算 —— 用「已載入的版本數」當訊號。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [live, details.map((row) => row.data?.versions?.[0]?.version ?? 0).join(",")],
  );

  const returnTo = location.pathname + location.search;
  const controls = mobile && draft ? draft : filters;
  const countFilters = (value: ExploreFilters) => value.assets.length + Number(value.period !== "1Y") + Number(value.sort !== "perf");
  const resultCount = draft
    ? selectFunds(REFERENCE_FUNDS, draft.q, draft.category, draft.sort, draft.period, draft.assets as ("stocks" | "crypto" | "rwa")[]).length
    : visible.length;
  const applyFilters = () => {
    if (!draft) return;
    const next = filterUrl("assets", draft.assets.join(","));
    if (draft.period === "1Y") next.delete("period");
    else next.set("period", draft.period);
    if (draft.sort === "perf") next.delete("sort");
    else next.set("sort", draft.sort);
    setParams(next, { replace: true });
    setDraft(null);
  };
  const categories = (
    <nav className="collection-tabs" aria-label="Fund categories">
      {[{ id: "all", name: "All" }, ...COLLECTIONS].map((category) => (
        <Link
          key={category.id}
          to={{ pathname: location.pathname, search: filterUrl("category", category.id).toString() }}
          aria-current={filters.category === category.id ? "page" : undefined}
        >
          {category.name}
        </Link>
      ))}
    </nav>
  );
  const assetOptions = ASSET_CLASSES.map(({ id, name }) => (
    <label className="explore-filter-option" key={id}>
      <input
        type="checkbox"
        checked={controls.assets.includes(id)}
        onChange={() => {
          const assets = controls.assets.includes(id)
            ? controls.assets.filter((asset) => asset !== id)
            : [...controls.assets, id];
          if (mobile && draft) setDraft({ ...draft, assets });
          else change("assets", assets.join(","));
        }}
      />
      <span>{name}</span>
      {mobile && (
        <span className="app-filter-check" aria-hidden="true">
          <AppIcon name="check" size={15} />
        </span>
      )}
    </label>
  ));
  const advancedOptions = (
    <>
      <label className="explore-filter-field">
        <span className="app-field-label">Period</span>
        <select value={controls.period} onChange={(e) => {
          if (mobile && draft) setDraft({ ...draft, period: e.target.value as ExploreFilters["period"] });
          else change("period", e.target.value);
        }}>
          {["7D", "30D", "90D", "1Y", "ALL"].map((period) => <option key={period}>{period}</option>)}
        </select>
      </label>
      <label className="explore-filter-field">
        <span className="app-field-label">Sort by</span>
        <select value={controls.sort} onChange={(e) => {
          if (mobile && draft) setDraft({ ...draft, sort: e.target.value });
          else change("sort", e.target.value);
        }}>
          <option value="perf">Highest return</option>
          <option value="dd">Lowest drawdown</option>
          <option value="age">Longest history</option>
          <option value="name">Fund name</option>
        </select>
      </label>
    </>
  );
  const search = (
    <label className="explore-search">
      <AppIcon name="search" size={19} />
      <input
        type="search"
        aria-label="Filter funds"
        placeholder="Search funds"
        value={filters.q}
        onChange={(e) => change("q", e.target.value)}
      />
    </label>
  );
  const filterCount = countFilters(filters);
  return (
    <main className="explore-wrap" id="fund-explore">
      <header className="explore-heading">
        <h1>Explore funds<span>.</span></h1>
      </header>
      {!mobile && categories}
      <div className="explore-toolbar">
        {mobile ? (
          <>
            {search}
            <button
              className="app-filter-trigger"
              type="button"
              aria-haspopup="dialog"
              aria-label={filterCount ? `Filters, ${filterCount} applied` : "Filters"}
              aria-expanded={draft !== null}
              onClick={() => setDraft(filters)}
            >
              <AppIcon name="filter" size={23} />
              {filterCount > 0 && <span className="app-filter-count" aria-hidden="true">{filterCount}</span>}
            </button>
            <AppBottomSheet open={draft !== null} onOpenChange={(open) => { if (!open) setDraft(null); }} title="Filter funds">
              <fieldset className="app-filter-fields">
                <legend>Asset type</legend>
                {assetOptions}
              </fieldset>
              <div className="app-filter-options">{advancedOptions}</div>
              <div className="app-sheet-actions">
                {draft && countFilters(draft) > 0 && (
                  <button className="btn ghost" type="button" onClick={() => setDraft({ ...draft, assets: [], period: "1Y", sort: "perf" })}>
                    Reset
                  </button>
                )}
                <button className="btn primary" type="button" onClick={applyFilters}>
                  Show {resultCount} {resultCount === 1 ? "fund" : "funds"}
                </button>
              </div>
            </AppBottomSheet>
          </>
        ) : (
          <>
            {search}
            {/* 一顆 Filters 收進所有篩選（與手機一致）：原本 Assets、Advanced 兩顆，使用者得先決定要開哪一個。 */}
            <div className="explore-filter-list">
              <details className="explore-filter explore-filter--all" name="fund-filter" onBlur={closeOnBlur} onKeyDown={closeOnEscape}>
                <summary>
                  <AppIcon name="filter" size={16} />Filters
                  {filterCount > 0 && <span className="app-filter-count" aria-label={`${filterCount} applied`}>{filterCount}</span>}
                </summary>
                <div className="explore-filter-panel">
                  <fieldset className="app-filter-fields">
                    <legend>Asset type</legend>
                    {assetOptions}
                  </fieldset>
                  <div className="app-filter-options">{advancedOptions}</div>
                </div>
              </details>
            </div>
          </>
        )}
      </div>
      {mobile && categories}
      {visible.length === 0 && live.length === 0 && (
        <div className="directory-empty app-search-empty">
          <h2>No matches</h2>
        </div>
      )}
      {community.length > 0 && (
        <section className="explore-collection" aria-label="Community">
          <header>
            <div>
              <h2>Community{!mobile && <span>{community.length}</span>}</h2>
              <p>
                Strategies created on CRE8. Each one has an on-chain id and a published target
                allocation. Performance shown is modelled until a fund has live history.
              </p>
            </div>
            <span className="explore-current-period">
              {filters.period === "ALL" ? "All time" : filters.period} return
            </span>
          </header>
          {/* 手機沿用 App 版清單樣式；桌機用 FundRow（與其他基金列一致）。
              兩者必須互斥 —— 實測兩個都渲染時，同一個策略會在畫面上出現兩次。 */}
          {mobile && <ul className="app-live-strategies" role="list">
            {live.map((strategy) => {
              const yours = wallet !== null && strategy.provider?.toLowerCase() === wallet.toLowerCase();
              return (
                <li key={strategy.id}>
                  <Link to={`/strategies/${strategy.id}`}>
                    <div>
                      <h3>{strategy.name}</h3>
                      <div className="app-live-strategy-meta">
                        <span>{yours ? "Yours" : shortAddress(strategy.provider)}</span>
                        {strategy.onchainId != null && <span>On-chain #{strategy.onchainId}</span>}
                      </div>
                    </div>
                    <AppIcon name="right" size={16} />
                  </Link>
                </li>
              );
            })}
          </ul>}
          {!mobile && (
            <>
              <div className="fund-list-columns" aria-hidden="true">
                <span>Fund</span>
                <span>Return</span>
                <span>Assets</span>
              </div>
              <div className="fund-list">
                {community.map((fund, index) => {
                  const onchainId = live[index]?.onchainId;
                  return (
                    <FundRow
                      key={fund.slug}
                      fund={fund}
                      period={filters.period}
                      returnTo={returnTo}
                      href={`/strategies/${fund.slug.replace("community-", "")}`}
                      // 說明行平常放 X handle；社群策略沒有 X，換成「建立者 · 鏈上 id」。
                      meta={
                        <>
                          {fund.manager}
                          {onchainId != null ? ` · On-chain #${onchainId}` : ''}
                        </>
                      }
                    />
                  );
                })}
              </div>
            </>
          )}
        </section>
      )}
      {COLLECTIONS.map((c) => {
        const funds = visible.filter((f) => collectionOf(f) === c.id);
        return funds.length ? (
          <section
            className="explore-collection"
            key={c.id}
            aria-label={c.name}
          >
            <header>
              <div>
                <h2>
                  {c.name}
                  {!mobile && <span>{funds.length}</span>}
                </h2>
              </div>
              <span className="explore-current-period">
                {filters.period === "ALL" ? "All time" : filters.period} model return
              </span>
            </header>
            <div className="fund-list-columns" aria-hidden="true">
              <span>Fund</span>
              <span>Return</span>
              <span>Assets</span>
            </div>
            <div className="fund-list">
              {funds.map((f) => (
                <FundRow
                  key={f.slug}
                  fund={f as (typeof REFERENCE_FUNDS)[number]}
                  period={filters.period}
                  returnTo={returnTo}
                  showSource={c.id !== "public-figures"}
                />
              ))}
            </div>
          </section>
        ) : null;
      })}
    </main>
  );
}
