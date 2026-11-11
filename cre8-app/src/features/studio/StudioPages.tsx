import { useQueries, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AppIcon } from '../../components/AppIcon';
import { Badge, ErrorNote, Spinner } from '../../components/ui';
import { WalletMenu } from '../../components/WalletMenu';
import { getPortfolioStatus, getPortfolios, listStrategies } from '../../lib/api';
import type { Portfolio, PortfolioStatus, StrategySummary } from '../../lib/api';
import { formatUsdE8 } from '../../lib/format';
import { queryKeys } from '../../lib/query';
import { useBodyClass } from '../../lib/use-body-class';
import { useConnectedSessionToken } from '../../lib/use-connected-session';
import { useMobile } from '../../lib/use-mobile';
import { useWallet } from '../../store/wallet';

type Tone = 'ok' | 'warn' | 'bad';
type Flag = { label: string; tone: Tone; detail: string };

type StudioFund = {
  strategy: StrategySummary;
  portfolio: Portfolio | undefined;
  status: PortfolioStatus | undefined;
  statusPending: boolean;
  flags: Flag[];
};

const DAY = 86_400_000;

/**
 * 一檔基金「需要 creator 處理」的事。只用後端已經回傳的欄位推導，不猜：
 * 讀不到的值（status 還沒回來、RPC 掛掉）不會被當成 0 或「正常」。
 */
function fundFlags(portfolio: Portfolio | undefined, status: PortfolioStatus | undefined, now: number): Flag[] {
  if (portfolio === undefined) {
    return [{ label: 'No account', tone: 'warn', detail: 'This fund has no account yet, so it cannot hold assets or trade.' }];
  }
  const flags: Flag[] = [];
  const expires = portfolio.sessionKey?.expiresAt ? Date.parse(portfolio.sessionKey.expiresAt) : NaN;
  if (Number.isFinite(expires) && expires <= now) {
    flags.push({ label: 'Permission expired', tone: 'bad', detail: 'Trading is paused until you renew the trading permission.' });
  } else if (Number.isFinite(expires) && expires - now < 7 * DAY) {
    const days = Math.max(1, Math.ceil((expires - now) / DAY));
    flags.push({ label: `Renew in ${days}d`, tone: 'warn', detail: `The trading permission expires in ${days} ${days === 1 ? 'day' : 'days'}.` });
  }
  if (status === undefined) return flags;
  if (status.gas?.ready === false) {
    flags.push({ label: 'Low gas', tone: 'bad', detail: 'The account needs more BNB before it can trade again.' });
  }
  if (!status.complete) {
    flags.push({ label: 'Value unavailable', tone: 'warn', detail: 'Some holdings could not be priced right now.' });
  } else if (status.totalUsdE8 === '0') {
    flags.push({ label: 'Needs funding', tone: 'warn', detail: 'Deposit USDT so the fund can buy its holdings.' });
  } else if (status.drift.needsRebalance) {
    flags.push({ label: 'Rebalance due', tone: 'bad', detail: `Holdings have drifted ${status.drift.grossDriftBps} bps from target.` });
  }
  return flags;
}

/** Studio 三頁共用的資料：我建立的策略（provider = 我的錢包）＋我在這些策略上的帳戶狀態。 */
function useStudioFunds() {
  const token = useConnectedSessionToken();
  const address = useWallet((state) => state.address);
  // 與基金頁共用同一個 query key，切換頁面不重抓。
  const strategies = useQuery({
    queryKey: ['strategies', token],
    queryFn: () => listStrategies(token as string),
    enabled: token !== null,
  });
  const portfolios = useQuery({
    queryKey: queryKeys.portfolios(token),
    queryFn: () => getPortfolios(token as string),
    enabled: token !== null,
  });
  const mine = (strategies.data?.items ?? []).filter(
    (strategy) => address !== null && strategy.provider.toLowerCase() === address.toLowerCase(),
  );
  const accounts = mine.map((strategy) => (portfolios.data ?? []).find((portfolio) => portfolio.strategyId === strategy.id));
  const statuses = useQueries({
    queries: accounts.map((portfolio) => ({
      queryKey: queryKeys.status(token, portfolio?.id ?? -1),
      queryFn: () => getPortfolioStatus(token as string, portfolio!.id),
      enabled: token !== null && portfolio !== undefined,
    })),
  });
  const now = Date.now();
  const funds: StudioFund[] = mine.map((strategy, index) => {
    const portfolio = accounts[index];
    const status = statuses[index]?.data;
    return {
      strategy,
      portfolio,
      status,
      statusPending: portfolio !== undefined && (statuses[index]?.isPending ?? false),
      flags: fundFlags(portfolio, status, now),
    };
  });
  // 需要處理的排前面（嚴重的先），其餘依建立時間新到舊。
  const severity = (fund: StudioFund) =>
    fund.flags.reduce((sum, flag) => sum + (flag.tone === 'bad' ? 10 : flag.tone === 'warn' ? 1 : 0), 0);
  funds.sort((a, b) => severity(b) - severity(a) || Date.parse(b.strategy.createdAt) - Date.parse(a.strategy.createdAt));
  const valuesReady = funds.length > 0 && funds.every((fund) => fund.status?.complete);
  const totalUsd = valuesReady
    ? formatUsdE8(funds.reduce((sum, fund) => sum + BigInt(fund.status!.totalUsdE8), 0n).toString())
    : null;
  return {
    token,
    funds,
    totalUsd,
    loading: strategies.isPending || portfolios.isPending,
    error: strategies.error ?? portfolios.error,
  };
}

function StudioHeader({ title, action = true }: { title: string; action?: boolean }): ReactNode {
  const mobile = useMobile();
  return (
    <header className="explore-heading">
      <h1>{title}<span>.</span></h1>
      {action && !mobile && (
        <Link className="btn ghost app-portfolio-create" to="/create">Create fund <AppIcon name="create" size={18} /></Link>
      )}
    </header>
  );
}

/** 未連錢包：先講清楚 Studio 是什麼，再請他連線；沒建立過基金的人也能直接去設計一檔。 */
function StudioGuest(): ReactNode {
  return (
    <section className="app-portfolio-summary app-portfolio-guest" aria-labelledby="studio-guest-title">
      <span className="app-icon-tile app-portfolio-hero-icon"><AppIcon name="create" size={22} /></span>
      <h2 id="studio-guest-title">Your studio for the funds you create</h2>
      <p>Connect the wallet you create funds with to see what needs your attention, every fund you run, and what they earn.</p>
      <WalletMenu inline />
      <Link to="/create">Design a fund first <AppIcon name="right" size={16} /></Link>
    </section>
  );
}

function FirstFund(): ReactNode {
  return (
    <section className="app-portfolio-summary app-portfolio-guest" aria-labelledby="studio-first-title">
      <span className="app-icon-tile app-portfolio-hero-icon"><AppIcon name="create" size={22} /></span>
      <h2 id="studio-first-title">Create your first fund</h2>
      <p>Pick what it holds and how it trades. Once it is live, it shows up here with anything that needs your attention.</p>
      <Link className="btn primary" to="/create">Create a fund</Link>
    </section>
  );
}

function FundLedger({ funds, detail }: { funds: StudioFund[]; detail: 'flags' | 'summary' }): ReactNode {
  return (
    <ul className="app-portfolio-ledger app-studio-ledger">
      {funds.map(({ strategy, status, statusPending, flags }) => (
        <li key={strategy.id} className="app-holding-row app-ledger-link">
          <div className="app-holding-main">
            <h3><Link to={`/strategies/${strategy.id}`}>{strategy.name}</Link></h3>
            <div className="app-holding-status">
              {statusPending ? <span className="muted">Checking…</span>
                : flags.length ? flags.map((flag) => <Badge key={flag.label} tone={flag.tone}>{flag.label}</Badge>)
                : <Badge tone="ok">Running</Badge>}
            </div>
            {detail === 'flags' && flags[0] && <p className="app-studio-detail">{flags[0].detail}</p>}
            {detail === 'summary' && (
              <p className="app-studio-detail">
                Created {new Date(strategy.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                {strategy.isPublic ? ' · Public' : ' · Private'}
              </p>
            )}
          </div>
          <strong>{status?.complete ? formatUsdE8(status.totalUsdE8) : '—'}</strong>
          <AppIcon name="right" size={15} />
        </li>
      ))}
    </ul>
  );
}

function StudioState({ data, children }: { data: ReturnType<typeof useStudioFunds>; children: ReactNode }): ReactNode {
  if (data.token === null) return <StudioGuest />;
  if (data.loading) return <p className="fund-list-loading" role="status"><Spinner /> Loading your funds…</p>;
  if (data.error) return <ErrorNote error={data.error} />;
  if (!data.funds.length) return <FirstFund />;
  return <>{children}</>;
}

/** Today：creator 打開 Studio 第一眼該看的——有沒有哪檔基金要處理。 */
export function StudioTodayPage(): ReactNode {
  useBodyClass('portfolio-page', 'fund-explore', 'studio-page');
  const data = useStudioFunds();
  const attention = data.funds.filter((fund) => fund.flags.length > 0);
  return (
    <main className="explore-wrap app-portfolio app-studio">
      <StudioHeader title="Today" />
      <StudioState data={data}>
        <section className="app-portfolio-summary" aria-label="Studio summary">
          <p className="app-portfolio-kicker">Value across your funds</p>
          <strong className="app-portfolio-value">{data.totalUsd ?? '—'}</strong>
          <div className="app-portfolio-meta">
            <span>{data.funds.length} {data.funds.length === 1 ? 'fund' : 'funds'}</span>
            <span>{attention.length ? `${attention.length} need${attention.length === 1 ? 's' : ''} attention` : 'All running'}</span>
          </div>
        </section>
        <section className="app-studio-section" aria-labelledby="studio-attention">
          <h2 id="studio-attention">Needs attention</h2>
          {attention.length ? (
            <FundLedger funds={attention} detail="flags" />
          ) : (
            <div className="directory-empty app-studio-clear">
              <strong>Everything is running</strong>
              <p>No fund needs funding, a rebalance or a permission renewal right now.</p>
            </div>
          )}
          <Link className="app-studio-more" to="/studio/funds">All your funds <AppIcon name="right" size={15} /></Link>
        </section>
      </StudioState>
    </main>
  );
}

/** My funds：creator 建立的每一檔，需要處理的排最上面；點進去是該基金的管理頁。 */
export function StudioFundsPage(): ReactNode {
  useBodyClass('portfolio-page', 'fund-explore', 'studio-page');
  const data = useStudioFunds();
  return (
    <main className="explore-wrap app-portfolio app-studio">
      <StudioHeader title="My funds" />
      <StudioState data={data}>
        <p className="app-portfolio-caption">
          {data.funds.length} {data.funds.length === 1 ? 'fund' : 'funds'} · funds that need attention are listed first
        </p>
        <FundLedger funds={data.funds} detail="summary" />
      </StudioState>
    </main>
  );
}

/** Earnings：後端還沒有費用收入資料，誠實說明，不放假數字。 */
export function StudioEarningsPage(): ReactNode {
  useBodyClass('portfolio-page', 'fund-explore', 'studio-page');
  const token = useConnectedSessionToken();
  return (
    <main className="explore-wrap app-portfolio app-studio">
      <StudioHeader title="Earnings" action={false} />
      {token === null ? <StudioGuest /> : (
        <section className="app-portfolio-summary app-portfolio-guest" aria-labelledby="studio-earnings-title">
          <span className="app-icon-tile app-portfolio-hero-icon"><AppIcon name="chart" size={22} /></span>
          <h2 id="studio-earnings-title">Earnings are coming soon</h2>
          <p>Fees aren&apos;t tracked in the app yet. When they are, you&apos;ll see what each fund has earned from deposits and performance here.</p>
          <Link to="/studio/funds">See your funds <AppIcon name="right" size={16} /></Link>
        </section>
      )}
    </main>
  );
}
