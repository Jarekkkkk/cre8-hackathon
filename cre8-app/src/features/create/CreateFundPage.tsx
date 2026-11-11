import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, createStrategy, enrollPortfolio, getAssets, getPortfolioStatus, publishVersion } from '../../lib/api';
import { approveCalldata, sendGasTopUp, sendSudoCalls } from '../../lib/kernel';
import type { RenewalWallet } from '../../lib/kernel';
import { useWallet } from '../../store/wallet';
import type { PriceableAsset } from '../../lib/api';
import { queryKeys } from '../../lib/query';
import { useBodyClass } from '../../lib/use-body-class';
import {savedActivationDesign} from '../../lib/activation-design';
import { useSession } from '../../store/session';
import { SignInButton } from '../../components/WalletMenu';
import { ErrorNote, Note, Spinner } from '../../components/ui';

/** Rebalance cadence. The backend requires `intervalSeconds >= 60`; one hour is the shortest sensible cadence. */
const INTERVALS = [
  { label: 'Hourly', seconds: 3600 },
  { label: 'Every 6h', seconds: 21_600 },
  { label: 'Daily', seconds: 86_400 },
] as const;

type Step =
  | 'idle'
  | 'creating-strategy'
  | 'publishing-version'
  | 'enrolling'
  | 'topping-up-gas'
  | 'approving'
  | 'done';

const STEP_LABEL: Record<Exclude<Step, 'idle' | 'done'>, string> = {
  'creating-strategy': 'Creating the strategy (mirrors to the on-chain registry)…',
  'publishing-version': 'Publishing the version (weights + schedule)…',
  enrolling: 'Deploying the smart account (enroll)…',
  'topping-up-gas': 'Sending gas to the new account…',
  approving: 'Signing the approval (one wallet signature)…',
};

/**
 * Create fund — **one strategy only: a target-weight index fund**.
 *
 * The design mock offers Buy & hold, Stack and Pair grid templates. Our backend has no execution path for
 * them, so this page does not pretend otherwise: it turns "assets + weights + cadence" into
 * `strategy` → `version` → `portfolio`, three real resources.
 *
 * Steps 1 and 3 send on-chain transactions, so progress is shown step by step — a spinner that says
 * nothing for 30 seconds makes people press the button again.
 */
export function ActivateFundPage(): ReactNode {
  // The design's create page carries its own body class (`.create-page { background: var(--panel) }`).
  useBodyClass('create-page');
  const token = useSession((state) => state.token);
  const walletState = useWallet();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const renewalWallet: RenewalWallet | null =
    walletState.kind === 'injected' && walletState.provider !== null && walletState.address !== null
      ? { kind: 'injected', address: walletState.address as `0x${string}`, provider: walletState.provider }
      : walletState.kind === 'dev' && walletState.devSigner !== null
        ? { kind: 'dev', address: walletState.devSigner.address as `0x${string}`, account: walletState.devSigner.account }
        : null;

  const [draft] = useState(savedActivationDesign);
  const [allocationAgreed,setAllocationAgreed]=useState(false);
  const [name, setName] = useState(draft?.name||'');
  const [description, setDescription] = useState('');
  const [weights, setWeights] = useState<Record<string, number>>(draft?.weights||{});
  const [intervalSeconds, setIntervalSeconds] = useState<number>(3600);
  const [step, setStep] = useState<Step>('idle');
  /**
   * 同步的「已有請求在飛」旗標。
   *
   * `step` 是 React state，要等到下一次 render 才會反映；**連點兩下會在兩次 render 之間送出兩個請求** ——
   * 實際發生過：13 秒內建立了兩個一模一樣的策略與帳戶（#1599、#1600），各鏡像到鏈上、各部署一個
   * smart account。`useRef` 的值是同步寫入的，所以第二下點擊進不來。
   */
  const inFlight = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<{ strategyId: number; portfolioId: number } | null>(null);
  const [approval, setApproval] = useState<{ tx: string | null; error: unknown } | null>(null);

  const assets = useQuery({
    queryKey: ['assets', token],
    queryFn: () => getAssets(token as string),
    enabled: token !== null,
    staleTime: 60_000,
  });

  const selected = useMemo(() => Object.entries(weights).filter(([, percent]) => percent > 0), [weights]);
  /** Accumulate in bps, not floating percentages: `33.3 + 33.3 + 33.4` is not 100 in binary floating point. */
  const totalBps = selected.reduce((sum, [, percent]) => sum + Math.round(percent * 100), 0);
  const unavailableAssets=selected.filter(([address])=>!assets.data?.some(asset=>asset.address.toLowerCase()===address.toLowerCase()&&asset.tradable!==false));
  const valid = name.trim().length > 0 && totalBps === 10_000 && unavailableAssets.length===0 && (draft===null||allocationAgreed);
  const busy = step !== 'idle' && step !== 'done';

  const toggle = (asset: PriceableAsset): void => {
    setWeights((current) => {
      const next = { ...current };
      if (next[asset.address.toLowerCase()] === undefined) next[asset.address.toLowerCase()] = 0;
      else delete next[asset.address.toLowerCase()];
      return next;
    });
  };

  const submit = async (): Promise<void> => {
    if (token === null || !valid) return;
    // 同步守衛：連點的第二下會在這裡被擋掉（state 還沒 re-render，按鈕也還沒 disabled）。
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setCreated(null);
    try {
      setStep('creating-strategy');
      const strategy = await createStrategy(token, {
        name: name.trim(),
        ...(description.trim() === '' ? {} : { description: description.trim() }),
      });

      setStep('publishing-version');
      await publishVersion(token, strategy.id, {
        allocation: {
          assets: selected.map(([address, percent]) => ({
            address,
            weightBps: Math.round(percent * 100),
          })),
        },
        schedule: { kind: 'interval', intervalSeconds },
        changeLog: 'created from the app',
      });

      setStep('enrolling');
      const portfolio = await enrollPortfolio(token, strategy.id);

      /**
       * 建立完就**順手把 approve 做完**，這樣「決定好資產與策略」之後只需要一次錢包簽名，
       * 而不是事後還要記得去按一次 Approve。
       *
       * 兩件事依序發生，而且都會出現在進度上：
       *   1. 帳戶沒有 BNB 時先轉 gas（approve 那筆 op 由帳戶自己付 gas）
       *   2. owner 簽一筆 sudo UserOp，對每個策略資產 approve 給 executor
       *
       * 失敗不讓建立失敗 —— 投組已經上鏈了。錯誤會留在畫面上，Allowance 卡片可以重試。
       */
      let approval: { tx: string | null; error: unknown } = { tx: null, error: null };
      if (renewalWallet !== null) {
        try {
          const status = await getPortfolioStatus(token, portfolio.id);
          const executor = status.executorAddress;
          if (executor !== null) {
            const shortfall = BigInt(portfolio.gas?.shortfallWei ?? '0');
            if (shortfall > 0n) {
              setStep('topping-up-gas');
              await sendGasTopUp({ wallet: renewalWallet, to: status.account as `0x${string}`, valueWei: shortfall });
            }
            setStep('approving');
            const receipt = await sendSudoCalls({
              wallet: renewalWallet,
              token,
              accountAddress: status.account as `0x${string}`,
              strategyId: strategy.id,
              calls: status.targets.map((target) => ({
                to: target.asset as `0x${string}`,
                data: approveCalldata(executor as `0x${string}`),
                value: 0n,
              })),
            });
            approval = { tx: receipt.txHash, error: null };
          }
        } catch (cause) {
          approval = { tx: null, error: cause };
        }
      }
      setApproval(approval);

      setCreated({ strategyId: strategy.id, portfolioId: portfolio.id });
      setStep('done');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.portfolios(token) }),
        queryClient.invalidateQueries({ queryKey: ['assets', token] }),
      ]);
    } catch (cause) {
      setError(cause);
      setStep('idle');
    } finally {
      inFlight.current = false;
    }
  };

  if (token === null) {
    return (
      <main className="page stack">
        <h1>Activate an allocation</h1>
        <Note tone="warn">
          Activation creates a target-weight strategy and a smart account under your wallet.{' '}
          <SignInButton /> first.
        </Note>
      </main>
    );
  }

  return (
    <main className="page stack">
      <div>
        <h1>Activate an allocation</h1>
        <p className="lead">
          Choose holdings and target weights. The fund trades through USDT to restore those weights.
        </p>
      </div>

      {draft&&<section className="card stack"><h2>Allocation from your design</h2><p>Activate these holdings as a target-weight strategy. Choose the rebalance interval below. Other design rules and fee settings remain in your exported design.</p><label className="row"><input type="checkbox" checked={allocationAgreed} onChange={event=>setAllocationAgreed(event.target.checked)}/>I want to activate this allocation as a target-weight strategy.</label>{assets.data&&unavailableAssets.length>0&&<div><p>These assets are unavailable for activation:</p>{unavailableAssets.map(([address])=><p key={address}>{draft.symbols[address]||address} <button type="button" className="btn ghost sm" onClick={()=>setWeights(current=>{const next={...current};delete next[address];return next;})}>Remove</button></p>)}<p>Review the remaining weights before continuing.</p></div>}<Link to="/create/design">← Back to fund design</Link></section>}

      <section className="card stack">
        <h2>1 · Name</h2>
        <label className="field">
          <span>Fund name</span>
          <input
            id="fund-name"
            value={name}
            maxLength={120}
            placeholder="e.g. BNB Ecosystem Balanced"
            onChange={(event) => setName(event.target.value)}
          />
          <small>Shown on the vaults list.</small>
        </label>
        <label className="field">
          <span>Description (optional)</span>
          <input
            id="fund-desc"
            value={description}
            maxLength={500}
            placeholder="The thesis, in one line"
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
      </section>

      <section className="card stack">
        <div className="spread">
          <h2>2 · Holdings and weights</h2>
          <span className={totalBps === 10_000 ? 'pos mono' : 'neg mono'} style={{ fontSize: 13 }}>
            Total {(totalBps / 100).toFixed(2)}%
          </span>
        </div>

        {assets.isPending ? (
          <div className="row">
            <Spinner /> <span className="muted">Loading priceable assets…</span>
          </div>
        ) : assets.error !== null && assets.error !== undefined ? (
          <ErrorNote error={assets.error} />
        ) : assets.data === undefined ? null : assets.data.length === 0 ? (
          <Note tone="warn">`priceable_assets` is empty — someone has to add tokens before a fund can be created.</Note>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Pick</th>
                <th>Ticker</th>
                <th>Tradable</th>
                <th>Address</th>
                <th className="num">Weight %</th>
              </tr>
            </thead>
            <tbody>
              {assets.data.map((asset) => {
                const isOn = weights[asset.address.toLowerCase()] !== undefined;
                // `tradable === false` = router 沒有這個資產的 oracle：選了會建出一個永遠執行不了的策略
                // （第一次再平衡才以 OracleNotSet 失敗）。null = 查不到，允許但標示未知。
                const blocked = asset.tradable === false;
                return (
                  <tr key={asset.address}>
                    <td>
                      <input
                        type="checkbox"
                        checked={isOn}
                        disabled={blocked}
                        aria-label={`Select ${asset.symbol}`}
                        onChange={() => toggle(asset)}
                      />
                    </td>
                    <td>
                      <span className="mono">{asset.symbol}</span>
                      {asset.isNumeraire ? (
                        <span className="muted" style={{ fontSize: 11 }}>
                          {' '}
                          numeraire
                        </span>
                      ) : null}
                    </td>
                    <td>
                      {asset.tradable === true ? (
                        <span className="pos" style={{ fontSize: 12 }}>
                          yes
                        </span>
                      ) : asset.tradable === false ? (
                        <span className="neg" style={{ fontSize: 12 }} title="the router has no oracle for this asset: swaps would revert OracleNotSet">
                          no oracle
                        </span>
                      ) : (
                        <span className="muted" style={{ fontSize: 12 }}>
                          unknown
                        </span>
                      )}
                    </td>
                    <td className="mono muted" style={{ fontSize: 12 }}>
                      {asset.address.slice(0, 10)}…{asset.address.slice(-6)}
                    </td>
                    <td className="num">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={0.01}
                        disabled={!isOn}
                        value={weights[asset.address.toLowerCase()] ?? 0}
                        style={{ width: 96, textAlign: 'right' }}
                        onChange={(event) => {
                          const percent = Number(event.target.value);
                          setWeights((current) => ({
                            ...current,
                            [asset.address.toLowerCase()]: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0,
                          }));
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {assets.data !== undefined && assets.data.some((asset) => asset.tradable === false) ? (
          <Note tone="warn">
            Assets marked <strong>no oracle</strong> cannot be bought or sold yet: the executor&apos;s oracle router has no
            per-pair oracle for them, so a swap would revert <code>OracleNotSet</code>. They are disabled here rather than
            letting you build a fund that can never execute.
          </Note>
        ) : null}

        {totalBps !== 10_000 && selected.length > 0 ? (
          <Note tone="warn">
            Weights must add up to exactly 100% (the backend requires 10000 bps). Currently {totalBps} bps.
          </Note>
        ) : null}
      </section>

      <section className="card stack">
        <h2>3 · Rebalance cadence</h2>
        <div className="row">
          {INTERVALS.map((option) => (
            <button
              key={option.seconds}
              type="button"
              className={`btn btn--sm${intervalSeconds === option.seconds ? '' : ' btn--ghost'}`}
              onClick={() => setIntervalSeconds(option.seconds)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          The scheduler checks drift on this cadence; it only trades past the threshold, and every step is bounded by
          the impact budget.
        </p>
      </section>

      <section className="card stack">
        <h2>4 · Create</h2>
        <dl className="kv">
          <dt>Strategy name</dt>
          <dd>{name.trim() === '' ? '(empty)' : name.trim()}</dd>
          <dt>Holdings</dt>
          <dd>
            {selected.length === 0
              ? '(none selected)'
              : selected
                  .map(([address]) => assets.data?.find((asset) => asset.address.toLowerCase() === address.toLowerCase())?.symbol ?? address)
                  .join(' · ')}
          </dd>
          <dt>Cadence</dt>
          <dd>{INTERVALS.find((option) => option.seconds === intervalSeconds)?.label ?? `${intervalSeconds}s`}</dd>
        </dl>

        {step !== 'idle' && step !== 'done' ? (
          <Note>
            <div className="row">
              <Spinner /> <strong>{STEP_LABEL[step]}</strong>
            </div>
            <p className="muted" style={{ margin: '8px 0 0', fontSize: 13 }}>
              Step 1 mirrors the strategy to the on-chain registry and step 3 deploys the smart account — both cost gas
              and take time. This is not stuck.
            </p>
          </Note>
        ) : null}

        <div className="row">
          <button type="button" className="btn btn--primary" disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create fund'}
          </button>
          {valid ? null : <span className="muted" style={{ fontSize: 12 }}>Needs a name and exactly 100% in weights</span>}
        </div>

        <ErrorNote error={error} />
        {error instanceof ApiError && error.code === 'CHAIN_NOT_CONFIGURED' ? (
          <Note tone="warn">
            The backend has no chain configured (`RPC_URL` / `OPERATOR_PRIVATE_KEY`). Creating a strategy mirrors it to
            the on-chain registry, so it fails here without that.
          </Note>
        ) : null}

        {created === null ? null : (
          <Note>
            <strong>Created</strong>
            <div style={{ marginTop: 6 }}>
              Strategy #{created.strategyId} · portfolio #{created.portfolioId}
            </div>
            {approval === null ? null : approval.error !== null ? (
              <div style={{ marginTop: 8 }}>
                <Note tone="warn">
                  Fund created, but the approval did not go through. The account cannot rebalance until it is
                  approved — open the portfolio and use the Allowance section to retry.
                </Note>
                <ErrorNote error={approval.error} />
              </div>
            ) : (
              <div style={{ marginTop: 8, fontSize: 13 }}>
                Assets approved for the executor{' '}
                <span className="mono">({approval.tx?.slice(0, 12)}…)</span>
              </div>
            )}
            <div className="row" style={{ marginTop: 10 }}>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => navigate('/studio/funds')}
              >
                See it in My funds
              </button>
              <Link className="btn btn--sm btn--ghost" to="/portfolios">
                Open the portfolio
              </Link>
            </div>
          </Note>
        )}
      </section>
    </main>
  );
}
