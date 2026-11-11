import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { connectProvider, discoverProviders, ensureChain } from '../lib/wallet';
import { CHAIN_ID } from '../lib/kernel';
import type { ProviderDetail } from '../lib/wallet';
import { shortAddress } from '../lib/format';
import { useConnectedSessionToken } from '../lib/use-connected-session';
import { useSession } from '../store/session';
import { useWallet } from '../store/wallet';
import { siwePhaseLabel, useSiweSignIn } from '../features/auth/use-siwe-signin';
import { useWalletDiagnostics } from '../lib/use-wallet-diagnostics';
import { useMobile } from '../lib/use-mobile';
import { pairWalletConnect, rememberWalletConnectApp, WALLETCONNECT_RDNS, walletConnectAvailable } from '../lib/wallet-connect';
import { ErrorNote } from './ui';
import { AppIcon } from './AppIcon';
import { WalletConnectPairing } from './WalletConnectPairing';

/** 任何地方都可以叫出錢包選單。 */
export const OPEN_WALLET_MENU = 'cre8:open-wallet-menu';

export function openWalletMenu(): void {
  window.dispatchEvent(new Event(OPEN_WALLET_MENU));
}

/** 標頭與頁面內共用錢包選擇及驗證流程。 */
export function WalletMenu({ inline = false, showIcon = false, iconOnly = false }: { inline?: boolean; showIcon?: boolean; iconOnly?: boolean }): ReactNode {
  const wallet = useWallet();
  const mobile = useMobile();
  const token = useConnectedSessionToken();
  const clearSession = useSession((state) => state.clear);

  const [open, setOpen] = useState(false);
  const [showBrowserWallets, setShowBrowserWallets] = useState(false);
  const [pairingUri, setPairingUri] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderDetail[] | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<unknown>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const siwe = useSiweSignIn(() => setOpen(false));
  // 錢包讀的是它自己的 RPC，所以「餘額不足」常常是連錯網路（chain 56 有兩個：主網與我們的 fork）。
  const diagnostics = useWalletDiagnostics(open ? wallet.address : null, wallet.provider);

  const refreshProviders = useCallback(async () => {
    try {
      setProviders(await discoverProviders());
    } catch (cause) {
      setConnectError(cause);
    }
  }, []);

  function toggleBrowserWallets() {
    const show = !showBrowserWallets;
    setShowBrowserWallets(show);
    if (show) void refreshProviders();
  }

  // 外面點一下、按 Esc 都要關掉（下拉選單的基本期待）。
  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 深連結：`/#wallet` 直接打開選單。支援文件可以指向這個錨點，截圖/驗證也不必先模擬點擊。
  useEffect(() => {
    if (!inline && window.location.hash === '#wallet') setOpen(true);
  }, [inline]);

  // 別的頁面也能叫出這個選單。
  useEffect(() => {
    if (inline) return;
    const onOpen = (): void => setOpen(true);
    window.addEventListener(OPEN_WALLET_MENU, onOpen);
    return () => window.removeEventListener(OPEN_WALLET_MENU, onOpen);
  }, [inline]);

  const connect = useCallback(
    async (detail: ProviderDetail) => {
      setConnecting(detail.info.rdns);
      setConnectError(null);
      try {
        const address = await connectProvider(detail.provider);

        // 連上之後**主動把錢包切到我們的鏈**。
        //
        // 不做這件事的實際後果：使用者上次測試時加了「CRE8 Local (1337)」網路，
        // 之後打開主網網站，畫面像「連到測試網」，每個讀取都失敗，而訊息完全看不出原因。
        // 切不動（使用者按取消）就照常連上，由 wallet-warning 告訴他鏈不對。
        try {
          await ensureChain(detail.provider, CHAIN_ID, {
            chainName: 'BNB Smart Chain',
            rpcUrls: [import.meta.env.VITE_RPC_URL ?? 'https://bsc-dataseed.binance.org'],
            nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
            blockExplorerUrls: ['https://bscscan.com'],
          });
        } catch {
          // 切鏈失敗不該擋住連線。
        }

        wallet.connectInjected({ address, rdns: detail.info.rdns, provider: detail.provider });
      } catch (cause) {
        setConnectError(cause);
      } finally {
        setConnecting(null);
      }
    },
    [wallet],
  );

  async function connectWithWalletConnect() {
    setConnecting(WALLETCONNECT_RDNS);
    setConnectError(null);
    try {
      const connection = await pairWalletConnect(setPairingUri);
      const current = useWallet.getState();
      if (current.address === null) {
        current.connectInjected(connection);
      } else if (current.provider !== connection.provider) {
        await connection.provider.disconnect?.();
      }
    } catch (cause) {
      setConnectError(cause);
    } finally {
      setConnecting(null);
      setPairingUri(null);
    }
  }

  function disconnectWallet() {
    const { provider, rdns } = useWallet.getState();
    clearSession();
    wallet.disconnect();
    if (rdns === WALLETCONNECT_RDNS) {
      rememberWalletConnectApp(null);
      void provider?.disconnect?.().catch(setConnectError);
    }
  }

  let label = 'Connect wallet';
  if (wallet.address !== null) {
    label = token !== null ? shortAddress(wallet.address) : inline ? 'Verify wallet' : 'Sign in';
  }

  return (
    <div className={inline ? "wallet-menu wallet-menu--inline" : "wallet-menu"} ref={rootRef}>
      <button
        type="button"
        className={inline ? "btn primary block" : `btn sm header-wallet${iconOnly ? " app-wallet-toolbar" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={iconOnly ? label : undefined}
        data-wallet-state={wallet.address === null ? 'disconnected' : token === null ? 'unverified' : 'verified'}
        onClick={() => setOpen((current) => !current)}
      >
        {(showIcon || iconOnly) && <AppIcon name="wallet" size={iconOnly ? 23 : 19} />}
        {!iconOnly && label}
      </button>

      {open ? (
        <div className="wallet-menu__panel" role="menu">
          {wallet.address !== null && diagnostics.problem !== null ? (
        <p className="wallet-warning" role="alert" style={{ margin: '0 0 10px', fontSize: 12, lineHeight: 1.5 }}>
          {diagnostics.problem}
        </p>
      ) : null}

      {wallet.address === null ? (
            <>
              <p className="wallet-menu__title">Connect a wallet</p>
              {connecting === WALLETCONNECT_RDNS ? (
                pairingUri ? <WalletConnectPairing uri={pairingUri} mobile={mobile} /> :
                  <p className="wallet-menu__hint" role="status">Preparing WalletConnect…</p>
              ) : (
                <>
                  {walletConnectAvailable && (
                    <button type="button" className="wallet-menu__item wallet-menu__walletconnect" role="menuitem"
                      disabled={connecting !== null} onClick={() => void connectWithWalletConnect()}>
                      <AppIcon name="wallet" size={19} />
                      <span>WalletConnect</span>
                      <AppIcon name="right" size={16} />
                    </button>
                  )}
                  <button type="button" className="wallet-menu__item" role="menuitem"
                    aria-expanded={showBrowserWallets} onClick={toggleBrowserWallets}>
                    Browser wallets
                  </button>
                  {showBrowserWallets && (providers === null ? (
                    <p className="wallet-menu__hint" role="status">Looking for browser wallets…</p>
                  ) : providers.length === 0 ? (
                    <p className="wallet-menu__hint">No browser wallets available.</p>
                  ) : providers.map((detail) => (
                    <button key={detail.info.rdns} type="button" className="wallet-menu__item" role="menuitem"
                      disabled={connecting !== null} onClick={() => void connect(detail)}>
                      {detail.info.icon && <img src={detail.info.icon} alt="" />}
                      <span>{detail.info.name}</span>
                      {connecting === detail.info.rdns && <span className="wallet-menu__hint">Connecting…</span>}
                    </button>
                  )))}
                </>
              )}
              <ErrorNote error={connectError} />
            </>
          ) : token === null ? (
            <>
              {!inline && <p className="wallet-menu__title">Sign in with SIWE</p>}
              <p className="wallet-menu__hint">
                {inline ? 'Sign a message to verify your wallet.' : 'Sign a message to verify ownership of the connected wallet.'}
              </p>
              <p className="wallet-menu__addr mono">{shortAddress(wallet.address)}</p>
              <button
                type="button"
                className="btn sm"
                disabled={siwe.phase !== 'idle'}
                onClick={() => void siwe.signIn()}
              >
                {inline && siwe.phase === "idle" ? "Sign message" : siwePhaseLabel(siwe.phase)}
              </button>
              <ErrorNote error={siwe.error} />
              <button type="button" className="wallet-menu__link" onClick={disconnectWallet}>
                Disconnect
              </button>
            </>
          ) : (
            <>
              <p className="wallet-menu__addr mono">{shortAddress(wallet.address)}</p>
              <p className="wallet-menu__status">Signed in</p>
              <Link className="wallet-menu__item" to="/portfolios" onClick={() => setOpen(false)}>
                Portfolio
              </Link>
              <button
                type="button"
                className="wallet-menu__link"
                onClick={() => {
                  clearSession();
                  setOpen(false);
                }}
              >
                Sign out
              </button>
              {wallet.rdns === WALLETCONNECT_RDNS && (
                <button type="button" className="wallet-menu__link" onClick={disconnectWallet}>Disconnect wallet</button>
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** 頁面上的「Sign in」——不是連到某一頁，而是叫出標頭那個選單（單一入口）。 */
export function SignInButton({ children }: { children?: ReactNode }): ReactNode {
  return (
    <button type="button" className="link-button" onClick={() => openWalletMenu()}>
      {children ?? 'Sign in'}
    </button>
  );
}
