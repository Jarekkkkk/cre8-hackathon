import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError } from '../lib/api';
import {
  chainIdOf,
  connectProvider,
  createDevSigner,
  discoverProviders,
  isLikelyPrivateKey,
} from '../lib/wallet';
import type { ProviderDetail } from '../lib/wallet';
import { shortAddress } from '../lib/format';
import { useWallet } from '../store/wallet';
import { Badge, ErrorNote, Field, Note, Spinner } from './ui';

/** 本機 anvil 的 #3（sudo owner）。只在 DEV build 出現，且不寫入任何持久化儲存。 */
const DEV_KEY_HINT = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';

/**
 * 連線錢包（EIP-6963）或 dev 私鑰。
 *
 * 抽成元件是因為它有**兩個使用情境**：登入時的第 1 步，以及「已登入但重新整理後錢包掉了」的重連。
 * 後者原本是一句死路訊息（只有登出能救），而續期一定要 owner 簽名 —— 沒有重連入口等於功能壞掉。
 *
 * ⚠ 錢包連線**不跨重新整理**是刻意的：provider 物件不是 JSON，而把私鑰或 provider 塞進
 * sessionStorage 是把鑰匙寫進瀏覽器儲存。重連一次的成本遠低於那個風險。
 */
export function WalletConnect({ note }: { note?: ReactNode }): ReactNode {
  const wallet = useWallet();
  const [providers, setProviders] = useState<ProviderDetail[]>([]);
  const [discovering, setDiscovering] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [devKey, setDevKey] = useState('');

  const refresh = useCallback(() => {
    setDiscovering(true);
    void discoverProviders().then((found) => {
      setProviders(found);
      setDiscovering(false);
    });
  }, []);

  useEffect(() => {
    let alive = true;
    void discoverProviders().then((found) => {
      if (!alive) return;
      setProviders(found);
      setDiscovering(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  const connectInjected = useCallback(async (detail: ProviderDetail) => {
    setError(null);
    try {
      setBusy(`Connecting ${detail.info.name}…`);
      const address = await connectProvider(detail.provider);
      const chainId = await chainIdOf(detail.provider).catch(() => null);
      useWallet.getState().connectInjected({ address, rdns: detail.info.rdns, provider: detail.provider });
      if (chainId !== null && chainId !== 56) {
        setError(
          new ApiError(
            0,
            'WRONG_CHAIN',
            `Wallet is on chain ${chainId}; this backend serves BSC 56. The connection itself is fine — just be aware which chain you are on.`,
          ),
        );
      }
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  }, []);

  const connectDev = useCallback(() => {
    setError(null);
    if (!isLikelyPrivateKey(devKey)) {
      setError(new ApiError(0, 'BAD_DEV_KEY', 'Bad private key: expected 0x followed by 64 hex characters'));
      return;
    }
    useWallet.getState().connectDev(createDevSigner(devKey.trim() as `0x${string}`));
  }, [devKey]);

  return (
    <div className="stack">
      {note === undefined ? null : note}

      {wallet.address === null ? null : (
        <div className="row">
          <span className="muted">Connected</span>
          <span className="mono" title={wallet.address}>
            {shortAddress(wallet.address)}
          </span>
          <Badge tone={wallet.kind === 'dev' ? 'warn' : 'ok'}>
            {wallet.kind === 'dev' ? 'dev key' : (wallet.rdns ?? 'injected')}
          </Badge>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => wallet.disconnect()}>
            Disconnect
          </button>
        </div>
      )}

      {wallet.address === null ? (
        <>
          <div className="spread">
            <span className="muted" style={{ fontSize: 13 }}>
              Detected wallets
            </span>
            <button type="button" className="btn btn--ghost btn--sm" onClick={refresh} disabled={busy !== null}>
              Rescan
            </button>
          </div>

          {discovering ? (
            <div className="row">
              <Spinner /> <span className="muted">Detecting EIP-6963 wallets…</span>
            </div>
          ) : providers.length === 0 ? (
            <Note tone="warn">
              No wallet detected. EIP-6963 requires the extension to announce itself; if one is installed but missing, reload this page.
            </Note>
          ) : (
            <div className="row">
              {providers.map((detail) => (
                <button
                  key={detail.info.uuid}
                  type="button"
                  className="btn"
                  disabled={busy !== null}
                  onClick={() => void connectInjected(detail)}
                >
                  {detail.info.name}
                  <span className="muted mono" style={{ fontSize: 11 }}>
                    {detail.info.rdns}
                  </span>
                </button>
              ))}
            </div>
          )}

          {import.meta.env.DEV ? (
            <details>
              <summary className="muted" style={{ cursor: 'pointer', fontSize: 13 }}>
                Connect with a dev private key (dev build only)
              </summary>
              <div className="stack" style={{ marginTop: 12 }}>
                <Field label="Private key" hint={`Local anvil #3: ${DEV_KEY_HINT.slice(0, 10)}…`}>
                  <input
                    type="password"
                    value={devKey}
                    placeholder="0x…"
                    onChange={(event) => setDevKey(event.target.value)}
                  />
                </Field>
                <div className="row">
                  <button type="button" className="btn" disabled={busy !== null} onClick={connectDev}>
                    Connect with key
                  </button>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDevKey(DEV_KEY_HINT)}>
                    Fill anvil #3
                  </button>
                </div>
              </div>
            </details>
          ) : null}
        </>
      ) : null}

      <ErrorNote error={error} />
    </div>
  );
}
