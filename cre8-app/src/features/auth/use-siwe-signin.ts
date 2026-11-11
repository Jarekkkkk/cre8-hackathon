import { useCallback, useState } from 'react';
import { createSiweMessage } from 'viem/siwe';
import type { Address } from 'viem';
import { postLogin, postNonce } from '../../lib/api';
import { signWithProvider } from '../../lib/wallet';
import { useSession } from '../../store/session';
import { useWallet } from '../../store/wallet';

/** SIWE 的進度狀態。UI 要能說出「現在卡在哪一步」，因為簽名是使用者要動手的環節。 */
export type SiwePhase = 'idle' | 'challenge' | 'signing' | 'exchanging';

const PHASE_LABEL: Record<Exclude<SiwePhase, 'idle'>, string> = {
  challenge: 'Fetching challenge…',
  signing: 'Waiting for your wallet…',
  exchanging: 'Exchanging for a session…',
};

export function siwePhaseLabel(phase: SiwePhase): string {
  return phase === 'idle' ? 'Sign in with SIWE' : PHASE_LABEL[phase];
}

/**
 * 一輪 SIWE 登入：`/auth/nonce` → 在錢包裡簽 EIP-4361 → `/auth/login` → 存 session。
 *
 * 從 `LoginPage` 抽出來的，因為登入入口從一整頁變成標頭的下拉選單 —— 而流程本身不該有兩份。
 */
export function useSiweSignIn(onDone?: () => void): {
  phase: SiwePhase;
  error: unknown;
  signIn: () => Promise<void>;
  reset: () => void;
} {
  const wallet = useWallet();
  const setSession = useSession((state) => state.setSession);
  const [phase, setPhase] = useState<SiwePhase>('idle');
  const [error, setError] = useState<unknown>(null);

  const reset = useCallback(() => {
    setPhase('idle');
    setError(null);
  }, []);

  const signIn = useCallback(async () => {
    if (wallet.address === null || phase !== 'idle') return;
    setError(null);
    try {
      setPhase('challenge');
      const challenge = await postNonce();

      const message = createSiweMessage({
        address: wallet.address as Address,
        chainId: challenge.chainId,
        domain: challenge.domain,
        nonce: challenge.nonce,
        uri: challenge.uri,
        statement: challenge.statement,
        version: '1',
        issuedAt: new Date(challenge.issuedAt),
        expirationTime: new Date(challenge.expiresAt),
      });

      setPhase('signing');
      const signature =
        wallet.kind === 'dev' && wallet.devSigner !== null
          ? await wallet.devSigner.signMessage(message)
          : wallet.provider === null
            ? (() => {
                throw new Error('Wallet connection was lost — reconnect.');
              })()
            : await signWithProvider(wallet.provider, wallet.address, message);

      setPhase('exchanging');
      const credentials = await postLogin(message, signature);
      if (useWallet.getState().address?.toLowerCase() !== wallet.address.toLowerCase()) {
        throw new Error('Wallet changed. Verify the connected wallet.');
      }
      setSession({ token: credentials.token, expiresAt: credentials.expiresAt, address: wallet.address });
      setPhase('idle');
      onDone?.();
    } catch (cause) {
      // 使用者在錢包裡按「取消」也是走這裡 —— 那是預期行為，不是 app 壞掉。
      setError(cause);
      setPhase('idle');
    }
  }, [onDone, phase, setSession, wallet]);

  return { phase, error, signIn, reset };
}
