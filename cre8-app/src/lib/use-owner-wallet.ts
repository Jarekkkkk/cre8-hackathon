import { useMemo } from 'react';
import { useWallet } from '../store/wallet';
import type { RenewalWallet } from './kernel';

/**
 * 把 store 裡的錢包狀態轉成 `RenewalWallet`（簽 sudo UserOp / 轉 BNB 用）。
 *
 * 兩個地方需要它：`CreateFundPage`（補 gas + approve）與 `StatusPage`（補 gas）。
 * `null` = 沒有可簽名的錢包 —— 呼叫端應該把按鈕停用，而不是假裝成功。
 */
export function useOwnerWallet(): RenewalWallet | null {
  const wallet = useWallet();
  return useMemo(() => {
    if (wallet.kind === 'injected' && wallet.provider !== null && wallet.address !== null) {
      return { kind: 'injected', address: wallet.address as `0x${string}`, provider: wallet.provider };
    }
    if (wallet.kind === 'dev' && wallet.devSigner !== null) {
      return { kind: 'dev', address: wallet.devSigner.address as `0x${string}`, account: wallet.devSigner.account };
    }
    return null;
  }, [wallet]);
}
