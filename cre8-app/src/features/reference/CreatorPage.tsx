import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { useBodyClass } from '../../lib/use-body-class';
import { REFERENCE_FUNDS } from '../../lib/public-funds';
import { creatorId, rankCreators } from '../../lib/creators';
import { periodMetrics, selectFunds } from '../../reference/lib/fund-explore';
import { performancePeriod } from '../../reference/lib/fund-navigation';
import { safePublicReturn } from '../../lib/public-navigation';
import { FundRow } from './FundRow';
import { CreatorControls, creatorFilters, matchesReturn } from './CreatorControls';
export function CreatorPage() {
  useBodyClass('fund-explore', 'atp-formal-market', 'atp-complete-market');
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const period = performancePeriod(params.get('period'));
  const creator = rankCreators(REFERENCE_FUNDS, period).find(entry => entry.id === creatorId(id));
  const backTo = safePublicReturn(params.get('returnTo') ?? '/leaderboard', window.location.origin);
  if (!creator) return <main className="page"><h1>Creator not found</h1><Link to="/leaderboard">All creators</Link></main>;
  const filters = creatorFilters(params);
  const funds = selectFunds(creator.funds, '', 'all', filters.order === 'drawdown' ? 'dd' : 'perf', period,
    filters.asset ? [filters.asset] : [],
  ).filter((fund) => matchesReturn(periodMetrics(fund, period).returnPct, filters.direction));
  if (filters.order === 'name') funds.sort((a, b) => a.name.localeCompare(b.name));
  return (
    <main className="explore-wrap" id="fund-explore">
      <Link className="vault-back" to={backTo}>← Back</Link>
      <header className="explore-heading"><h1>{creator.name}</h1></header>
      <CreatorControls params={params} setParams={setParams} isLeaderboard={false} />
      <div className="fund-list">{funds.map((fund) => (
        <FundRow key={fund.slug} fund={fund as (typeof REFERENCE_FUNDS)[number]} period={period} returnTo={location.pathname + location.search} />
      ))}</div>
      {funds.length === 0 && <div className="directory-empty"><strong>No matching funds</strong></div>}
    </main>
  );
}
