import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, getOperatorActivity, getOperatorOverview, operatorForceRebalance } from '../../lib/api';
import type { OperatorActivityRow, OperatorOverview, OperatorRow } from '../../lib/api';
import { formatEther } from 'viem';
import { formatUsdE8, shortAddress } from '../../lib/format';
import { useBodyClass } from '../../lib/use-body-class';
import { sessionIsLive, useSession } from '../../store/session';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge, ErrorNote, Spinner } from '../../components/ui';
import { toast } from '../../components/Toast';
import { Link } from 'react-router-dom';
import { AppIcon } from '../../components/AppIcon';
import { WalletMenu } from '../../components/WalletMenu';

/** 相對時間（「12 秒前」）比絕對時間更能回答「現在有沒有在跑」。 */
function ago(iso: string | null): string {
  if (iso === null) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** 排程時間的方向很重要：`in 5m`（還沒到）與 `due 3h ago`（該跑而沒跑）是兩件不同的事。 */
function due(iso: string | null): string {
  if (iso === null) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const delta = ms - Date.now();
  const abs = Math.abs(delta);
  const unit = abs < 60_000 ? `${Math.round(abs / 1000)}s` : abs < 3_600_000 ? `${Math.round(abs / 60_000)}m` : `${Math.round(abs / 3_600_000)}h`;
  return delta >= 0 ? `in ${unit}` : `due ${unit} ago`;
}

function until(iso: string | null): { text: string; tone: string } {
  if (iso === null) return { text: '—', tone: 'muted' };
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return { text: '—', tone: 'muted' };
  const days = Math.floor((ms - Date.now()) / 86_400_000);
  if (days < 0) return { text: `expired ${Math.abs(days)}d`, tone: 'neg' };
  if (days < 7) return { text: `${days}d`, tone: 'neg' };
  if (days < 30) return { text: `${days}d`, tone: 'warn' };
  return { text: `${days}d`, tone: 'pos' };
}

/** 一列的「該不該有人去看」訊號：gas 沒了、key 快過期、連續失敗、需要再平衡但沒動。 */
function rowFlags(row: OperatorRow): { label: string; tone: 'ok' | 'warn' | 'bad' }[] {
  const flags: { label: string; tone: 'ok' | 'warn' | 'bad' }[] = [];
  // 空倉：什麼都不用處理。不顯示 gas low / rebalance due —— 那些對一個 $0 的帳戶沒有意義，
  // 只會讓 operator 以為有事要追（實測：清倉後兩列都掛著「gas low + rebalance due」）。
  if (row.isEmpty) return [{ label: 'closed (no funds)', tone: 'ok' }];
  const gas = row.gasWei === null ? null : BigInt(row.gasWei);
  if (row.gasWei === null) flags.push({ label: 'gas unknown', tone: 'warn' });
  else if (gas !== null && gas < 10n ** 16n) flags.push({ label: 'gas low', tone: 'bad' });

  const key = until(row.sessionKeyExpiresAt);
  if (key.tone === 'neg') flags.push({ label: 'key expiring', tone: 'bad' });
  else if (key.tone === 'warn') flags.push({ label: 'key soon', tone: 'warn' });

  if (row.lastOperation?.state === 'failed') flags.push({ label: 'last round failed', tone: 'bad' });
  if (row.needsRebalance === true) flags.push({ label: 'rebalance due', tone: 'warn' });
  if (row.observedAt === null) flags.push({ label: 'never ran', tone: 'warn' });
  return flags;
}

/**
 * 最近活動：**誰、哪個策略、什麼時候、成功還是失敗**。
 *
 * 為什麼與上面的表格分開：上面是「現況」（誰現在 drift 多少、該不該跑），
 * 這裡是「歷史」（誰在什麼時候被處理過）。同一個投組會在這張表出現很多次，
 * 因為它就是「每一輪的紀錄」。
 */
/** 「失敗」的定義收在一處：state 是 failed 或 reverted（後者是「上鏈但 op 沒成功」）。 */
function isFailure(row: OperatorActivityRow): boolean {
  return row.state === 'failed' || row.state === 'reverted';
}

function ActivityTable({ token }: { token: string }): ReactNode {
  const [result, setResult] = useState<'all' | 'failed' | 'ok'>('all');
  const [strategy, setStrategy] = useState<string>('all');
  const activity = useQuery({
    queryKey: ['operator-activity', token],
    queryFn: () => getOperatorActivity(token, 50),
    enabled: token !== null,
    // 與 overview 一樣自動刷新：排程器每 60 秒跑一輪，這裡要跟得上。
    refetchInterval: 15_000,
  });

  if (activity.isPending) {
    return (
      <div className="fund-list-loading">
        <Spinner /> <span className="muted">Loading activity…</span>
      </div>
    );
  }
  if (activity.error !== null && activity.error !== undefined) return <ErrorNote error={activity.error} />;

  const all: OperatorActivityRow[] = activity.data?.activity ?? [];
  if (all.length === 0) {
    return (
      <div className="directory-empty">
        <strong>No rebalance rounds yet</strong>
      </div>
    );
  }

  // 篩選在**前端**做：一次只拉 50 筆，資料量小到手動過濾就夠了。
  // 放到後端只會多一個 query 參數要維護，換不到什麼。
  const failures = all.filter(isFailure);
  const strategies = [...new Set(all.map((row) => row.strategyName ?? `Strategy ${row.strategyId}`))].sort();
  const rows = all.filter((row) => {
    if (result === 'failed' && !isFailure(row)) return false;
    if (result === 'ok' && isFailure(row)) return false;
    if (strategy !== 'all' && (row.strategyName ?? `Strategy ${row.strategyId}`) !== strategy) return false;
    return true;
  });

  return (
    <>
      <div className="activity-filters">
        <span className="label">filter</span>
        <div className="flex items-center gap-1" role="group" aria-label="Filter by result">
          <Button size="sm" variant={result === 'all' ? 'default' : 'outline'} onClick={() => setResult('all')}>
            All ({all.length})
          </Button>
          <Button
            size="sm"
            variant={result === 'failed' ? 'destructive' : 'outline'}
            onClick={() => setResult('failed')}
          >
            Failed ({failures.length})
          </Button>
          <Button size="sm" variant={result === 'ok' ? 'default' : 'outline'} onClick={() => setResult('ok')}>
            Confirmed ({all.length - failures.length})
          </Button>
        </div>
        <select
          aria-label="Filter by strategy"
          value={strategy}
          onChange={(event) => setStrategy(event.target.value)}
          className="activity-filter-select"
        >
          <option value="all">All strategies</option>
          {strategies.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>

      {rows.length === 0 ? (
        <div className="directory-empty">
          <strong>No matching activity</strong>
          <p>
            {failures.length === 0
              ? 'Nothing failed in the last 50 operations.'
              : 'Try clearing the strategy filter.'}
          </p>
        </div>
      ) : (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>when</TableHead>
            <TableHead>owner</TableHead>
            <TableHead>strategy</TableHead>
            <TableHead>#</TableHead>
            <TableHead>kind</TableHead>
            <TableHead>result</TableHead>
            <TableHead>drift</TableHead>
            <TableHead>tx</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const drift =
              row.driftBeforeBps === null
                ? '—'
                : row.driftAfterBps === null
                  ? `${row.driftBeforeBps} bps → ?`
                  : `${row.driftBeforeBps} → ${row.driftAfterBps} bps`;
            return (
              <TableRow key={row.id}>
                <TableCell className="whitespace-nowrap text-xs text-[var(--muted)]">
                  {new Date(row.createdAt).toLocaleTimeString('en-GB')}
                </TableCell>
                <TableCell className="font-mono text-xs">{shortAddress(row.wallet)}</TableCell>
                <TableCell className="font-medium">{row.strategyName ?? `Strategy ${row.strategyId}`}</TableCell>
                <TableCell className="font-mono text-xs text-[var(--muted)]">{row.portfolioId}</TableCell>
                <TableCell className="text-xs text-[var(--muted)]">{row.type}</TableCell>
                <TableCell>
                  <Badge tone={isFailure(row) ? 'bad' : row.state === 'confirmed' ? 'ok' : 'warn'}>{row.state}</Badge>
                </TableCell>
                <TableCell className="tabular-nums text-xs">{drift}</TableCell>
                <TableCell className="font-mono text-[11px] text-[var(--muted)]">
                  {row.txHash === null ? '—' : `${row.txHash.slice(0, 12)}…`}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      )}
    </>
  );
}

function Dashboard({
  overview,
  token,
  refetch,
}: {
  overview: OperatorOverview;
  token: string;
  refetch: () => Promise<unknown>;
}): ReactNode {
  /**
   * 營運端手動跑一輪。
   *
   * 為什麼放在 dashboard 而不是 portfolio 頁：這是**我們**的工作，不是使用者的。
   * 使用者的 UI 只保留 deposit / withdraw / close；觸發再平衡、換 session key 都在這裡。
   */
  const runRound = async (id: number): Promise<void> => {
    const toastId = toast.pending(`Rebalance #${id}`, 'Planning the round…');
    try {
      const result = await operatorForceRebalance(token, id);
      const ok = result.outcome === 'executed' || result.outcome === 'noop';
      toast.replace(toastId, {
        tone: ok ? 'ok' : 'bad',
        title: `#${id}: ${result.outcome}`,
        body: (result.txHash ?? result.reason ?? '').slice(0, 120),
      });
      await refetch();
    } catch (cause) {
      toast.replace(toastId, { tone: 'bad', title: `#${id}: request failed`, body: (cause as Error).message.slice(0, 120) });
    }
  };

  // 預設只顯示 active：這個環境裡有大量測試殘骸（paused / 從沒跑過），全部列出來會蓋掉真正要看的。
  const [showAll, setShowAll] = useState(false);
  const rows = (showAll ? overview.portfolios : overview.portfolios.filter((row) => row.scheduleState === 'active'))
    // 需要有人看的排前面：flags 多的先、其次 id。
    .slice()
    .sort((a, b) => rowFlags(b).length - rowFlags(a).length || a.id - b.id);

  return (
    <>
      <div className="card stack">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h2 style={{ margin: 0 }}>System</h2>
          <span className="muted" style={{ fontSize: 12 }}>
            snapshot at {new Date(overview.generatedAt).toLocaleTimeString('en-GB', { hour12: false })}
          </span>
        </div>
        <dl className="kv">
          <dt>scheduler</dt>
          <dd>
            {overview.scheduler === null ? (
              <span className="muted">never ran (no heartbeat row)</span>
            ) : (
              <>
                <Badge tone={overview.scheduler.alive ? 'ok' : 'bad'}>
                  {overview.scheduler.alive ? 'alive' : 'stale'}
                </Badge>
                <span className="muted" style={{ fontSize: 12 }}>
                  {' '}
                  · {overview.scheduler.dryRun ? 'dry-run' : 'LIVE'} · every {overview.scheduler.intervalSeconds}s ·
                  limit {overview.scheduler.roundLimit} · threshold {overview.scheduler.thresholdBps} bps · round{' '}
                  {overview.scheduler.rounds} · pid {overview.scheduler.pid ?? '—'}
                </span>
                {overview.scheduler.lastError === null ? null : (
                  <div className="neg" style={{ fontSize: 12 }}>
                    last error: {overview.scheduler.lastError.slice(0, 120)}
                  </div>
                )}
              </>
            )}
          </dd>
          <dt>last round</dt>
          <dd>
            {overview.scheduler?.lastSummary === undefined || Object.keys(overview.scheduler.lastSummary).length === 0 ? (
              <span className="muted">—</span>
            ) : (
              <>
                {Object.entries(overview.scheduler.lastSummary).map(([key, value]) => (
                  <span key={key} style={{ marginRight: 10 }}>
                    {key} <strong>{value}</strong>
                  </span>
                ))}
                <span className="muted" style={{ fontSize: 12 }}>
                  {overview.scheduler.staleSeconds === null
                    ? ''
                    : `· finished ${overview.scheduler.staleSeconds}s ago`}
                </span>
              </>
            )}
          </dd>
          <dt>scheduler heartbeat</dt>
          <dd>
            <strong>{ago(overview.lastCheckedAt)}</strong>
            <span className="muted"> / last time any portfolio was checked — if this is stale, the loop is not running</span>
          </dd>
          <dt>alerts</dt>
          <dd>
            {overview.alerts === null ? (
              <span className="neg">unknown (could not read)</span>
            ) : (
              <>
                <span className={overview.alerts.critical > 0 ? 'neg' : 'pos'}>{overview.alerts.critical} critical</span>
                <span className="muted"> · </span>
                <span className={overview.alerts.warn > 0 ? 'warn' : 'pos'}>{overview.alerts.warn} warn</span>
                <span className="muted"> · {overview.alerts.open} open</span>
              </>
            )}
          </dd>
          <dt>portfolios</dt>
          <dd>
            {overview.portfolios.filter((row) => row.scheduleState === 'active').length} active
            <span className="muted"> · {overview.portfolios.length} total (most are leftover test rows)</span>
          </dd>
        </dl>
      </div>

      <div className="card stack">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="muted" style={{ fontSize: 12, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            Portfolios ({rows.length} shown)
          </span>
          <label className="row" style={{ gap: 6, fontSize: 12, alignItems: 'center' }}>
            <input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} />
            include paused / idle
          </label>
        </div>
        <Table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Fund</th>
              <th className="num">Value</th>
              <th className="num">Drift</th>
              <th>Observed</th>
              <th className="num">Gas</th>
              <th className="num">Key</th>
              <th>Next run</th>
              <th>Last round</th>
              <th>Actions</th>
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const key = until(row.sessionKeyExpiresAt);
              const flags = rowFlags(row);
              return (
                <tr key={row.id}>
                  <td className="mono">
                    {row.id}
                  </td>
                  <td>
                    {row.strategyName ?? `strategy ${row.strategyId}`}
                    <span className="muted" style={{ fontSize: 11 }}>
                      {' '}
                      v{row.version} · {row.scheduleState}
                    </span>
                    {row.account === null ? null : (
                      <div className="mono muted" style={{ fontSize: 11 }}>
                        {shortAddress(row.account)}
                      </div>
                    )}
                    {/* 擁有人與 Kernel 帳戶是**兩個不同**的地址：帳戶是 (owner, strategy) 推導出來的
                        counterfactual 地址。只顯示帳戶時，兩個投組用了同一個策略、不同 owner 會看起來
                        一模一樣 —— 排查「這筆錢是誰的」就得多繞一圈。 */}
                    <div className="mono muted" style={{ fontSize: 11 }} title={row.wallet}>
                      owner {shortAddress(row.wallet)}
                    </div>
                  </td>
                  <td className="num">{row.totalUsdE8 === null ? '—' : formatUsdE8(row.totalUsdE8)}</td>
                  <td className={`num ${row.needsRebalance === true ? 'neg' : ''}`}>
                    {/* 空倉不顯示漂移數字：那是公式對「完全不在目標上」的結果，不是可處理的偏離。 */}
                    {row.isEmpty ? '—' : row.driftBps === null ? '—' : `${row.driftBps} bps`}
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {ago(row.observedAt)}
                  </td>
                  <td className="num mono" style={{ fontSize: 12 }}>
                    {row.gasWei === null ? '?' : `${Number(formatEther(BigInt(row.gasWei))).toFixed(4)}`}
                  </td>
                  <td className={`num ${key.tone}`} style={{ fontSize: 12 }}>
                    {key.text}
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {due(row.nextRunAt)}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {row.lastOperation === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <>
                        <Badge
                          tone={
                            row.lastOperation.state === 'confirmed'
                              ? 'ok'
                              : row.lastOperation.state === 'failed'
                                ? 'bad'
                                : 'warn'
                          }
                        >
                          {row.lastOperation.state}
                        </Badge>
                        <div className="muted" style={{ fontSize: 11 }}>
                          {ago(row.lastOperation.createdAt)}
                        </div>
                      </>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn ghost sm"
                      title="Run one rebalance round with the session key"
                      onClick={() => void runRound(row.id)}
                    >
                      Run round
                    </button>
                  </td>
                  <td>
                    {flags.length === 0 ? (
                      <span className="muted" style={{ fontSize: 12 }}>
                        ok
                      </span>
                    ) : (
                      flags.map((flag) => (
                        <Badge key={flag.label} tone={flag.tone}>
                          {flag.label}
                        </Badge>
                      ))
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </div>

      <div className="panel" style={{ marginTop: 20 }}>
        <div className="panel-h">
          <h2>Recent activity</h2>
        </div>
        <div className="panel-b">
          <ActivityTable token={token} />
        </div>
      </div>
    </>
  );
}

/**
 * Rebalance dashboard（operator 視角）。
 *
 * 刻意與 portfolio 頁不同：那一頁回答「我的基金怎麼樣」，這一頁回答
 * **「有哪一檔需要有人去看」** —— 所以每一列都帶 flags，而且 System 區塊第一眼就放
 * `scheduler heartbeat`（沉默與沒在跑在畫面上長得一樣，這是我們踩過的坑）。
 *
 * 資料來自 `/operator/overview`：讀已落地的快照與 operation，只有 gas 是即時讀。
 * 代價是「Observed」可能是幾分鐘前 —— 所以那一欄直接顯示相對時間，新鮮度自己看得到。
 */
export function OperatorPage(): ReactNode {
  useBodyClass('portfolio-page', 'fund-explore');
  // 守門只有一件事：有沒有**有效的後端 session**。
  //
  // 為什麼不能在前端硬編碼「creator 錢包」：
  // 後端 `/operator/*` 的授權是「authenticate 通過」（見 server.ts 的 operator 路由），
  // 註解明說「只要求登入，不依 owner 過濾：這是內部儀表板」。前端再綁一個公開榜單的
  // creator 地址（0x7b29…）等於另立一套跟後端無關、又與「營運端」語意不符的門檻 ——
  // 結果是任何錢包只要不是那個榜單地址，就被「Switch to the CRE8 creator wallet」擋住
  // （實測：使用者因此看不到原本能看的 Rebalance dashboard）。
  const token = useSession((state) => (sessionIsLive(state) ? state.token : null));

  if (token !== null) {
    return <CreatorOperatorPage token={token} />;
  }

  return (
    <main className="explore-wrap app-manage">
      <header className="explore-heading">
        <h1>Operations<span>.</span></h1>
      </header>
      {/* 這是 CRE8 內部的營運後台，不是 creator 的管理頁（creator 用 Studio）。 */}
      <section className="app-portfolio-summary app-portfolio-guest" aria-labelledby="ops-guest-title">
        <span className="app-icon-tile app-portfolio-hero-icon"><AppIcon name="manage" size={22} /></span>
        <h2 id="ops-guest-title">Operations console</h2>
        <p>This console is for the CRE8 operations team. Creators manage their funds in Studio.</p>
        <WalletMenu inline />
        <Link to="/studio">Go to Studio <AppIcon name="right" size={16} /></Link>
      </section>
    </main>
  );
}

function CreatorOperatorPage({ token }: { token: string }): ReactNode {
  const overview = useQuery({
    queryKey: ['operator-overview', token],
    queryFn: () => getOperatorOverview(token),
    refetchInterval: 15_000,
  });
  useEffect(() => {
    const session = useSession.getState();
    if (overview.error instanceof ApiError && overview.error.status === 401 && session.token === token) {
      session.clear();
    }
  }, [overview.error, token]);

  return (
    <main className="explore-wrap app-manage">
      <header className="explore-heading">
        <div>
          <h1>Operations<span>.</span></h1>
        </div>
        <div className="explore-heading-actions">
          <button type="button" className="btn" disabled={overview.isFetching} onClick={() => void overview.refetch()}>
            {overview.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {overview.isPending ? (
        <div className="card row">
          <Spinner /> <span className="muted">Loading overview…</span>
        </div>
      ) : overview.error !== null && overview.error !== undefined ? (
        <ErrorNote error={overview.error} />
      ) : overview.data === undefined ? null : (
        <Dashboard overview={overview.data} token={token} refetch={() => overview.refetch()} />
      )}
    </main>
  );
}
