import { useId, useState } from 'react';
import type { SetURLSearchParams } from 'react-router-dom';
import { AppIcon } from '../../components/AppIcon';
import { ASSET_CLASSES, type AssetClass, type Period } from '../../reference/lib/fund-explore';
import { performancePeriod } from '../../reference/lib/fund-navigation';
import { ReferenceSheet } from './ReferenceSheet';

const PERIODS: Period[] = ['7D', '30D', '90D', '1Y', 'ALL'];
const defaults = { order: 'return', direction: '', asset: '', fundCount: '' };
type Filters = typeof defaults;

export function creatorFilters(params: URLSearchParams) {
  const order = params.get('order');
  const direction = params.get('return');
  const asset = ASSET_CLASSES.find(({ id }) => id === params.get('asset'))?.id ?? '';
  const fundCount = params.get('funds');
  return {
    order: order === 'funds' || order === 'drawdown' || order === 'name' ? order : 'return',
    direction: direction === 'positive' || direction === 'negative' ? direction : '',
    asset,
    fundCount: fundCount === '5' || fundCount === '10' ? fundCount : '',
  } as const;
}

export function matchesReturn(value: number | null, direction: string) {
  if (!direction) return true;
  return value !== null && (direction === 'positive' ? value > 0 : value < 0);
}

export function CreatorControls({ params, setParams, isLeaderboard, refinable = true }: {
  params: URLSearchParams;
  setParams: SetURLSearchParams;
  isLeaderboard: boolean;
  /**
   * 搜尋與篩選要不要出現。項目少時它們只是多一個要想的決定（只有一個 creator 卻能搜尋、篩選）；
   * 但如果網址已經帶了篩選，仍然顯示，使用者才有辦法清掉。
   */
  refinable?: boolean;
}) {
  const active = creatorFilters(params);
  const labelId = useId();
  const [draft, setDraft] = useState<Filters | null>(null);
  const period = performancePeriod(params.get('period'));
  const count = Number(active.order !== 'return') + Number(!!active.direction) +
    Number(!!active.asset) + Number(isLeaderboard && !!active.fundCount);
  const showRefine = refinable || count > 0 || (params.get('q') ?? '') !== '';

  function update(values: Record<string, string>) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(values)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      return next;
    }, { replace: true });
  }

  function apply(filters: Filters) {
    update({
      order: filters.order === defaults.order ? '' : filters.order,
      return: filters.direction,
      asset: filters.asset,
      funds: filters.fundCount,
    });
    setDraft(null);
  }

  return (
    <div className="creator-toolbar">
      <div className="creator-periods" role="group" aria-label={isLeaderboard ? 'Ranking period' : 'Fund period'}>
        {PERIODS.map((value) => (
          <button key={value} type="button" aria-pressed={period === value}
            onClick={() => update({ period: value === '1Y' ? '' : value })}>
            {value === 'ALL' ? 'All' : value}
          </button>
        ))}
      </div>
      {showRefine && <div className="creator-toolbar-actions">
        {isLeaderboard && (
          <label className="creator-search">
            <AppIcon name="search" size={18} />
            <input type="search" aria-label="Find a creator" placeholder="Search creators"
              value={params.get('q') ?? ''} onChange={(event) => update({ q: event.target.value })} />
          </label>
        )}
        <button type="button" className="btn ghost creator-filter-trigger" aria-haspopup="dialog"
          aria-expanded={draft !== null} onClick={() => setDraft(active)}>
          <AppIcon name="filter" size={18} /> Filters{count > 0 && <span>{count}</span>}
        </button>
      </div>}
      <ReferenceSheet open={draft !== null} onOpenChange={(open) => { if (!open) setDraft(null); }} title="Filters">
        {draft && (
          <form className="creator-filter-form" onSubmit={(event) => { event.preventDefault(); apply(draft); }}>
            <div className="app-filter-options">
              <label><span id={`${labelId}-order`}>Sort by</span>
                <select aria-labelledby={`${labelId}-order`} value={draft.order} onChange={(event) => setDraft({ ...draft, order: event.target.value })}>
                  <option value="return">Highest return</option>
                  {isLeaderboard ? <option value="funds">Most funds</option> : <option value="drawdown">Lowest drawdown</option>}
                  <option value="people" disabled>Investors · unavailable</option>
                  <option value="name">Name</option>
                </select>
              </label>
              <label><span id={`${labelId}-return`}>Return</span>
                <select aria-labelledby={`${labelId}-return`} value={draft.direction} onChange={(event) => setDraft({ ...draft, direction: event.target.value })}>
                  <option value="">Any return</option>
                  <option value="positive">Positive</option>
                  <option value="negative">Negative</option>
                </select>
              </label>
              <label><span id={`${labelId}-asset`}>Asset type</span>
                <select aria-labelledby={`${labelId}-asset`} value={draft.asset} onChange={(event) => setDraft({ ...draft, asset: event.target.value as AssetClass | '' })}>
                  <option value="">All assets</option>
                  {ASSET_CLASSES.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
                </select>
              </label>
              {isLeaderboard && (
                <label><span id={`${labelId}-fund-count`}>Number of funds</span>
                  <select aria-labelledby={`${labelId}-fund-count`} value={draft.fundCount} onChange={(event) => setDraft({ ...draft, fundCount: event.target.value })}>
                    <option value="">Any</option>
                    <option value="5">5 or more</option>
                    <option value="10">10 or more</option>
                  </select>
                </label>
              )}
            </div>
            <div className="app-sheet-actions">
              <button type="button" className="btn ghost" onClick={() => setDraft(defaults)}>Reset</button>
              <button type="submit" className="btn primary">Apply filters</button>
            </div>
          </form>
        )}
      </ReferenceSheet>
    </div>
  );
}
