import { create } from 'zustand';
import type { DevSigner, Eip1193Provider } from '../lib/wallet';

/**
 * 錢包連線狀態（client state）。
 *
 * ⚠ provider 物件**不能**進 store 的持久化內容（它不是 JSON）。這裡只放可序列化的欄位，
 * 真正的 provider 留在 `lib/wallet.ts` 的模組層。
 */
export type WalletState = {
  address: string | null;
  kind: 'injected' | 'dev' | null;
  rdns: string | null;
  provider: Eip1193Provider | null;
  devSigner: DevSigner | null;
  connectInjected: (input: { address: string; rdns: string; provider: Eip1193Provider }) => void;
  connectDev: (signer: DevSigner) => void;
  disconnect: () => void;
};

export const useWallet = create<WalletState>()((set) => ({
  address: null,
  kind: null,
  rdns: null,
  provider: null,
  devSigner: null,
  connectInjected: ({ address, rdns, provider }) =>
    set({ address, kind: 'injected', rdns, provider, devSigner: null }),
  connectDev: (signer) => set({ address: signer.address, kind: 'dev', rdns: null, provider: null, devSigner: signer }),
  disconnect: () => set({ address: null, kind: null, rdns: null, provider: null, devSigner: null }),
}));
