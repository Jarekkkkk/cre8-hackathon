import { useQueries, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AppIcon } from '../../components/AppIcon';
import { Badge, ErrorNote, Spinner } from '../../components/ui';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { WalletMenu } from '../../components/WalletMenu';
import { MOCK_FUNDS } from '../../data/mock-funds';
import { getPortfolioActivity, getPortfolioStatus, getPortfolios } from '../../lib/api';
import type { PortfolioStatus } from '../../lib/api';
import { formatUsdE8, shortAddress } from '../../lib/format';
import { REFERENCE_METADATA } from '../../lib/public-funds';
import { queryKeys } from '../../lib/query';
import { useBodyClass } from '../../lib/use-body-class';
import { useConnectedSessionToken } from '../../lib/use-connected-session';
import { useMobile } from '../../lib/use-mobile';
import { useWallet } from '../../store/wallet';

function holdingState(status: PortfolioStatus | undefined) {
  if (status === undefined || !status.complete) return <Badge tone="warn">Value unavailable</Badge>;
  if (status.totalUsdE8 === '0') return <Badge tone="warn">Needs funding</Badge>;
  if (status.drift.needsRebalance) return <Badge tone="bad">Rebalance due</Badge>;
  return <Badge tone="ok">Aligned</Badge>;
}

export function PortfoliosPage(): ReactNode {
  useBodyClass('portfolio-page', 'fund-explore');
  const mobile = useMobile();
  const token = useConnectedSessionToken();
  const address = useWallet((state) => state.address);
  const portfolios = useQuery({
    queryKey: queryKeys.portfolios(token),
    queryFn: () => getPortfolios(token as string),
    enabled: token !== null,
  });
  const items = portfolios.data ?? [];

  const statuses = useQueries({
    queries: items.map(({ id }) => ({
      queryKey: queryKeys.status(token, id),
      queryFn: () => getPortfolioStatus(token as string, id),
      enabled: token !== null,
    })),
  });
  const activities = useQueries({
    queries: items.map(({ id }) => ({
      queryKey: ['activity', token, id],
      queryFn: () => getPortfolioActivity(token as string, id),
      enabled: token !== null,
    })),
  });

  const valueReady = portfolios.data !== undefined &&
    statuses.every((row) => row.data?.complete && row.data.totalUsdE8 != null);
  const valueLoading = portfolios.isPending || statuses.some((row) => row.isPending);
  const totalUsd = valueReady
    ? formatUsdE8(statuses.reduce((sum, row) => sum + BigInt(row.data!.totalUsdE8), 0n).toString())
    : '—';
  const holdings = items.map(({ id, strategyId, strategyName }, index) => {
    const query = statuses[index];
    const status = query?.data;
    const slug = MOCK_FUNDS.find((fund) => fund.name === strategyName)?.slug;
    const path = slug !== undefined
      ? `/funds/${slug}?position=1&returnTo=%2Fportfolios`
      : strategyId != null ? `/strategies/${strategyId}` : undefined;
    return {
      id, status, name: strategyName ?? `Strategy ${id}`,
      cover: slug ? REFERENCE_METADATA[slug]?.cover : undefined,
      path,
      value: status?.complete ? formatUsdE8(status.totalUsdE8) : '—',
      drift: status?.complete && status.totalUsdE8 !== '0' ? `${status.drift.grossDriftBps} bps` : '—',
      state: query?.isPending ? <span className="muted">Loading…</span> : holdingState(status),
    };
  });
  const activityLoading = activities.some((row) => row.isPending);
  const activityError = activities.some((row) => row.isError);
  const activity = activities.flatMap((row, index) => {
    const portfolio = items[index];
    if (!portfolio) return [];
    return (row.data?.activity ?? []).map((entry) => ({ portfolio, entry }));
  }).sort((left, right) => right.entry.id - left.entry.id).slice(0, 20).map(({ portfolio, entry }) => ({
    key: `${portfolio.id}-${entry.id}`,
    name: portfolio.strategyName ?? `Strategy ${portfolio.id}`,
    date: new Date(entry.createdAt).toLocaleString('en-GB', { hour12: false }),
    state: <Badge tone={entry.state === 'confirmed' ? 'ok' : entry.state === 'failed' ? 'bad' : 'warn'}>{entry.state}</Badge>,
    drift: entry.driftBeforeBps === null || entry.driftAfterBps === null ? '—' : `${entry.driftBeforeBps} → ${entry.driftAfterBps} bps`,
    value: entry.usdBeforeE8 === null || entry.usdAfterE8 === null ? '—' : `${formatUsdE8(entry.usdBeforeE8)} → ${formatUsdE8(entry.usdAfterE8)}`,
    hash: entry.txHash === null ? '—' : `${entry.txHash.slice(0, 10)}…${entry.txHash.slice(-6)}`,
  }));

  return (
    <main className="explore-wrap app-portfolio">
      <header className="explore-heading">
        <h1>Portfolio<span>.</span></h1>
        {token !== null && !mobile && <Link className="btn ghost app-portfolio-create" to="/create">Create fund <AppIcon name="create" size={18} /></Link>}
      </header>

      {token === null ? (
        <section className="app-portfolio-summary app-portfolio-guest" aria-labelledby="portfolio-guest-title">
          {/* 未連錢包時只放一顆按鈕，使用者不知道連了之後會看到什麼；先說明這頁的用途再請他連線。 */}
          <span className="app-icon-tile app-portfolio-hero-icon"><AppIcon name="wallet" size={22} /></span>
          <h2 id="portfolio-guest-title">See your funds in one place</h2>
          <p>Connect your wallet to see each fund account you hold, its current value, and every rebalance.</p>
          <WalletMenu inline />
          <Link to="/vaults">Explore funds <AppIcon name="right" size={16} /></Link>
        </section>
      ) : (
        <>
          <section className="app-portfolio-summary" aria-label="Portfolio summary">
            <p className="app-portfolio-kicker">Total portfolio value</p>
            <strong className="app-portfolio-value">{totalUsd}</strong>
            <div className="app-portfolio-meta">
              <span>{items.length} {items.length === 1 ? 'fund account' : 'fund accounts'}</span>
              {!mobile && address !== null && <span className="mono" title={address}>{shortAddress(address)}</span>}
            </div>
            {!valueReady && <p role="status">{valueLoading ? 'Loading account values…' : 'Total unavailable. Some account values could not be verified.'}</p>}
          </section>
          <ErrorNote error={portfolios.error} />
          {!portfolios.isError && (
            <Tabs defaultValue="holdings" className="app-portfolio-tabs">
              <TabsList aria-label="Portfolio sections">
                <TabsTrigger value="holdings"><AppIcon name="holdings" size={17} /> Holdings</TabsTrigger>
                <TabsTrigger value="activity"><AppIcon name="activity" size={17} /> Activity</TabsTrigger>
              </TabsList>

              <TabsContent value="holdings" className="app-portfolio-pane">
                {portfolios.isPending ? (
                  <p className="fund-list-loading" role="status"><Spinner /> Loading holdings…</p>
                ) : !holdings.length ? (
                  <div className="directory-empty"><strong>No fund accounts yet</strong><Link to="/create">Create a fund</Link><Link className="btn ghost" to="/vaults">Explore funds</Link></div>
                ) : mobile ? (
                  <ul className="app-portfolio-ledger">
                    {holdings.map(({ id, status, name, path, value, drift, state, cover }) => (
                      <li key={id} className={`app-holding-row${path ? ' app-ledger-link' : ''}`}>
                        {cover ? (
                          <img className="app-holding-cover" src={cover.thumbnailSrc} alt="" width={46} height={46}
                            style={{ objectPosition: `50% ${cover.thumbnailPosition}%` }} />
                        ) : (
                          <span className="app-icon-tile app-holding-cover"><AppIcon name="holdings" size={21} /></span>
                        )}
                        <div className="app-holding-main">
                          <h3>{path ? <Link to={path}>{name}</Link> : name}</h3>
                          <div className="app-holding-status">{state}{drift !== '—' && <span>· {drift} drift</span>}</div>
                          {status && !path && <span className="app-holding-address mono">{shortAddress(status.account)}</span>}
                        </div>
                        <strong>{value}</strong>
                        {path && <AppIcon name="right" size={15} />}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="portfolio-table-scroll">
                    <table className="table" aria-label="Fund holdings">
                      <thead><tr><th>Fund</th><th>Account</th><th className="num">Value</th><th className="num">Drift</th><th>State</th></tr></thead>
                      <tbody>
                        {holdings.map(({ id, status, name, path, value, drift, state }) => (
                          <tr key={id}>
                            <td>{path ? <Link to={path}>{name}</Link> : name}</td>
                            <td className="mono muted">{status ? shortAddress(status.account) : '—'}</td>
                            <td className="num">{value}</td><td className="num">{drift}</td><td>{state}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="activity" className="app-portfolio-pane">
                {(portfolios.isPending || activityLoading) && <p role="status" className="app-portfolio-caption">Loading activity…</p>}
                {activityError && <p role="status" className="app-portfolio-caption">Some activity could not be loaded.</p>}
                {!activity.length ? (
                  !portfolios.isPending && !activityLoading && !activityError && (
                    <div className="directory-empty"><strong>No activity yet</strong></div>
                  )
                ) : mobile ? (
                  <ul className="app-portfolio-ledger">
                    {activity.map(({ key, name, date, state, drift, value, hash }) => (
                      <li key={key}>
                        <div className="app-ledger-heading">
                          <div className="app-ledger-title">
                            <h3>{name}</h3>
                          </div>
                          {state}
                        </div>
                        <p>{date}</p>
                        <dl className="app-ticket-details">
                          <dt>Drift</dt><dd>{drift}</dd>
                          <dt>Value</dt><dd>{value}</dd>
                          <dt>Transaction</dt><dd>{hash}</dd>
                        </dl>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="portfolio-table-scroll">
                    <table className="table" aria-label="Activity history">
                      <thead><tr><th>Fund</th><th>When</th><th>State</th><th className="num">Drift</th><th className="num">Value</th><th>Transaction</th></tr></thead>
                      <tbody>
                        {activity.map(({ key, name, date, state, drift, value, hash }) => (
                          <tr key={key}><td>{name}</td><td>{date}</td><td>{state}</td><td className="num mono">{drift}</td><td className="num mono">{value}</td><td className="mono muted">{hash}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </TabsContent>
            </Tabs>
          )}
        </>
      )}
    </main>
  );
}
