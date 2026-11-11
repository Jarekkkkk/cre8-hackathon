import { useEffect } from 'react';

import { discoverProviders } from './wallet';
import { restoreWalletConnect, WALLETCONNECT_RDNS } from './wallet-connect';
import { useSession } from '../store/session';
import { useWallet } from '../store/wallet';

/**
 * 重新整理後自動接回錢包。
 *
 * ## 為什麼可以「不彈窗」
 * `eth_requestAccounts` 會彈授權視窗，但 `eth_accounts` **不會** —— 它只回「這個網站先前
 * 已被授權的帳號」。所以自動接回不是「偷偷連線」，而是「使用者早就授權過，我們把狀態接回來」。
 *
 * ## 為什麼要比對位址
 * 使用者可能在 MetaMask 裡切到別的帳號。那時 `eth_accounts` 回的是新帳號 —— 如果我們照單全收，
 * 畫面上的「我的投組」會在他不知情的情況下換人。所以位址不同就**不自動接**，讓他手動選。
 *
 * 存的是 `{ rdns, address }`（可序列化），provider 物件永遠不進 storage。
 */

const STORAGE_KEY = 'cre8.lastWallet';

type Saved = { rdns: string; address: string };

function readSaved(): Saved | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<Saved>;
    if (typeof parsed.rdns !== 'string' || typeof parsed.address !== 'string') return null;
    return { rdns: parsed.rdns, address: parsed.address };
  } catch {
    return null;
  }
}

/** 連上 / 斷線時同步 storage；由 `useAutoConnect` 掛一次。 */
function persist(): () => void {
  return useWallet.subscribe((state) => {
    try {
      if (state.address === null || state.kind !== 'injected' || state.rdns === null) {
        window.localStorage.removeItem(STORAGE_KEY);
        return;
      }
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ rdns: state.rdns, address: state.address }));
    } catch {
      // storage 被擋（無痕模式）時就只是不能自動接回，不該讓整個 app 壞掉。
    }
  });
}

export function useAutoConnect(): void {
  useEffect(() => {
    const unsubscribe = persist();
    if (useWallet.getState().address !== null) return unsubscribe;

    const saved = readSaved();
    if (saved === null) return unsubscribe;

    let cancelled = false;
    void (async () => {
      let connection;
      try {
        if (saved.rdns === WALLETCONNECT_RDNS) {
          connection = await restoreWalletConnect();
        } else {
          const providers = await discoverProviders(400);
          if (cancelled) return;
          const match = providers.find((entry) => entry.info.rdns === saved.rdns) ?? providers[0];
          if (!match) return;

          // eth_accounts only reads previously approved accounts.
          const accounts = await match.provider.request({ method: 'eth_accounts' });
          const first = Array.isArray(accounts) ? accounts[0] : undefined;
          if (typeof first !== 'string') return;
          connection = { address: first, rdns: match.info.rdns, provider: match.provider };
        }
      } catch {
        return;
      }
      if (cancelled || !connection || useWallet.getState().address !== null) return;
      const { address } = connection;
      if (address.toLowerCase() !== saved.address.toLowerCase()) return;

      useWallet.getState().connectInjected(connection);
      // 接回的錢包若與 session token 綁定的不同，token 就失效了 —— 清掉，讓 UI 提示重新登入。
      // （session.address 存的是「簽 SIWE 那一刻」的錢包；不該拿 A 的 token 去查 B 的投組。）
      const session = useSession.getState();
      if (session.address !== null && session.address.toLowerCase() !== address.toLowerCase()) {
        session.clear();
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
}
