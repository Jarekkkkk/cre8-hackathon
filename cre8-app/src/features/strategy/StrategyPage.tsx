import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getAssets, getPortfolios, getStrategy } from '../../lib/api';
import type { StrategyVersion } from '../../lib/api';
import { shortAddress } from '../../lib/format';
import { useBodyClass } from '../../lib/use-body-class';
import { useSession } from '../../store/session';
import { AssetLogos } from '../../components/AssetLogo';
import { ErrorNote, Note, Spinner } from '../../components/ui';

function cadence(schedule: StrategyVersion['schedule']): string {
  if (schedule.kind === 'cron') return `cron ${schedule.cron}`;
  const seconds = schedule.intervalSeconds;
  if (seconds % 86_400 === 0) return seconds === 86_400 ? 'daily' : `every ${seconds / 86_400} days`;
  if (seconds % 3_600 === 0) return seconds === 3_600 ? 'hourly' : `every ${seconds / 3_600}h`;
  return `every ${seconds}s`;
}

/**
 * 策略頁（參考站的 `/vault/<slug>`）。
 *
 * 為什麼需要它：投組頁回答「**我這一檔**現在怎麼樣」，但當 RPC 讀不到持倉時那一頁就只剩錯誤訊息 ——
 * 而「這個策略的 mandate 是什麼」是純 DB 資料，任何時候都該看得到。這頁就是那個保底視圖。
 */
export function StrategyPage(): ReactNode {
  useBodyClass('portfolio-page', 'fund-explore');
  const token = useSession((state) => state.token);
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const valid = Number.isInteger(id) && id > 0;

  const strategy = useQuery({
    queryKey: ['strategy', token, id],
    queryFn: () => getStrategy(token as string, id),
    enabled: token !== null && valid,
  });
  // 符號與 tradable 都靠這份（策略存的是地址）。
  const assets = useQuery({
    queryKey: ['assets', token],
    queryFn: () => getAssets(token as string),
    enabled: token !== null,
    staleTime: 60_000,
  });
  // 有哪些投組在跟這個策略。
  const portfolios = useQuery({
    queryKey: ['portfolios-for-strategy', token, id],
    queryFn: () => getPortfolios(token as string),
    enabled: token !== null && valid,
  });

  const byAddress = new Map((assets.data ?? []).map((asset) => [asset.address.toLowerCase(), asset]));
  const latest = strategy.data?.versions[0];
  const followers = (portfolios.data ?? []).filter((portfolio) => portfolio.strategyId === id);

  return (
    <main className="explore-wrap">
      <header className="explore-heading">
        <div>
          <p className="eyebrow">Strategy #{id}</p>
          <h1>
            {strategy.data === undefined ? '…' : strategy.data.name}
            <span>.</span>
          </h1>
          <p>
            {strategy.data === undefined
              ? 'Loading the mandate…'
              : strategy.data.description === ''
                ? 'No description recorded.'
                : strategy.data.description}
          </p>
        </div>
        <div className="explore-heading-actions">
          <Link className="btn btn--ghost" to="/studio/funds">
            My funds
          </Link>
        </div>
      </header>

      {!valid ? (
        <Note tone="bad">strategy id is not a positive integer: {params.id ?? '(empty)'}</Note>
      ) : token === null ? (
        <Note tone="warn">Sign in to read a strategy.</Note>
      ) : strategy.isPending ? (
        <div className="card row">
          <Spinner /> <span className="muted">Loading strategy…</span>
        </div>
      ) : strategy.error !== null && strategy.error !== undefined ? (
        <ErrorNote error={strategy.error} />
      ) : strategy.data === undefined ? null : (
        <>
          <div className="card stack">
            <dl className="kv">
              <dt>on-chain id</dt>
              <dd className="mono">{strategy.data.onchainId ?? 'not mirrored yet'}</dd>
              <dt>provider</dt>
              <dd className="mono">{shortAddress(strategy.data.provider)}</dd>
              <dt>visibility</dt>
              <dd>{strategy.data.isPublic ? 'public' : 'private'}</dd>
              <dt>versions</dt>
              <dd>{strategy.data.versions.length}</dd>
              <dt>followers</dt>
              <dd>
                {followers.length}
                {followers.length === 0 ? null : (
                  <span className="muted">
                    {' '}
                    — {followers.map((portfolio) => `#${portfolio.id}`).join(', ')}
                  </span>
                )}
              </dd>
            </dl>
          </div>

          {latest === undefined ? (
            <Note tone="warn">No version published yet — the strategy has no allocation to follow.</Note>
          ) : (
            <div className="card stack">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                <h2 style={{ margin: 0 }}>Mandate · v{latest.version}</h2>
                <span className="muted" style={{ fontSize: 12 }}>
                  rebalance {cadence(latest.schedule)}
                </span>
              </div>

              {latest.changeLog === null ? null : (
                <p className="muted" style={{ fontSize: 13, margin: 0 }}>
                  {latest.changeLog}
                </p>
              )}

              <div className="fund-row-assets" style={{ marginBottom: 4 }}>
                <AssetLogos
                  symbols={latest.allocation.assets.map(
                    (asset) => byAddress.get(asset.address.toLowerCase())?.symbol ?? '?',
                  )}
                />
              </div>

              <table className="table">
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Address</th>
                    <th>Tradable</th>
                    <th className="num">Target bps</th>
                    <th className="num">Weight</th>
                  </tr>
                </thead>
                <tbody>
                  {latest.allocation.assets.map((asset) => {
                    const meta = byAddress.get(asset.address.toLowerCase());
                    return (
                      <tr key={asset.address}>
                        <td>{meta?.symbol ?? '(unknown asset)'}</td>
                        <td className="mono muted" style={{ fontSize: 12 }}>
                          {shortAddress(asset.address)}
                        </td>
                        <td>
                          {meta === undefined ? (
                            <span className="muted">—</span>
                          ) : meta.tradable === true ? (
                            <span className="pos">yes</span>
                          ) : meta.tradable === false ? (
                            <span className="neg">no oracle</span>
                          ) : (
                            <span className="muted">unknown</span>
                          )}
                        </td>
                        <td className="num">{asset.weightBps}</td>
                        <td className="num">{(asset.weightBps / 100).toFixed(2)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                A version is immutable: changing weights means publishing a new version, and every follower keeps the
                version it pinned until it re-enrolls.
              </p>
            </div>
          )}

          {strategy.data.versions.length > 1 ? (
            <div className="card stack">
              <h2 style={{ margin: 0 }}>Version history</h2>
              <table className="table">
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Cadence</th>
                    <th className="num">Assets</th>
                    <th>Published</th>
                    <th>Change log</th>
                  </tr>
                </thead>
                <tbody>
                  {strategy.data.versions.map((version) => (
                    <tr key={version.version}>
                      <td>v{version.version}</td>
                      <td className="muted">{cadence(version.schedule)}</td>
                      <td className="num">{version.allocation.assets.length}</td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {new Date(version.createdAt).toLocaleString('en-GB', { hour12: false })}
                      </td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {version.changeLog ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <div className="card stack">
            <h2 style={{ margin: 0 }}>Following</h2>
            {followers.length === 0 ? (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                No portfolio follows this strategy yet.
              </p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Portfolio</th>
                    <th>Account</th>
                    <th className="num">Pinned version</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {followers.map((portfolio) => (
                    <tr key={portfolio.id}>
                      <td>#{portfolio.id}</td>
                      <td className="mono muted" style={{ fontSize: 12 }}>
                        {portfolio.smartAccounts[0] === undefined
                          ? '—'
                          : shortAddress(portfolio.smartAccounts[0].address)}
                      </td>
                      <td className="num">v{portfolio.version}</td>
                      <td>
                        <span className="muted">—</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              Each follower gets <strong>its own Kernel smart account</strong> — one account per (owner, strategy)
              pair, so gas, approvals and the session key are all independent.
            </p>
          </div>
        </>
      )}
    </main>
  );
}
