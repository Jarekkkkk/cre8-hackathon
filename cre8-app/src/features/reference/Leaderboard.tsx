import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useBodyClass } from '../../lib/use-body-class';
import { REFERENCE_FUNDS, pct } from '../../lib/public-funds';
import { CRE8_CREATOR, creatorPath, rankCreators } from '../../lib/creators';
import { performancePeriod } from '../../reference/lib/fund-navigation';
import { assetClassesOf } from '../../reference/lib/fund-explore';
import { CreatorControls, creatorFilters, matchesReturn } from './CreatorControls';
export function Leaderboard() {
  useBodyClass('fund-explore', 'atp-formal-market', 'atp-complete-market', 'atp-creators');
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const period = performancePeriod(params.get('period'));
  const query = params.get('q') ?? '';
  const filters = creatorFilters(params);
  const ranked = rankCreators(REFERENCE_FUNDS, period);
  if (filters.order === 'funds') ranked.sort((a, b) => b.funds.length - a.funds.length);
  if (filters.order === 'name') ranked.sort((a, b) => a.name.localeCompare(b.name));
  const creators = ranked.map((creator, index) => ({ ...creator, rank: index + 1 })).filter((creator) =>
    `${creator.name} ${creator.id}`.toLowerCase().includes(query.trim().toLowerCase()) &&
    matchesReturn(creator.averageReturn, filters.direction) &&
    creator.funds.length >= Number(filters.fundCount) &&
    (!filters.asset || creator.funds.some((fund) => assetClassesOf(fund).some((asset) => asset === filters.asset))),
  );
  const clearFilters = () => {
    const next = new URLSearchParams(params);
    for (const key of ['q', 'order', 'return', 'asset', 'funds']) next.delete(key);
    setParams(next, { replace: true });
  };
  return (
    <main className="explore-wrap" id="creator-leaderboard">
      <header className="explore-heading"><h1>Creators<span>.</span></h1></header>
      {/* creator 少於 9 位時，一眼就看完了，不需要搜尋與篩選。 */}
      <CreatorControls params={params} setParams={setParams} isLeaderboard refinable={ranked.length > 8} />
      {creators.length ? (
        <table className="creator-table">
          <caption className="sr-only">Creator rankings</caption>
          <thead><tr><th scope="col">Rank</th><th scope="col">Creator</th><th scope="col">Funds</th><th scope="col">Avg. return</th></tr></thead>
          <tbody>{creators.map(creator => <tr key={creator.id} data-creator={creator.id}>
            <td className="creator-rank">{creator.rank}</td>
            <td><Link className="creator-identity" to={`${creatorPath(creator.id)}?period=${period}&returnTo=${encodeURIComponent(location.pathname + location.search)}`}>
              {creator.id === CRE8_CREATOR ? <img src="/logos/cre8-icon.svg" alt="" width="40" height="40" /> : null}
              <span><strong>{creator.name}</strong>{creator.id !== CRE8_CREATOR && <small>{creator.id.slice(0, 6)}…{creator.id.slice(-4)}</small>}</span>
            </Link></td>
            <td className="creator-count">{creator.funds.length}</td>
            <td className="creator-return"><strong className={creator.averageReturn === null ? '' : creator.averageReturn >= 0 ? 'pos' : 'neg'}>{pct(creator.averageReturn)}</strong></td>
          </tr>)}</tbody>
        </table>
      ) : <div className="directory-empty"><strong>No matching creators</strong><button className="btn ghost sm" type="button" onClick={clearFilters}>Clear filters</button></div>}
      <details className="creator-method"><summary>Ranking methodology</summary><p>Average model returns are equal-weighted across available funds, before fees. Funds with less than one year of history use all available observations.</p></details>
    </main>
  );
}
